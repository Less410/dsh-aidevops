import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./env.js";
import { errorCode, errorDetail, recordError } from "./errors.js";
import { startHealthMonitor } from "./monitor.js";
import { registerRoutes } from "./routes.js";
import { startBackupScheduler } from "./scheduler.js";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 2 * 1024 * 1024,
});

process.on("uncaughtException", (error) => {
  app.log.error({ err: error }, "uncaught exception");
});
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandled rejection");
});

const weakAdminPassword =
  config.adminPassword.length < 6 ||
  config.adminPassword.startsWith("replace-with") ||
  config.adminPassword === "ChangeMe123!";
const weakJwtSecret =
  config.jwtSecret.length < 32 ||
  config.jwtSecret.startsWith("replace-with") ||
  config.jwtSecret.startsWith("local-development");

if (weakAdminPassword || weakJwtSecret) {
  app.log.error(
    "ADMIN_PASSWORD 或 JWT_SECRET 缺失/强度不足。请通过 start-ai-devops.cmd 启动，或在 .env 中设置强凭据。",
  );
  process.exit(1);
}

if (config.adminPassword.length < 12) {
  app.log.warn(
    "ADMIN_PASSWORD 长度不足 12 位。当前仅建议用于本机或可信局域网，不要暴露到公网。",
  );
}

await app.register(cors, {
  origin: config.corsOrigin
    ? config.corsOrigin.split(",").map((origin) => origin.trim())
    : true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

await app.register(fastifyWebsocket);

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  return payload;
});

app.setErrorHandler(async (error, request, reply) => {
  const message = error instanceof Error ? error.message : "未知错误";
  const detail = errorDetail(error);
  const requestId = request.id;
  recordError({
    requestId,
    method: request.method,
    path: request.url,
    code: errorCode(error),
    message,
    detail,
    actor: request.user?.email ?? "",
  });
  request.log.error({ err: error }, "unhandled request error");
  const statusCode =
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Math.min(
          Math.max((error as { statusCode: number }).statusCode, 400),
          599,
        )
      : 500;
  return reply.code(statusCode).send({
    error: statusCode >= 500 ? "internal_error" : "bad_request",
    requestId,
    message:
      statusCode >= 500 ? `服务内部错误：${message}` : message,
    detail,
  });
});

await registerRoutes(app);

const webIndex = path.join(config.webDistDirectory, "index.html");
if (fs.existsSync(webIndex)) {
  await app.register(fastifyStatic, {
    root: config.webDistDirectory,
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "API 路径不存在。" });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async () => ({
    service: "AI DevOps control plane",
    message: "开发模式下请访问 Vite 地址 http://localhost:5173。",
  }));
}

try {
  await app.listen({ host: config.host, port: config.port });
  startHealthMonitor();
  startBackupScheduler();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}


import type { FastifyInstance, FastifyReply } from "fastify";
import { audit } from "./db.js";
import { errorCode, errorDetail, recordError } from "./errors.js";
import {
  auditServerAction,
  createServerConnection,
  deleteServerConnection,
  execServerCommand,
  getServerConnection,
  listServerConnections,
  markServerConnectionError,
  openTerminalSession,
  probeServerEnvironment,
  testServerConnection,
  updateServerConnection,
  type ServerConnectionInput,
  type ServerOsType,
  type ServerProvider,
} from "./servers.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, field: string, maxLength = 300): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field}不能为空。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field}过长。`);
  }
  return normalized;
}

function optionalText(value: unknown, maxLength = 500): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("参数类型不正确。");
  return value.trim().slice(0, maxLength);
}

function portNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) {
    throw new Error("端口号不正确。");
  }
  return number;
}

function normalizeInput(
  body: Record<string, unknown>,
  updating: boolean,
): ServerConnectionInput {
  const osType = body.osType;
  if (osType !== "ubuntu" && osType !== "linux" && osType !== "windows") {
    throw new Error("请选择服务器系统类型。");
  }
  const provider = body.provider;
  if (
    provider !== "tencent" &&
    provider !== "aliyun" &&
    provider !== "huawei" &&
    provider !== "other"
  ) {
    throw new Error("请选择所属云厂商。");
  }
  const input: ServerConnectionInput = {
    name: text(body.name, "服务器名称", 80),
    osType: osType as ServerOsType,
    provider: provider as ServerProvider,
    region: optionalText(body.region, 80),
    host: text(body.host, "服务器地址", 253),
    port: portNumber(body.port, 22),
    username: text(body.username, "登录用户名", 128),
    password: optionalText(body.password, 256),
    note: optionalText(body.note, 500),
  };
  if (!input.password && !updating) {
    throw new Error("请填写登录密码（SSH 密码）。");
  }
  return input;
}

async function handle(
  reply: FastifyReply,
  work: () => Promise<unknown> | unknown,
) {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    const requestId = reply.request.id;
    const detail = errorDetail(error);
    recordError({
      requestId,
      method: reply.request.method,
      path: reply.request.url,
      code: errorCode(error),
      message,
      detail,
      actor: reply.request.user?.email ?? "",
    });
    return reply.code(400).send({
      error: "bad_request",
      requestId,
      message,
      detail,
    });
  }
}

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/servers", async () => ({
    servers: listServerConnections(),
  }));

  app.get("/api/servers/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const record = getServerConnection(params.id);
      if (!record) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "服务器连接不存在。" });
      }
      return { server: record };
    }),
  );

  app.post("/api/servers", async (request, reply) =>
    handle(reply, () => {
      const input = normalizeInput(asRecord(request.body), false);
      const record = createServerConnection(input);
      audit(request.user.email, "server.create", record.name, "success");
      return { server: record };
    }),
  );

  app.patch("/api/servers/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const input = normalizeInput(asRecord(request.body), true);
      const record = updateServerConnection(params.id, input);
      if (!record) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "服务器连接不存在。" });
      }
      audit(request.user.email, "server.update", record.name, "success");
      return { server: record };
    }),
  );

  app.delete("/api/servers/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const record = getServerConnection(params.id);
      const removed = deleteServerConnection(params.id);
      if (!removed) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "服务器连接不存在。" });
      }
      audit(
        request.user.email,
        "server.delete",
        record?.name ?? params.id,
        "success",
      );
      return { ok: true };
    }),
  );

  app.post("/api/servers/:id/test", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      try {
        const result = await testServerConnection(params.id);
        auditServerAction(
          request.user.email,
          "test",
          params.id,
          "success",
          { osInfo: result.osInfo },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "连接失败";
        markServerConnectionError(params.id, message);
        throw new Error(message);
      }
    }),
  );

  app.post("/api/servers/:id/exec", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      const body = asRecord(request.body);
      const command = text(body.command, "命令", 4_000);
      const sudo =
        body.sudo === true;
      const stdin =
        typeof body.stdin === "string" ? body.stdin.slice(0, 1_024) : undefined;
      const result = await execServerCommand(params.id, command, { sudo, stdin });
      auditServerAction(
        request.user.email,
        "exec",
        params.id,
        "success",
        { command: command.slice(0, 300), sudo },
      );
      return { result };
    }),
  );

  app.post("/api/servers/:id/probe", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      const environment = await probeServerEnvironment(params.id);
      auditServerAction(
        request.user.email,
        "probe",
        params.id,
        "success",
        { dockerActive: environment.dockerActive },
      );
      return { environment };
    }),
  );

  app.get(
    "/api/servers/:id/terminal",
    { websocket: true },
    (connection, request) => {
      const params = request.params as { id: string };
      const socket: {
        readyState: number;
        send: (data: Buffer | string) => void;
        close: () => void;
        on: (event: string, listener: (payload: any) => void) => void;
      } = (
        (connection as { socket?: unknown }).socket ?? connection
      ) as {
        readyState: number;
        send: (data: Buffer | string) => void;
        close: () => void;
        on: (event: string, listener: (payload: any) => void) => void;
      };
      const isOpen = () => socket.readyState === 1;
      const safeSend = (data: Buffer | string) => {
        try {
          if (isOpen()) socket.send(data);
        } catch {
          // 连接已关闭时忽略发送失败。
        }
      };
      const session = openTerminalSession(
        params.id,
        (data) => safeSend(data),
        (message) => {
          safeSend(`\r\n\x1b[31m[AI DevOps] ${message}\x1b[0m\r\n`);
          try {
            socket.close();
          } catch {
            // 忽略关闭失败。
          }
        },
        () => {
          try {
            socket.close();
          } catch {
            // 忽略关闭失败。
          }
        },
      );
      if (!session) {
        try {
          socket.close();
        } catch {
          // 忽略关闭失败。
        }
        return;
      }
      auditServerAction(request.user.email, "terminal.open", params.id, "success");
      socket.on("message", (raw: Buffer | string) => {
        const payload = raw.toString();
        try {
          const message = JSON.parse(payload) as {
            type?: string;
            cols?: number;
            rows?: number;
          };
          if (
            message.type === "resize" &&
            Number.isInteger(message.cols) &&
            Number.isInteger(message.rows)
          ) {
            session.resize(
              Math.min(Math.max(message.cols ?? 110, 20), 300),
              Math.min(Math.max(message.rows ?? 30, 5), 200),
            );
            return;
          }
        } catch {
          // 非 JSON 消息，按终端输入处理。
        }
        session.send(payload);
      });
      socket.on("close", () => {
        auditServerAction(
          request.user.email,
          "terminal.close",
          params.id,
          "success",
        );
        session.close();
      });
    },
  );
}

import type { FastifyInstance, FastifyReply } from "fastify";
import { audit } from "./db.js";
import { errorCode, errorDetail, recordError } from "./errors.js";
import {
  backupSchedulerStatus,
  runScheduledBackups,
} from "./scheduler.js";
import {
  createDbConnection,
  deleteBackup,
  deleteDbConnection,
  dumpDatabase,
  getDbConnection,
  getTableDetail,
  listBackups,
  listDatabases,
  listDbConnections,
  listTables,
  markDbConnectionError,
  restoreBackup,
  runSql,
  testDbConnection,
  updateDbConnection,
  type DbConnectionInput,
  type DbKind,
  type DbVendor,
} from "./dbmanage.js";

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

function optionalText(value: unknown, maxLength = 300): string {
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

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error("参数类型不正确。");
  return value;
}

function normalizeInput(
  body: Record<string, unknown>,
  updating: boolean,
): DbConnectionInput {
  const kind = body.kind;
  if (kind !== "cloud_managed" && kind !== "self_hosted") {
    throw new Error("请选择数据库类型（云数据库或服务器自装 MySQL）。");
  }
  const vendor = body.vendor;
  if (
    vendor !== "tencent" &&
    vendor !== "aliyun" &&
    vendor !== "huawei" &&
    vendor !== "other"
  ) {
    throw new Error("请选择所属云厂商。");
  }
  const useSsh = booleanValue(body.useSsh, false);
  const input: DbConnectionInput = {
    name: text(body.name, "连接名称", 80),
    kind: kind as DbKind,
    vendor: vendor as DbVendor,
    host: text(body.host, "数据库地址", 253),
    port: portNumber(body.port, 3306),
    username: text(body.username, "数据库账号", 128),
    password: optionalText(body.password, 256),
    defaultDatabase: optionalText(body.defaultDatabase, 64),
    ssl: booleanValue(body.ssl, false),
    useSsh,
    sshHost: useSsh ? text(body.sshHost, "服务器地址", 253) : "",
    sshPort: useSsh ? portNumber(body.sshPort, 22) : 22,
    sshUsername: useSsh ? text(body.sshUsername, "SSH 用户名", 128) : "",
    sshPassword: useSsh ? optionalText(body.sshPassword, 256) : "",
  };
  if (useSsh && !input.sshPassword && !updating) {
    throw new Error("使用 SSH 隧道时需要填写 SSH 密码。");
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

export async function registerDbRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/db/connections", async () => ({
    connections: listDbConnections(),
  }));

  app.get("/api/db/connections/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const record = getDbConnection(params.id);
      if (!record) {
        return reply.code(404).send({ error: "not_found", message: "连接不存在。" });
      }
      return { connection: record };
    }),
  );

  app.post("/api/db/connections", async (request, reply) =>
    handle(reply, () => {
      const input = normalizeInput(asRecord(request.body), false);
      const record = createDbConnection(input);
      audit(request.user.email, "db.connection.create", record.name, "success");
      return { connection: record };
    }),
  );

  app.patch("/api/db/connections/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const input = normalizeInput(asRecord(request.body), true);
      const record = updateDbConnection(params.id, input);
      if (!record) {
        return reply.code(404).send({ error: "not_found", message: "连接不存在。" });
      }
      audit(request.user.email, "db.connection.update", record.name, "success");
      return { connection: record };
    }),
  );

  app.delete("/api/db/connections/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const record = getDbConnection(params.id);
      const removed = deleteDbConnection(params.id);
      if (!removed) {
        return reply.code(404).send({ error: "not_found", message: "连接不存在。" });
      }
      audit(
        request.user.email,
        "db.connection.delete",
        record?.name ?? params.id,
        "success",
      );
      return { ok: true };
    }),
  );

  app.post("/api/db/connections/:id/test", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      try {
        const result = await testDbConnection(params.id);
        audit(
          request.user.email,
          "db.connection.test",
          params.id,
          "success",
          { version: result.version },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "连接失败";
        markDbConnectionError(params.id, message);
        throw new Error(message);
      }
    }),
  );

  app.get("/api/db/connections/:id/databases", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      return { databases: await listDatabases(params.id) };
    }),
  );

  app.get(
    "/api/db/connections/:id/databases/:db/tables",
    async (request, reply) =>
      handle(reply, async () => {
        const params = request.params as { id: string; db: string };
        return { tables: await listTables(params.id, params.db) };
      }),
  );

  app.get(
    "/api/db/connections/:id/databases/:db/tables/:table",
    async (request, reply) =>
      handle(reply, async () => {
        const params = request.params as { id: string; db: string; table: string };
        return { table: await getTableDetail(params.id, params.db, params.table) };
      }),
  );

  app.post("/api/db/connections/:id/query", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      const body = asRecord(request.body);
      const database = text(body.database, "数据库");
      const sql = text(body.sql, "SQL", 20_000);
      const confirmWrite = booleanValue(body.confirmWrite, false);
      return {
        result: await runSql(params.id, database, sql, confirmWrite),
      };
    }),
  );

  app.post(
    "/api/db/connections/:id/databases/:db/backup",
    async (request, reply) =>
      handle(reply, async () => {
        const params = request.params as { id: string; db: string };
        return { backup: await dumpDatabase(params.id, params.db) };
      }),
  );

  app.get("/api/db/backups", async () => ({
    backups: listBackups(),
  }));

  app.get("/api/db/scheduler/status", async () => ({
    scheduler: backupSchedulerStatus(),
  }));

  app.post("/api/db/backup/run-now", async (request, reply) =>
    handle(reply, async () => {
      const created = await runScheduledBackups(true);
      audit(
        request.user.email,
        "db.backup.run_now",
        "定时备份任务",
        "success",
        { created },
      );
      return { created };
    }),
  );

  app.delete("/api/db/backups/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const removed = deleteBackup(params.id);
      if (!removed) {
        return reply.code(404).send({ error: "not_found", message: "备份不存在。" });
      }
      audit(request.user.email, "db.backup.delete", params.id, "success");
      return { ok: true };
    }),
  );

  app.post("/api/db/backups/:id/restore", async (request, reply) =>
    handle(reply, async () => {
      const params = request.params as { id: string };
      const body = asRecord(request.body);
      const targetDatabase = text(body.targetDatabase, "目标数据库", 64);
      return await restoreBackup(params.id, targetDatabase);
    }),
  );
}

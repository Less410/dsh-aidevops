import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client as SshClient } from "ssh2";
import mysql from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { audit, db } from "./db.js";
import { config, repoRoot } from "./env.js";

export type DbKind = "cloud_managed" | "self_hosted";
export type DbVendor = "tencent" | "aliyun" | "huawei" | "other";

export interface DbConnectionInput {
  name: string;
  kind: DbKind;
  vendor: DbVendor;
  host: string;
  port: number;
  username: string;
  password: string;
  defaultDatabase: string;
  ssl: boolean;
  useSsh: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPassword: string;
}

export interface DbConnectionRecord {
  id: string;
  name: string;
  kind: DbKind;
  vendor: DbVendor;
  host: string;
  port: number;
  username: string;
  defaultDatabase: string;
  ssl: boolean;
  useSsh: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  hasPassword: boolean;
  hasSshPassword: boolean;
  status: "untested" | "connected" | "error";
  statusMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DbConnectionSecret extends DbConnectionRecord {
  password: string;
  sshPassword: string;
}

export interface DbBackupRecord {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  filename: string;
  sizeBytes: number;
  tableCount: number;
  createdAt: string;
}

interface DbConnectionRow {
  id: string;
  name: string;
  kind: string;
  vendor: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  default_database: string;
  ssl: number;
  use_ssh: number;
  ssh_host: string;
  ssh_port: number;
  ssh_username: string;
  ssh_password_enc: string;
  status: string;
  status_message: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS db_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    vendor TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    default_database TEXT NOT NULL DEFAULT '',
    ssl INTEGER NOT NULL DEFAULT 0,
    use_ssh INTEGER NOT NULL DEFAULT 0,
    ssh_host TEXT NOT NULL DEFAULT '',
    ssh_port INTEGER NOT NULL DEFAULT 22,
    ssh_username TEXT NOT NULL DEFAULT '',
    ssh_password_enc TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'untested',
    status_message TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS db_backups (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    database TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    table_count INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const encryptionKey = crypto
  .createHash("sha256")
  .update(`${config.jwtSecret}:aidevops-dbstore-v1`)
  .digest();

function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptSecret(value: string): string {
  if (!value) return "";
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const iv = Buffer.from(parts[1] ?? "", "base64url");
    const tag = Buffer.from(parts[2] ?? "", "base64url");
    const data = Buffer.from(parts[3] ?? "", "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return "";
  }
}

function mapRow(row: DbConnectionRow): DbConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DbKind,
    vendor: row.vendor as DbVendor,
    host: row.host,
    port: row.port,
    username: row.username,
    defaultDatabase: row.default_database,
    ssl: row.ssl === 1,
    useSsh: row.use_ssh === 1,
    sshHost: row.ssh_host,
    sshPort: row.ssh_port,
    sshUsername: row.ssh_username,
    hasPassword: row.password_enc.length > 0,
    hasSshPassword: row.ssh_password_enc.length > 0,
    status:
      row.status === "connected" || row.status === "error"
        ? row.status
        : "untested",
    statusMessage: row.status_message,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const selectRow = db.prepare("SELECT * FROM db_connections WHERE id = ?");

function getSecret(id: string): DbConnectionSecret | undefined {
  const row = selectRow.get(id) as DbConnectionRow | undefined;
  if (!row) return undefined;
  const record = mapRow(row);
  return {
    ...record,
    password: decryptSecret(row.password_enc),
    sshPassword: decryptSecret(row.ssh_password_enc),
  };
}

export function getDbConnection(id: string): DbConnectionRecord | undefined {
  const row = selectRow.get(id) as DbConnectionRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function listDbConnections(): DbConnectionRecord[] {
  const rows = db
    .prepare("SELECT * FROM db_connections ORDER BY created_at ASC")
    .all() as unknown as DbConnectionRow[];
  return rows.map(mapRow);
}

const insertConnection = db.prepare(`
  INSERT INTO db_connections (
    id, name, kind, vendor, host, port, username, password_enc,
    default_database, ssl, use_ssh, ssh_host, ssh_port, ssh_username,
    ssh_password_enc, status, status_message, last_checked_at,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateConnection = db.prepare(`
  UPDATE db_connections SET
    name = ?, kind = ?, vendor = ?, host = ?, port = ?, username = ?,
    password_enc = ?, default_database = ?, ssl = ?, use_ssh = ?,
    ssh_host = ?, ssh_port = ?, ssh_username = ?, ssh_password_enc = ?,
    updated_at = ?
  WHERE id = ?
`);

export function createDbConnection(input: DbConnectionInput): DbConnectionRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertConnection.run(
    id,
    input.name,
    input.kind,
    input.vendor,
    input.host,
    input.port,
    input.username,
    encryptSecret(input.password),
    input.defaultDatabase,
    input.ssl ? 1 : 0,
    input.useSsh ? 1 : 0,
    input.useSsh ? input.sshHost : "",
    input.useSsh ? input.sshPort : 22,
    input.useSsh ? input.sshUsername : "",
    input.useSsh ? encryptSecret(input.sshPassword) : "",
    "untested",
    "尚未测试连接",
    null,
    now,
    now,
  );
  const created = getDbConnection(id);
  if (!created) {
    throw new Error("数据库连接创建失败。");
  }
  return created;
}

export function updateDbConnection(
  id: string,
  input: DbConnectionInput,
): DbConnectionRecord | undefined {
  const existing = getSecret(id);
  if (!existing) return undefined;
  const passwordEnc = input.password
    ? encryptSecret(input.password)
    : (selectRow.get(id) as unknown as DbConnectionRow).password_enc;
  const sshPasswordEnc = input.useSsh
    ? input.sshPassword
      ? encryptSecret(input.sshPassword)
      : (selectRow.get(id) as unknown as DbConnectionRow).ssh_password_enc
    : "";
  updateConnection.run(
    input.name,
    input.kind,
    input.vendor,
    input.host,
    input.port,
    input.username,
    passwordEnc,
    input.defaultDatabase,
    input.ssl ? 1 : 0,
    input.useSsh ? 1 : 0,
    input.useSsh ? input.sshHost : "",
    input.useSsh ? input.sshPort : 22,
    input.useSsh ? input.sshUsername : "",
    sshPasswordEnc,
    new Date().toISOString(),
    id,
  );
  return getDbConnection(id);
}

export function deleteDbConnection(id: string): boolean {
  const backupRows = db
    .prepare("SELECT filename FROM db_backups WHERE connection_id = ?")
    .all(id) as Array<{ filename: string }>;
  const removed = db
    .prepare("DELETE FROM db_connections WHERE id = ?")
    .run(id);
  if (removed.changes > 0) {
    db.prepare("DELETE FROM db_backups WHERE connection_id = ?").run(id);
    const backupDir = backupDirectory();
    for (const row of backupRows) {
      const filePath = path.join(backupDir, row.filename);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // 备份文件清理失败不阻塞连接删除。
      }
    }
  }
  return removed.changes > 0;
}

function markStatus(
  id: string,
  status: DbConnectionRecord["status"],
  message: string,
  checkedAt: string,
): void {
  db.prepare(
    "UPDATE db_connections SET status = ?, status_message = ?, last_checked_at = ? WHERE id = ?",
  ).run(status, message.slice(0, 500), checkedAt, id);
}

export function markDbConnectionError(id: string, message: string): void {
  markStatus(id, "error", message, new Date().toISOString());
}

export function backupDirectory(): string {
  const directory = path.join(repoRoot, "data", "backups");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

interface OpenedConnection {
  conn: Connection;
  close: () => Promise<void>;
}

async function openConnection(
  record: DbConnectionSecret,
  database = "",
  multiStatements = false,
): Promise<OpenedConnection> {
  let host = record.host;
  let port = record.port;
  let sshClient: SshClient | null = null;
  let tunnelServer: net.Server | null = null;

  if (record.useSsh) {
    if (!record.sshHost || !record.sshUsername || !record.sshPassword) {
      throw new Error("SSH 隧道信息不完整：请填写服务器地址、SSH 用户名和密码。");
    }
    sshClient = new SshClient();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const client = sshClient as SshClient;
      client.once("ready", () => {
        settled = true;
        resolve();
      });
      client.once("error", (error: Error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`SSH 连接失败：${error.message}`));
        }
      });
      client.connect({
        host: record.sshHost,
        port: record.sshPort,
        username: record.sshUsername,
        password: record.sshPassword,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
      });
    });

    tunnelServer = net.createServer((socket) => {
      if (!sshClient) {
        socket.destroy();
        return;
      }
      sshClient.forwardOut(
        "127.0.0.1",
        0,
        record.host,
        record.port,
        (error, stream) => {
          if (error) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          socket.on("error", () => stream.close());
          stream.on("error", () => socket.destroy());
        },
      );
    });
    await new Promise<void>((resolve) => {
      (tunnelServer as net.Server).listen(0, "127.0.0.1", () => resolve());
    });
    const address = tunnelServer.address();
    if (!address || typeof address === "string") {
      throw new Error("无法建立 SSH 本地转发。");
    }
    host = "127.0.0.1";
    port = address.port;
  }

  const conn = await mysql.createConnection({
    host,
    port,
    user: record.username,
    password: record.password,
    database: database || undefined,
    connectTimeout: 10_000,
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: multiStatements,
    ssl: record.ssl ? { rejectUnauthorized: false } : undefined,
  });

  return {
    conn,
    close: async () => {
      try {
        await conn.end();
      } catch {
        // 关闭连接失败可以忽略。
      }
      tunnelServer?.close();
      sshClient?.end();
    },
  };
}

async function withConnection<T>(
  record: DbConnectionSecret,
  database: string,
  work: (conn: Connection) => Promise<T>,
  options: { multiStatements?: boolean } = {},
): Promise<T> {
  const opened = await openConnection(
    record,
    database,
    options.multiStatements ?? false,
  );
  try {
    return await work(opened.conn);
  } finally {
    await opened.close();
  }
}

export function assertIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_$]{1,64}$/.test(value)) {
    throw new Error(`${label}名称不合法，只允许字母、数字、下划线。`);
  }
  return value;
}

export async function testDbConnection(id: string): Promise<{
  ok: true;
  version: string;
  secure: boolean;
}> {
  const record = getSecret(id);
  if (!record) throw new Error("数据库连接不存在。");
  const result = await withConnection(record, "", async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    const secure =
      record.useSsh || record.ssl || record.host === "127.0.0.1" || record.host === "localhost";
    return {
      ok: true as const,
      version: String(rows[0]?.version ?? ""),
      secure,
    };
  });
  markStatus(
    id,
    "connected",
    `连接成功 · MySQL ${result.version}`,
    new Date().toISOString(),
  );
  return result;
}

export async function listDatabases(id: string): Promise<
  Array<{ name: string; system: boolean }>
> {
  const record = getSecret(id);
  if (!record) throw new Error("数据库连接不存在。");
  return withConnection(record, "", async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>("SHOW DATABASES");
    const systemSet = new Set([
      "information_schema",
      "mysql",
      "performance_schema",
      "sys",
    ]);
    return rows.map((row) => {
      const name = String(Object.values(row)[0] ?? "");
      return { name, system: systemSet.has(name) };
    });
  });
}

export async function listTables(
  id: string,
  database: string,
): Promise<
  Array<{
    name: string;
    type: string;
    engine: string;
    rows: number;
    sizeBytes: number;
  }>
> {
  const record = getSecret(id);
  if (!record) throw new Error("数据库连接不存在。");
  const safeDb = assertIdentifier(database, "数据库");
  return withConnection(record, "", async (conn) => {
    const [tableRows] = await conn.query<RowDataPacket[]>(
      `SHOW FULL TABLES FROM \`${safeDb}\``,
    );
    const [statusRows] = await conn.query<RowDataPacket[]>(
      `SHOW TABLE STATUS FROM \`${safeDb}\``,
    );
    const statusMap = new Map<string, RowDataPacket>();
    for (const row of statusRows) {
      const name = row.Name;
      if (typeof name === "string") statusMap.set(name, row);
    }
    return tableRows.map((row) => {
      const values = Object.values(row);
      const name = String(values[0] ?? "");
      const type = String(values[1] ?? "BASE TABLE");
      const status = statusMap.get(name);
      const dataLength = Number(status?.Data_length ?? 0);
      const indexLength = Number(status?.Index_length ?? 0);
      return {
        name,
        type,
        engine: status ? String(status.Engine ?? "") : "",
        rows: Number(status?.Rows ?? 0),
        sizeBytes: dataLength + indexLength,
      };
    });
  });
}

function sanitizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `[二进制数据 ${value.length} 字节]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

export async function getTableDetail(
  id: string,
  database: string,
  table: string,
): Promise<{
  name: string;
  type: "table" | "view";
  ddl: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    key: string;
    extra: string;
    defaultValue: string | null;
    comment: string;
  }>;
  rows: Array<Record<string, unknown>>;
  rowCountHint: number;
}> {
  const record = getSecret(id);
  if (!record) throw new Error("数据库连接不存在。");
  const safeDb = assertIdentifier(database, "数据库");
  const safeTable = assertIdentifier(table, "表");
  return withConnection(record, "", async (conn) => {
    let ddl = "";
    let type: "table" | "view" = "table";
    try {
      const [created] = await conn.query<RowDataPacket[]>(
        `SHOW CREATE TABLE \`${safeDb}\`.\`${safeTable}\``,
      );
      const createdRow = created[0];
      if (createdRow) {
        ddl = String(Object.values(createdRow)[1] ?? "");
      }
    } catch {
      ddl = "";
    }
    if (!ddl) {
      const [view] = await conn.query<RowDataPacket[]>(
        `SHOW CREATE VIEW \`${safeDb}\`.\`${safeTable}\``,
      );
      const viewRow = view[0];
      if (viewRow) {
        type = "view";
        ddl = String(Object.values(viewRow)[1] ?? "");
      }
    }
    if (!ddl) throw new Error("表或视图不存在。");

    const [columnRows] = await conn.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT, COLUMN_COMMENT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [safeDb, safeTable],
    );
    const columns = columnRows.map((row) => ({
      name: String(row.COLUMN_NAME ?? ""),
      type: String(row.COLUMN_TYPE ?? ""),
      nullable: row.IS_NULLABLE === "YES",
      key: String(row.COLUMN_KEY ?? ""),
      extra: String(row.EXTRA ?? ""),
      defaultValue: row.COLUMN_DEFAULT == null ? null : String(row.COLUMN_DEFAULT),
      comment: String(row.COLUMN_COMMENT ?? ""),
    }));

    const [rows] = await conn.query<RowDataPacket[]>({
      sql: `SELECT * FROM \`${safeDb}\`.\`${safeTable}\` LIMIT 100`,
      timeout: 20_000,
    });
    const safeRows = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, sanitizeCell(value)]),
      ),
    );

    let rowCountHint = rows.length;
    if (rows.length >= 100) {
      try {
        const [countRows] = await conn.query<RowDataPacket[]>({
          sql: `SELECT COUNT(*) AS total FROM \`${safeDb}\`.\`${safeTable}\``,
          timeout: 20_000,
        });
        rowCountHint = Number(countRows[0]?.total ?? rows.length);
      } catch {
        rowCountHint = rows.length;
      }
    }

    return {
      name: safeTable,
      type,
      ddl,
      columns,
      rows: safeRows,
      rowCountHint,
    };
  });
}

const READ_ONLY_FIRST = new Set([
  "select",
  "show",
  "describe",
  "desc",
  "explain",
  "use",
  "set",
]);

const ALWAYS_BLOCKED = /\b(load\s+data\s+infile|into\s+(outfile|dumpfile)|shutdown)\b/i;

function statementFirstKeyword(sql: string): string {
  const trimmed = sql.trim();
  const match = trimmed.match(/^([a-z]+)/i);
  return (match?.[1] ?? "").toLowerCase();
}

function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim();
  const first = statementFirstKeyword(trimmed);
  if (first !== "with") return READ_ONLY_FIRST.has(first);
  const body = trimmed.slice(4);
  const inner = body.replace(/^[\s\S]*?\)\s*/i, "");
  const innerFirst = inner.match(/^([a-z]+)/i)?.[1]?.toLowerCase() ?? "select";
  return innerFirst === "select";
}

export interface SqlQueryResult {
  kind: "resultset" | "executed";
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  affectedRows: number;
  changedRows: number;
  elapsedMs: number;
}

export async function runSql(
  id: string,
  database: string,
  sql: string,
  confirmWrite: boolean,
): Promise<SqlQueryResult> {
  const record = getSecret(id);
  if (!record) throw new Error("数据库连接不存在。");
  const safeDb = assertIdentifier(database, "数据库");
  const normalized = sql.trim().replace(/;+\s*$/, "");
  if (!normalized) throw new Error("请输入要执行的 SQL。");
  if (ALWAYS_BLOCKED.test(normalized)) {
    throw new Error("该语句被安全策略禁止执行。");
  }
  const readOnly = isReadOnlySql(normalized);
  if (!readOnly && !confirmWrite) {
    throw new Error(
      "这是一条会修改数据的语句。请确认风险并勾选“我确认执行写操作”后再运行。",
    );
  }

  const startedAt = Date.now();
  const result = await withConnection(record, safeDb, async (conn) => {
    const raw = await conn.query({
      sql: normalized,
      timeout: 20_000,
    });
    if (
      Array.isArray(raw) &&
      raw.length === 2 &&
      Array.isArray(raw[0])
    ) {
      const rows = raw[0] as RowDataPacket[];
      const fields = raw[1] as Array<{ name: string; type?: number }>;
      const columns = fields.map((field) => ({
        name: field.name,
        type: String(field.type ?? ""),
      }));
      const capped = rows.slice(0, 500);
      return {
        kind: "resultset" as const,
        columns,
        rows: capped.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, sanitizeCell(value)]),
          ),
        ),
        truncated: rows.length > capped.length,
        affectedRows: 0,
        changedRows: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const header = raw as {
      affectedRows?: number;
      changedRows?: number;
      insertId?: number;
    };
    return {
      kind: "executed" as const,
      columns: [],
      rows: [],
      truncated: false,
      affectedRows: Number(header.affectedRows ?? 0),
      changedRows: Number(header.changedRows ?? 0),
      elapsedMs: Date.now() - startedAt,
    };
  });

  audit(
    config.adminEmail,
    readOnly ? "db.query" : "db.write",
    `${record.name}/${safeDb}`,
    "success",
    { sql: normalized.slice(0, 400), confirmWrite },
  );
  return result;
}

export async function dumpDatabase(
  id: string,
  database: string,
): Promise<DbBackupRecord> {
  const record = getSecret(id);
  if (!record) throw new Error("数据库连接不存在。");
  const safeDb = assertIdentifier(database, "数据库");
  const backup = await withConnection(record, "", async (conn) => {
    await conn
      .query({ sql: "SET SESSION net_write_timeout = 3600", timeout: 5_000 })
      .catch(() => undefined);

    const [tableRows] = await conn.query<RowDataPacket[]>(
      `SHOW FULL TABLES FROM \`${safeDb}\``,
    );
    const directory = backupDirectory();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${record.name}-${safeDb}-${stamp}.sql`.replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    const filePath = path.join(directory, filename);
    const output = fs.createWriteStream(filePath, { encoding: "utf8" });
    let sizeBytes = 0;
    let tableCount = 0;
    const write = (text: string) => {
      sizeBytes += Buffer.byteLength(text, "utf8");
      output.write(text);
    };

    write(
      [
        `-- AI DevOps MySQL logical backup`,
        `-- Server: ${record.host}:${record.port}`,
        `-- Database: ${safeDb}`,
        `-- Created: ${new Date().toISOString()}`,
        ``,
        `SET NAMES utf8mb4;`,
        `SET FOREIGN_KEY_CHECKS = 0;`,
        ``,
        ``,
      ].join("\n"),
    );

    for (const row of tableRows) {
      const values = Object.values(row);
      const tableName = String(values[0] ?? "");
      const tableType = String(values[1] ?? "BASE TABLE");
      if (tableType === "VIEW") {
        const [viewRows] = await conn.query<RowDataPacket[]>({
          sql: `SHOW CREATE VIEW \`${safeDb}\`.\`${tableName}\``,
          timeout: 20_000,
        });
        const ddl = viewRows[0]
          ? String(Object.values(viewRows[0])[1] ?? "")
          : "";
        if (ddl) {
          write(`DROP VIEW IF EXISTS \`${tableName}\`;\n${ddl};\n\n`);
          tableCount += 1;
        }
        continue;
      }

      const [createdRows] = await conn.query<RowDataPacket[]>({
        sql: `SHOW CREATE TABLE \`${safeDb}\`.\`${tableName}\``,
        timeout: 20_000,
      });
      const ddl = createdRows[0]
        ? String(Object.values(createdRows[0])[1] ?? "")
        : "";
      if (!ddl) continue;
      write(`DROP TABLE IF EXISTS \`${tableName}\`;\n${ddl};\n\n`);
      tableCount += 1;

      const batchSize = 1_000;
      let offset = 0;
      for (;;) {
        const [rows] = await conn.query<RowDataPacket[]>({
          sql: `SELECT * FROM \`${safeDb}\`.\`${tableName}\` LIMIT ${batchSize} OFFSET ${offset}`,
          timeout: 60_000,
        });
        if (rows.length === 0) break;
        const columnNames = Object.keys(rows[0] ?? {});
        const escapedColumns = columnNames
          .map((column) => `\`${column}\``)
          .join(", ");
        const tuples = rows.map((dataRow) => {
          const valuesPart = columnNames
            .map((column) => conn.escape(dataRow[column]))
            .join(", ");
          return `(${valuesPart})`;
        });
        write(
          `INSERT INTO \`${tableName}\` (${escapedColumns}) VALUES\n${tuples.join(
            ",\n",
          )};\n\n`,
        );
        if (rows.length < batchSize) break;
        offset += batchSize;
      }
    }

    write(`SET FOREIGN_KEY_CHECKS = 1;\n`);
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.on("error", reject);
    });

    return { filename, sizeBytes, tableCount };
  });

  const idValue = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO db_backups
     (id, connection_id, database, filename, size_bytes, table_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    idValue,
    record.id,
    safeDb,
    backup.filename,
    backup.sizeBytes,
    backup.tableCount,
    createdAt,
  );
  audit(config.adminEmail, "db.backup", `${record.name}/${safeDb}`, "success", {
    sizeBytes: backup.sizeBytes,
    tables: backup.tableCount,
  });
  return {
    id: idValue,
    connectionId: record.id,
    connectionName: record.name,
    database: safeDb,
    filename: backup.filename,
    sizeBytes: backup.sizeBytes,
    tableCount: backup.tableCount,
    createdAt,
  };
}

export function listBackups(): DbBackupRecord[] {
  const rows = db
    .prepare(
      `SELECT b.*, c.name AS connection_name
       FROM db_backups b
       LEFT JOIN db_connections c ON c.id = b.connection_id
       ORDER BY b.created_at DESC`,
    )
    .all() as Array<{
    id: string;
    connection_id: string;
    database: string;
    filename: string;
    size_bytes: number;
    table_count: number;
    created_at: string;
    connection_name: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    connectionName: row.connection_name ?? "已删除的连接",
    database: row.database,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    tableCount: row.table_count,
    createdAt: row.created_at,
  }));
}

export function deleteBackup(backupId: string): boolean {
  const row = db
    .prepare("SELECT filename FROM db_backups WHERE id = ?")
    .get(backupId) as { filename: string } | undefined;
  if (!row) return false;
  const removed = db.prepare("DELETE FROM db_backups WHERE id = ?").run(backupId);
  if (removed.changes > 0) {
    const filePath = path.join(backupDirectory(), row.filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // 文件清理失败不阻塞记录删除。
    }
  }
  return removed.changes > 0;
}

export async function restoreBackup(
  backupId: string,
  targetDatabase: string,
): Promise<{ ok: true; elapsedMs: number }> {
  const row = db
    .prepare(
      `SELECT b.*, c.name AS connection_name
       FROM db_backups b
       LEFT JOIN db_connections c ON c.id = b.connection_id
       WHERE b.id = ?`,
    )
    .get(backupId) as
    | {
        connection_id: string;
        database: string;
        filename: string;
        size_bytes: number;
        connection_name: string | null;
      }
    | undefined;
  if (!row) throw new Error("备份记录不存在。");
  const record = getSecret(row.connection_id);
  if (!record) throw new Error("该备份对应的连接已删除，无法恢复。");
  const safeTarget = assertIdentifier(targetDatabase, "目标数据库");

  const filePath = path.join(backupDirectory(), row.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error("备份文件已丢失（可能被手动删除）。");
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 200 * 1024 * 1024) {
    throw new Error("备份文件超过 200MB，请在服务器上通过 mysql 命令恢复。");
  }
  const sql = fs.readFileSync(filePath, "utf8");
  const startedAt = Date.now();
  await withConnection(
    record,
    "",
    async (conn) => {
      await conn.query({
        sql: `CREATE DATABASE IF NOT EXISTS \`${safeTarget}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
        timeout: 30_000,
      });
      await conn.query({
        sql: `USE \`${safeTarget}\``,
        timeout: 10_000,
      });
      await conn.query({ sql, timeout: 600_000 });
    },
    { multiStatements: true },
  );
  audit(
    config.adminEmail,
    "db.restore",
    `${record.name}/${safeTarget}`,
    "success",
    { backupId, sizeBytes: stat.size },
  );
  return { ok: true, elapsedMs: Date.now() - startedAt };
}

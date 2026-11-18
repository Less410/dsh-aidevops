import crypto from "node:crypto";
import { Client as SshClient } from "ssh2";
import type { ClientChannel } from "ssh2";
import { audit, db } from "./db.js";
import { config } from "./env.js";

export type ServerOsType = "ubuntu" | "linux" | "windows";
export type ServerProvider = "tencent" | "aliyun" | "huawei" | "other";

export interface ServerConnectionInput {
  name: string;
  osType: ServerOsType;
  provider: ServerProvider;
  region: string;
  host: string;
  port: number;
  username: string;
  password: string;
  note: string;
}

export interface ServerConnectionRecord {
  id: string;
  name: string;
  osType: ServerOsType;
  provider: ServerProvider;
  region: string;
  host: string;
  port: number;
  username: string;
  note: string;
  hasPassword: boolean;
  status: "untested" | "connected" | "error";
  statusMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ServerConnectionSecret extends ServerConnectionRecord {
  password: string;
}

interface ServerRow {
  id: string;
  name: string;
  os_type: string;
  provider: string;
  region: string;
  host: string;
  port: number;
  username: string;
  password_enc: string;
  note: string;
  status: string;
  status_message: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    os_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'untested',
    status_message TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const encryptionKey = crypto
  .createHash("sha256")
  .update(`${config.jwtSecret}:aidevops-serverstore-v1`)
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

function mapRow(row: ServerRow): ServerConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    osType: row.os_type as ServerOsType,
    provider: row.provider as ServerProvider,
    region: row.region,
    host: row.host,
    port: row.port,
    username: row.username,
    note: row.note,
    hasPassword: row.password_enc.length > 0,
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

const selectRow = db.prepare("SELECT * FROM cloud_servers WHERE id = ?");

export function getSecret(id: string): ServerConnectionSecret | undefined {
  const row = selectRow.get(id) as unknown as ServerRow | undefined;
  if (!row) return undefined;
  return { ...mapRow(row), password: decryptSecret(row.password_enc) };
}

export const getServerSecret = getSecret;

export function getServerConnection(id: string): ServerConnectionRecord | undefined {
  const row = selectRow.get(id) as unknown as ServerRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function listServerConnections(): ServerConnectionRecord[] {
  const rows = db
    .prepare("SELECT * FROM cloud_servers ORDER BY created_at ASC")
    .all() as unknown as ServerRow[];
  return rows.map(mapRow);
}

const insertServer = db.prepare(`
  INSERT INTO cloud_servers (
    id, name, os_type, provider, region, host, port, username, password_enc,
    note, status, status_message, last_checked_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateServer = db.prepare(`
  UPDATE cloud_servers SET
    name = ?, os_type = ?, provider = ?, region = ?, host = ?, port = ?,
    username = ?, password_enc = ?, note = ?, updated_at = ?
  WHERE id = ?
`);

export function createServerConnection(
  input: ServerConnectionInput,
): ServerConnectionRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  insertServer.run(
    id,
    input.name,
    input.osType,
    input.provider,
    input.region,
    input.host,
    input.port,
    input.username,
    encryptSecret(input.password),
    input.note,
    "untested",
    "尚未测试连接",
    null,
    now,
    now,
  );
  const created = getServerConnection(id);
  if (!created) throw new Error("云服务器连接创建失败。");
  return created;
}

export function updateServerConnection(
  id: string,
  input: ServerConnectionInput,
): ServerConnectionRecord | undefined {
  if (!getSecret(id)) return undefined;
  const row = selectRow.get(id) as unknown as ServerRow;
  const passwordEnc = input.password
    ? encryptSecret(input.password)
    : row.password_enc;
  updateServer.run(
    input.name,
    input.osType,
    input.provider,
    input.region,
    input.host,
    input.port,
    input.username,
    passwordEnc,
    input.note,
    new Date().toISOString(),
    id,
  );
  return getServerConnection(id);
}

export function deleteServerConnection(id: string): boolean {
  const removed = db
    .prepare("DELETE FROM cloud_servers WHERE id = ?")
    .run(id);
  return removed.changes > 0;
}

function markStatus(
  id: string,
  status: ServerConnectionRecord["status"],
  message: string,
): void {
  db.prepare(
    "UPDATE cloud_servers SET status = ?, status_message = ?, last_checked_at = ? WHERE id = ?",
  ).run(status, message.slice(0, 500), new Date().toISOString(), id);
}

export function markServerConnectionError(id: string, message: string): void {
  markStatus(id, "error", message);
}

export function connectSsh(record: ServerConnectionSecret): SshClient {
  if (!record.password) {
    throw new Error("缺少 SSH 密码，请编辑连接补充。");
  }
  const client = new SshClient();
  client.on("error", () => {
    // 错误由调用方通过 ready/error 事件处理，这里避免未捕获异常。
  });
  client.connect({
    host: record.host,
    port: record.port,
    username: record.username,
    password: record.password,
    readyTimeout: 45_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  });
  return client;
}

export function waitReady(client: SshClient): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
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
  });
}

const SSH_CONNECT_ATTEMPTS = 3;
const SSH_RETRY_DELAY_MS = 1_500;

/** 建连重试：服务器负载高时握手会偶发超时，重试而不是直接判死。 */
export async function connectSshWithRetry(
  record: ServerConnectionSecret,
  attempts = SSH_CONNECT_ATTEMPTS,
): Promise<SshClient> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = connectSsh(record);
    try {
      await waitReady(client);
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      client.end();
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt * SSH_RETRY_DELAY_MS),
        );
      }
    }
  }
  throw lastError ?? new Error("SSH 连接失败：未知错误");
}

export async function testServerConnection(id: string): Promise<{
  ok: true;
  osInfo: string;
}> {
  const record = getSecret(id);
  if (!record) throw new Error("云服务器连接不存在。");
  const client = await connectSshWithRetry(record);
  try {
    const command = record.osType === "windows" ? "ver" : "uname -a";
    const output = await execOnClient(client, command, 15_000);
    const osInfo =
      output.stdout.trim().split(/\r?\n/)[0]?.slice(0, 200) ||
      output.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) ||
      "已连接";
    markStatus(id, "connected", `连接成功 · ${osInfo}`);
    return { ok: true, osInfo };
  } finally {
    client.end();
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
}

export interface ServerEnvironmentProbe {
  os: string;
  git: string;
  docker: string;
  dockerCompose: string;
  dockerActive: boolean;
  node: string;
  containerCount: number;
  disk: string;
  collectedAt: string;
}

export function execOnClient(
  client: SshClient,
  command: string,
  timeoutMs: number,
  stdin?: string,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error("命令执行超时。"));
      }
    }, timeoutMs);
    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        if (!finished) {
          finished = true;
          reject(new Error(`执行失败：${error.message}`));
        }
        return;
      }
      stream
        .on("close", (code: number | null) => {
          clearTimeout(timer);
          if (!finished) {
            finished = true;
            resolve({
              stdout,
              stderr,
              exitCode: code,
              elapsedMs: Date.now() - startedAt,
            });
          }
        })
        .on("data", (data: Buffer) => {
          stdout += data.toString("utf8");
        })
        .stderr.on("data", (data: Buffer) => {
          stderr += data.toString("utf8");
        });
      if (stdin !== undefined) {
        stream.write(stdin);
        stream.end();
      }
    });
  });
}

export async function execServerCommand(
  id: string,
  command: string,
  options: { sudo?: boolean; stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const record = getSecret(id);
  if (!record) throw new Error("云服务器连接不存在。");
  const client = await connectSshWithRetry(record);
  try {
    if (options.sudo) {
      const encoded = Buffer.from(command, "utf8").toString("base64");
      return await execOnClient(
        client,
        `sudo -S -p '' sh -c "$(echo ${encoded} | base64 -d)"`,
        options.timeoutMs ?? 120_000,
        `${record.password}\n`,
      );
    }
    return await execOnClient(
      client,
      command,
      options.timeoutMs ?? 120_000,
      options.stdin,
    );
  } finally {
    client.end();
  }
}

export async function probeServerEnvironment(
  id: string,
): Promise<ServerEnvironmentProbe> {
  const record = getSecret(id);
  if (!record) throw new Error("云服务器连接不存在。");
  const script = [
    `echo OS=$(uname -srm)`,
    `echo GIT=$(git --version 2>/dev/null || echo 未安装)`,
    `echo DOCKER=$(docker --version 2>/dev/null || echo 未安装)`,
    `echo COMPOSE=$(docker compose version 2>/dev/null | head -1 || echo 未安装)`,
    `echo DOCKER_ACTIVE=$(systemctl is-active docker 2>/dev/null || echo unknown)`,
    `echo NODE=$(node --version 2>/dev/null || echo 未安装)`,
    `echo CONTAINERS=$(docker ps -q 2>/dev/null | wc -l)`,
    `echo DISK=$(df -h / | tail -1 | awk '{print $3"/"$2" 已用 "$5}')`,
  ].join("; ");
  const client = await connectSshWithRetry(record);
  try {
    const output = await execOnClient(client, script, 60_000);
    const values: Record<string, string> = {};
    for (const line of output.stdout.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) values[match[1] ?? ""] = (match[2] ?? "").trim();
    }
    return {
      os: values.OS ?? "",
      git: values.GIT ?? "",
      docker: values.DOCKER ?? "",
      dockerCompose: values.COMPOSE ?? "",
      dockerActive: values.DOCKER_ACTIVE === "active",
      node: values.NODE ?? "",
      containerCount: Number.parseInt(values.CONTAINERS ?? "0", 10) || 0,
      disk: values.DISK ?? "",
      collectedAt: new Date().toISOString(),
    };
  } finally {
    client.end();
  }
}

export interface TerminalSession {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export function openTerminalSession(
  id: string,
  onData: (data: Buffer) => void,
  onError: (message: string) => void,
  onClose: () => void,
): TerminalSession | null {
  const record = getSecret(id);
  if (!record) {
    onError("云服务器连接不存在。");
    return null;
  }
  const client = connectSsh(record);
  let stream: ClientChannel | null = null;
  let closed = false;

  client.once("error", (error: Error) => {
    if (!closed) {
      onError(`SSH 连接失败：${error.message}`);
    }
  });

  client.once("ready", () => {
    client.shell(
      {
        term: "xterm-256color",
        cols: 110,
        rows: 30,
      },
      (error, shellStream) => {
        if (error || closed) {
          if (error) onError(`打开终端失败：${error.message}`);
          client.end();
          return;
        }
        stream = shellStream;
        shellStream.on("data", (data: Buffer) => onData(data));
        shellStream.stderr.on("data", (data: Buffer) => onData(data));
        shellStream.on("close", () => {
          if (!closed) {
            closed = true;
            onClose();
          }
          client.end();
        });
        shellStream.on("error", (streamError: Error) => {
          if (!closed) onError(`终端连接中断：${streamError.message}`);
        });
      },
    );
  });

  return {
    send(data: string) {
      stream?.write(data);
    },
    resize(cols: number, rows: number) {
      stream?.setWindow(rows, cols, 0, 0);
    },
    close() {
      if (!closed) {
        closed = true;
        stream?.end();
        client.end();
      }
    },
  };
}

export function auditServerAction(
  actor: string,
  action: string,
  target: string,
  result: string,
  metadata: Record<string, unknown> = {},
): void {
  audit(actor, `server.${action}`, target, result, metadata);
}

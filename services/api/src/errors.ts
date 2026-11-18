import crypto from "node:crypto";
import { db } from "./db.js";

export interface ErrorEventRecord {
  id: string;
  requestId: string;
  method: string;
  path: string;
  code: string;
  message: string;
  detail: string;
  actor: string;
  createdAt: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS error_events (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code.slice(0, 64);
  }
  return error instanceof Error ? error.name : "unknown";
}

export function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? "").split("\n").slice(0, 8).join("\n");
    return `${error.name}: ${error.message}${stack ? `\n${stack}` : ""}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function recordError(input: {
  requestId: string;
  method: string;
  path: string;
  code: string;
  message: string;
  detail: string;
  actor: string;
}): string {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO error_events
    (id, request_id, method, path, code, message, detail, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.requestId.slice(0, 64),
    input.method.slice(0, 10),
    input.path.slice(0, 300),
    input.code,
    input.message.slice(0, 500),
    input.detail.slice(0, 4000),
    input.actor.slice(0, 120),
    new Date().toISOString(),
  );
  return id;
}

export function listErrorEvents(limit = 50): ErrorEventRecord[] {
  const rows = db
    .prepare(
      `SELECT id, request_id AS requestId, method, path, code, message,
              detail, actor, created_at AS createdAt
       FROM error_events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as ErrorEventRecord[];
  return rows;
}

export function clearErrorEvents(): number {
  return db.prepare("DELETE FROM error_events").run().changes as number;
}

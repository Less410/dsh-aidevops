import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./env.js";
import type { SessionUser } from "./types.js";

const TOKEN_TTL_SECONDS = 12 * 60 * 60;

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(payload)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyCredentials(email: string, password: string): boolean {
  return (
    safeEqual(email.trim().toLowerCase(), config.adminEmail) &&
    safeEqual(password, config.adminPassword)
  );
}

export function createSessionToken(): {
  token: string;
  expiresAt: string;
  user: Omit<SessionUser, "exp">;
} {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const user = {
    email: config.adminEmail,
    name: "平台管理员",
    role: "admin" as const,
  };
  const payload = encode(
    JSON.stringify({
      ...user,
      exp: expiresAt,
    } satisfies SessionUser),
  );
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    user,
  };
}

export function verifySessionToken(token: string): SessionUser | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(sign(payload), signature)) {
    return null;
  }

  try {
    const user = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as SessionUser;
    if (
      user.email !== config.adminEmail ||
      user.role !== "admin" ||
      !Number.isFinite(user.exp) ||
      user.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const session = token ? verifySessionToken(token) : null;
  if (!session) {
    await reply.code(401).send({
      error: "unauthorized",
      message: "登录已失效，请重新登录。",
    });
    return;
  }
  request.user = session;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser;
  }
}


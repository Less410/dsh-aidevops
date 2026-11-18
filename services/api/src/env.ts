import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(currentDirectory, "../../..");
export const webDistDirectory = path.join(repoRoot, "apps", "web", "dist");

try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch {
  // A .env file is optional. Environment variables can be supplied by the host.
}

function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH ?? "./data/ai-devops.db";
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(repoRoot, configured);
}

function readPort(): number {
  const value = Number(process.env.PORT ?? 8787);
  return Number.isInteger(value) && value > 0 ? value : 8787;
}

export const config = Object.freeze({
  host: process.env.HOST ?? "0.0.0.0",
  port: readPort(),
  databasePath: resolveDatabasePath(),
  jwtSecret: process.env.JWT_SECRET ?? "",
  adminEmail: (process.env.ADMIN_EMAIL ?? "admin@aidevops.local").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  demoMode: (process.env.DEMO_MODE ?? "true").toLowerCase() !== "false",
  llmBaseUrl: process.env.LLM_BASE_URL?.replace(/\/+$/, "") ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "",
  webDistDirectory,
});

export const isLlmConfigured = Boolean(
  config.llmBaseUrl && config.llmApiKey && config.llmModel,
);


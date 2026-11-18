import type { RepositoryProvider } from "./types.js";
import { connectSshWithRetry, execOnClient } from "./servers.js";

const allowedProviders: RepositoryProvider[] = [
  "github",
  "gitlab",
  "gitea",
  "gitee",
];

export function validateRepositoryUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("仓库地址必须是有效的 HTTPS URL。");
  }
  if (url.protocol !== "https:") {
    throw new Error("当前 MVP 仅支持公开 HTTPS 仓库地址。");
  }
  if (url.username || url.password) {
    throw new Error("仓库地址中不能包含用户名或密码。");
  }
  if (!url.hostname || url.hostname === "localhost") {
    throw new Error("当前 MVP 不允许同步本机或未知地址。");
  }
  return url;
}

export function isRepositoryProvider(value: unknown): value is RepositoryProvider {
  return (
    typeof value === "string" &&
    allowedProviders.includes(value as RepositoryProvider)
  );
}

function validateBranch(value: string): string {
  if (
    !value ||
    value.length > 120 ||
    value.startsWith("-") ||
    !/^[a-zA-Z0-9._/-]+$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("分支名称不合法。");
  }
  return value;
}

interface SyncServer {
  host: string;
  port: number;
  username: string;
  password: string;
}

export function repositoryAccessUrl(
  url: string,
  provider: RepositoryProvider,
  token: string,
): string {
  if (!token) return url;
  const parsed = new URL(url);
  if (provider === "gitee") {
    parsed.username = "oauth2";
    parsed.password = token;
  } else {
    parsed.username = token;
    parsed.password = "";
  }
  return parsed.toString();
}

export function repositoryBasicAuthUrl(
  url: string,
  username: string,
  password: string,
): string {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

export function repositoryUserUrl(url: string, username: string): string {
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = "";
  return parsed.toString();
}

export async function syncRepository(input: {
  id: string;
  url: string;
  branch: string;
  server: SyncServer;
  password?: string;
}): Promise<{ commitSha: string; message: string }> {
  const branch = validateBranch(input.branch);
  const repositoryDirectory = `/opt/ai-devops/repos/${input.id}`;
  const passwordFile = `/tmp/aidevops-gitpw-${input.id}`;
  const askpassFile = `/tmp/aidevops-gitask-${input.id}`;
  const setup = input.password
    ? [
        `cat > '${passwordFile}' && chmod 600 '${passwordFile}'`,
        `printf '#!/bin/sh\\ncat '${passwordFile}'\\n' > '${askpassFile}' && chmod 700 '${askpassFile}'`,
      ]
    : [];
  const gitPrefix = input.password
    ? `GIT_ASKPASS='${askpassFile}' `
    : "";
  const script = [
    `export GIT_TERMINAL_PROMPT=0`,
    ...setup,
    `if [ -d '${repositoryDirectory}/.git' ]; then`,
    `  ${gitPrefix}git -C '${repositoryDirectory}' fetch --depth 1 origin '${branch}' >/dev/null 2>&1`,
    `  ${gitPrefix}git -C '${repositoryDirectory}' reset --hard FETCH_HEAD >/dev/null 2>&1`,
    `else`,
    `  ${gitPrefix}git clone --depth 1 --branch '${branch}' --single-branch '${input.url}' '${repositoryDirectory}' >/dev/null 2>&1`,
    `fi`,
    `echo SHA=$(git -C '${repositoryDirectory}' rev-parse --short=7 HEAD 2>/dev/null)`,
    `echo MSG=$(git -C '${repositoryDirectory}' log -1 --pretty=%s 2>/dev/null)`,
    `rm -f '${passwordFile}' '${askpassFile}'`,
  ].join("\n");

  const client = await connectSshWithRetry({
    id: input.id,
    name: "sync-server",
    osType: "linux",
    provider: "other",
    region: "",
    host: input.server.host,
    port: input.server.port,
    username: input.server.username,
    note: "",
    hasPassword: true,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: null,
    createdAt: "",
    updatedAt: "",
    password: input.server.password,
  });
  try {
    const output = await execOnClient(
      client,
      script,
      120_000,
      input.password ? `${input.password}\n` : undefined,
    );
    const shaLine = output.stdout.match(/^SHA=(\S+)/m);
    const msgLine = output.stdout.match(/^MSG=(.*)$/m);
    const commitSha = shaLine?.[1]?.trim() ?? "";
    if (!commitSha) {
      const detail = output.stderr.trim().slice(0, 600);
      throw new Error(
        detail || `同步失败：无法获取 ${input.url} 的最新版本。`,
      );
    }
    return {
      commitSha,
      message: (msgLine?.[1] ?? "").trim().slice(0, 300) || "仓库已同步",
    };
  } finally {
    client.end();
  }
}


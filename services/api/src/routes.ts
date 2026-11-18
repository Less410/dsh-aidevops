import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { analyzeRun, chat } from "./ai.js";
import {
  createApplication,
  deleteApplication,
  getApplicationEnv,
  getApplicationEnvStatus,
  listApplications,
  listApplicationTypes,
  setApplicationEnv,
  updateApplication,
} from "./apps.js";
import { createSessionToken, verifyCredentials } from "./auth.js";
import {
  listAliyunIngressRules,
  openAliyunSecurityGroupPort,
} from "./aliyun.js";
import { cloudAdapters, isCloudProvider } from "./cloud.js";
import { resolveDeliveryServer } from "./delivery-target.js";
import { registerDbRoutes } from "./dbRoutes.js";
import {
  deployContainer,
  prepareRollback,
  runBuildAndPush,
} from "./deploy.js";
import { registerServerRoutes } from "./serversRoutes.js";
import { getApplication } from "./apps.js";
import {
  approveRun,
  approveDnsChangeRequest,
  audit,
  cancelDnsChangeRequest,
  completeDnsChangeRequest,
  createAgentToken,
  deleteAgentToken,
  createCloudAccount,
  createDeployment,
  createDnsChangeRequest,
  createPipeline,
  createRepository,
  failDnsChangeRequest,
  getRepositoryAccess,
  createRun,
  getDnsChangeRequest,
  getGitCredentialSecret,
  getOverview,
  getDeployment,
  getPipeline,
  getRepository,
  getRun,
  getCloudAccountSecret,
  findAgentByToken,
  listAgentTokens,
  listAuditEvents,
  listDeployments,
  listDeploymentsByAgent,
  listCloudAccounts,
  listCloudResources,
  listDnsChangeRequests,
  listGitCredentials,
  listHealthChecks,
  listPipelines,
  listRegistryCredentials,
  listRepositories,
  listRuns,
  markDnsChangeRolledBack,
  markRepositorySyncFailed,
  recordDnsChangeReverification,
  refreshDnsChangePreflight,
  refreshCloudAccount,
  renameAgentToken,
  revokeAgentToken,
  replaceCloudResources,
  setCloudAccountScanResult,
  setCloudAccountMonthlyCost,
  startDnsChangeExecution,
  updateCloudAccount,
  updateCloudAccountStatus,
  updateDeployment,
  updateRepositoryAfterSync,
  updateRepositoryInfo,
  upsertGitCredential,
  upsertRegistryCredential,
  type DnsChangeRequestRecord,
} from "./db.js";
import {
  confirmRollbackRecordRemoved,
  findMatchingDnsRecord,
  normalizeDnsBindingInput,
  runDnsChangePreflight,
  verifyDnsChange,
  verifyRollbackRecord,
  type DnsBindingInput,
} from "./dnsChange.js";
import {
  getPonytailStatus,
  isPonytailMode,
  isPonytailSkill,
} from "./ponytail.js";
import { config, isLlmConfigured } from "./env.js";
import {
  clearErrorEvents,
  errorCode,
  errorDetail,
  listErrorEvents,
  recordError,
} from "./errors.js";
import {
  isRepositoryProvider,
  repositoryAccessUrl,
  repositoryUserUrl,
  syncRepository,
  validateRepositoryUrl,
} from "./git.js";
import { getServerSecret, listServerConnections } from "./servers.js";
import {
  createDnsPodRecord,
  deleteDnsPodRecord,
  getTencentMonthlyBill,
  listLighthouseFirewallRules,
  openLighthouseFirewallPort,
  resolveLighthouseInstanceId,
} from "./tencent.js";
import type { EnvironmentName, RepositoryProvider } from "./types.js";

function resolveSyncServer(serverId: string | null): {
  host: string;
  port: number;
  username: string;
  password: string;
} {
  let record = serverId ? getServerSecret(serverId) : undefined;
  if (!record) {
    const servers = listServerConnections();
    const fallbackId =
      servers.find((server) => server.status === "connected")?.id ??
      servers[0]?.id ??
      "";
    record = getServerSecret(fallbackId);
  }
  if (!record) {
    throw new Error(
      "请先在仓库设置中选择同步服务器（需要先在“云服务器”中登记服务器）。",
    );
  }
  return {
    host: record.host,
    port: record.port,
    username: record.username,
    password: record.password,
  };
}

type CloudAccountSecretRecord = NonNullable<
  ReturnType<typeof getCloudAccountSecret>
>;

interface CloudInventoryScanSummary {
  ok: boolean;
  accountId: string;
  accountName: string;
  provider: string;
  live: boolean;
  resources: number;
  domains: number;
  cost: number;
  warnings: string[];
  scannedAt: string;
  error?: string;
}

function scanErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "同步失败";
}

async function scanCloudInventory(
  account: CloudAccountSecretRecord,
  actor: string,
): Promise<CloudInventoryScanSummary> {
  const adapter = cloudAdapters[account.provider];
  const canLiveScan =
    account.hasSecret &&
    adapter.supportsReadInventory;
  if (!canLiveScan) {
    throw new Error(
      adapter.supportsReadInventory
        ? `该账号未保存 ${adapter.label} API 密钥，无法读取实时资源。`
        : `${adapter.label}连接器尚未支持读取资源清单。`,
    );
  }

  try {
    const scanResult = await adapter.scan({
      id: account.id,
      provider: account.provider,
      region: account.region,
      accountType: account.accountType,
      ownerId: account.ownerId,
      accessKeyId: account.accessKeyId,
      secretKey: account.secretKey,
      hasSecret: account.hasSecret,
    });
    const { resources } = scanResult;
    const warnings = [...scanResult.warnings];
    const storedResourceCount = replaceCloudResources(
      account.id,
      resources,
      account.region,
      scanResult.complete,
    );
    setCloudAccountScanResult(account.id, storedResourceCount);

    let monthlyCost = 0;
    if (account.provider === "tencent") {
      try {
        monthlyCost = await getTencentMonthlyBill({
          secretId: account.accessKeyId,
          secretKey: account.secretKey,
        });
        setCloudAccountMonthlyCost(account.id, monthlyCost);
      } catch (error) {
        warnings.push(`本月账单：${scanErrorMessage(error)}`);
      }
    }

    const domainCount = resources.filter(
      (resource) => resource.type === "Domain",
    ).length;
    const warningSuffix =
      warnings.length > 0 ? ` · ${warnings.length} 项同步告警` : "";
    updateCloudAccountStatus(
      account.id,
      "connected",
      `真实同步完成 · ${resources.length} 个资源 · ${domainCount} 个注册域名${
        monthlyCost > 0
          ? ` · 本月消费 ¥${monthlyCost.toLocaleString("zh-CN")}`
          : ""
      }${warningSuffix}`,
    );
    const scannedAt = new Date().toISOString();
    audit(
      actor,
      "cloud.inventory.scanned",
      `${account.name} / ${account.id}`,
      "success",
      {
        live: true,
        resources: resources.length,
        domains: domainCount,
        warnings: warnings.length,
        provider: account.provider,
      },
    );
    return {
      ok: true,
      accountId: account.id,
      accountName: account.name,
      provider: account.provider,
      live: true,
      resources: resources.length,
      domains: domainCount,
      cost: monthlyCost,
      warnings,
      scannedAt,
    };
  } catch (error) {
    const message = scanErrorMessage(error);
    updateCloudAccountStatus(account.id, "error", message);
    audit(
      actor,
      "cloud.inventory.scanned",
      `${account.name} / ${account.id}`,
      "failed",
      { live: true, provider: account.provider, error: message.slice(0, 300) },
    );
    throw error;
  }
}

function requireTencentDnsAccount(accountId: string): CloudAccountSecretRecord {
  const account = getCloudAccountSecret(accountId);
  if (!account) {
    throw new Error("云账号不存在。");
  }
  if (account.provider !== "tencent") {
    throw new Error("DNS 变更当前仅支持腾讯云 DNSPod 子账号。");
  }
  if (account.accountType !== "sub" || !account.hasSecret) {
    throw new Error("请使用已保存密钥的腾讯云子账号执行 DNS 变更。");
  }
  return account;
}

function dnsCredentials(account: CloudAccountSecretRecord) {
  return {
    secretId: account.accessKeyId,
    secretKey: account.secretKey,
  };
}

function dnsBindingFromChange(
  change: DnsChangeRequestRecord,
): DnsBindingInput {
  return normalizeDnsBindingInput({
    domain: change.domain,
    subdomain: change.subdomain,
    targetIp: change.targetValue,
    httpPort: new URL(change.finalUrl).port,
    ttl: change.ttl,
  });
}

function dnsChangeAuditMetadata(
  change: DnsChangeRequestRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    changeId: change.id,
    accountId: change.accountId,
    domain: change.domain,
    subdomain: change.subdomain,
    recordType: change.recordType,
    targetValue: change.targetValue,
    finalUrl: change.finalUrl,
    recordId: change.recordId,
    createRequestId: change.createRequestId,
    deleteRequestId: change.deleteRequestId,
    status: change.status,
    ...extra,
  };
}

const loginAttempts = new Map<
  string,
  { count: number; resetAt: number }
>();

const defaultFaviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8383ff"/><stop offset="0.48" stop-color="#5a5be8"/><stop offset="1" stop-color="#3d3dc6"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M31 14l3.4 10.2L44.6 27.6l-10.2 3.4L31 41.2l-3.4-10.2L17.4 27.6l10.2-3.4z"/><path d="M47 39l1.8 5.4 5.4 1.8-5.4 1.8L47 53.4l-1.8-5.4-5.4-1.8 5.4-1.8z"/><path d="M17 41l1.3 4 4 1.3-4 1.3L17 51.6l-1.3-4-4-1.3 4-1.3z"/></g></svg>`;
const faviconDirectory = path.join(path.dirname(config.databasePath), "brand");
const faviconMetaPath = path.join(faviconDirectory, "favicon.json");

function readFavicon(): { buffer: Buffer; mime: string } {
  try {
    const meta = JSON.parse(
      fs.readFileSync(faviconMetaPath, "utf8"),
    ) as { filename: string; mime: string };
    const filePath = path.join(faviconDirectory, meta.filename);
    if (fs.existsSync(filePath)) {
      return { buffer: fs.readFileSync(filePath), mime: meta.mime };
    }
  } catch {
    // 没有自定义图标时使用默认图标。
  }
  return {
    buffer: Buffer.from(defaultFaviconSvg, "utf8"),
    mime: "image/svg+xml",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 200,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} 不能为空。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} 过长。`);
  }
  return normalized;
}

function isEnvironment(value: unknown): value is EnvironmentName {
  return (
    value === "development" ||
    value === "staging" ||
    value === "production"
  );
}

function validateName(value: unknown, field: string): string {
  const name = requiredString(value, field, 80);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._·/-]*$/u.test(name)) {
    throw new Error(`${field} 包含不支持的字符。`);
  }
  return name;
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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    service: "ai-devops-control-plane",
    timestamp: new Date().toISOString(),
  }));

  app.get("/api/favicon", async (_request, reply) => {
    const favicon = readFavicon();
    reply.header("Cache-Control", "no-store");
    return reply.type(favicon.mime).send(favicon.buffer);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const now = Date.now();
    const attempt = loginAttempts.get(request.ip);
    if (attempt && attempt.resetAt > now && attempt.count >= 6) {
      return reply.code(429).send({
        error: "too_many_attempts",
        message: "登录尝试过多，请五分钟后重试。",
      });
    }

    const body = asRecord(request.body);
    const email =
      typeof body.email === "string" ? body.email.toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return reply
        .code(400)
        .send({ error: "bad_request", message: "请输入邮箱和密码。" });
    }
    if (!verifyCredentials(email, password)) {
      const current = loginAttempts.get(request.ip);
      loginAttempts.set(request.ip, {
        count: current && current.resetAt > now ? current.count + 1 : 1,
        resetAt:
          current && current.resetAt > now ? current.resetAt : now + 5 * 60_000,
      });
      audit(email, "auth.login", request.ip, "failed");
      return reply
        .code(401)
        .send({ error: "invalid_credentials", message: "邮箱或密码不正确。" });
    }

    loginAttempts.delete(request.ip);
    const session = createSessionToken();
    audit(session.user.email, "auth.login", request.ip, "success");
    return session;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.method === "OPTIONS" ||
      !request.url.startsWith("/api/") ||
      request.url.startsWith("/api/health") ||
      request.url === "/api/favicon" ||
      request.url.startsWith("/api/favicon?") ||
      request.url.startsWith("/api/auth/login")
    ) {
      return;
    }
    const requestPath = request.url.split("?")[0] ?? request.url;
    const isAgentCall = [
      "/api/agent/deliver",
      "/api/agent/status",
      "/api/agent/resources",
    ].includes(requestPath);
    if (isAgentCall) {
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      if (!findAgentByToken(token)) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "智能体令牌无效或已撤销。",
        });
      }
      return;
    }
    request.id = crypto.randomUUID();
    if (
      !request.headers.authorization &&
      /^\/api\/servers\/[^/]+\/terminal$/.test(requestPath)
    ) {
      const query = request.query as { token?: string };
      if (typeof query.token === "string" && query.token) {
        request.headers.authorization = `Bearer ${query.token}`;
      }
    }
    const { requireSession } = await import("./auth.js");
    await requireSession(request, reply);
  });

  app.get("/api/auth/me", async (request) => ({ user: request.user }));

  app.get("/api/overview", async () => getOverview());

  app.get("/api/ponytail", async () => getPonytailStatus());

  app.post("/api/ponytail/activity", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      if (!isPonytailSkill(body.skill)) {
        throw new Error("不支持的 Ponytail Skill。");
      }
      let mode: string | null = null;
      if (body.skill === "ponytail") {
        const requestedMode = body.mode ?? "full";
        if (!isPonytailMode(requestedMode)) {
          throw new Error("Ponytail 模式必须是 off、lite、full 或 ultra。");
        }
        mode = requestedMode;
      } else if (body.mode !== undefined && body.mode !== null) {
        throw new Error("该 Ponytail Skill 不接受模式参数。");
      }
      audit(
        request.user.email,
        "ponytail.command.generated",
        body.skill,
        "success",
        mode ? { mode } : {},
      );
      return getPonytailStatus();
    }),
  );

  app.get("/api/repositories", async () => ({
    repositories: listRepositories(),
  }));

  app.post("/api/repositories", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const provider = body.provider;
      if (!isRepositoryProvider(provider)) {
        throw new Error("请选择支持的 Git 服务商。");
      }
      const name = validateName(body.name, "仓库名称");
      const branch = requiredString(body.branch ?? "main", "分支", 120);
      if (
        branch.startsWith("-") ||
        branch.includes("..") ||
        !/^[a-zA-Z0-9._/-]+$/.test(branch)
      ) {
        throw new Error("分支名称不合法。");
      }
      const url = validateRepositoryUrl(
        requiredString(body.url, "仓库地址", 500),
      ).toString();
      const serverId =
        typeof body.serverId === "string" && body.serverId.trim()
          ? body.serverId.trim()
          : null;
      const token =
        typeof body.token === "string" ? body.token.trim().slice(0, 300) : "";
      const repository = createRepository({
        name,
        provider,
        url,
        branch,
        serverId,
        token,
      });
      audit(
        request.user.email,
        "repository.created",
        `${name} / ${url}`,
        "success",
      );
      return reply.code(201).send({ repository });
    }),
  );

  app.patch("/api/repositories/:id", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const body = asRecord(request.body);
      const provider = body.provider;
      if (!isRepositoryProvider(provider)) {
        throw new Error("请选择支持的 Git 服务商。");
      }
      const name = validateName(body.name, "仓库名称");
      const branch = requiredString(body.branch ?? "main", "分支", 120);
      if (
        branch.startsWith("-") ||
        branch.includes("..") ||
        !/^[a-zA-Z0-9._/-]+$/.test(branch)
      ) {
        throw new Error("分支名称不合法。");
      }
      const url = validateRepositoryUrl(
        requiredString(body.url, "仓库地址", 500),
      ).toString();
      const serverId =
        typeof body.serverId === "string" && body.serverId.trim()
          ? body.serverId.trim()
          : null;
      const token =
        typeof body.token === "string" ? body.token.trim().slice(0, 300) : "";
      const repository = updateRepositoryInfo(id, {
        name,
        provider,
        url,
        branch,
        serverId,
        token,
      });
      if (!repository) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "仓库不存在。" });
      }
      audit(request.user.email, "repository.updated", name, "success");
      return { repository };
    }),
  );

  app.post("/api/repositories/:id/sync", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const repository = getRepository(id) as
        | {
            id: string;
            name: string;
            url: string;
            branch: string;
            provider: RepositoryProvider;
          }
        | undefined;
      if (!repository) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "仓库不存在。" });
      }
      try {
        const access = getRepositoryAccess(id);
        if (!access) {
          throw new Error("仓库凭据读取失败。");
        }
        const serverId = access.serverId;
        const server = resolveSyncServer(serverId);
        let remoteUrl: string;
        let remotePassword: string | undefined;
        if (access.token) {
          remoteUrl = repositoryAccessUrl(
            access.url,
            access.provider,
            access.token,
          );
        } else if (access.provider === "gitee") {
          const credential = getGitCredentialSecret("gitee");
          if (credential) {
            remoteUrl = repositoryUserUrl(access.url, credential.username);
            remotePassword = credential.password;
          } else {
            remoteUrl = access.url;
          }
        } else {
          remoteUrl = access.url;
        }
        const result = await syncRepository({
          id,
          url: remoteUrl,
          branch: repository.branch,
          server,
          password: remotePassword,
        });
        updateRepositoryAfterSync(id, result.commitSha, result.message);
        audit(
          request.user.email,
          "repository.synced",
          `${repository.name} / ${result.commitSha}`,
          "success",
        );
        return { commitSha: result.commitSha, message: result.message };
      } catch (error) {
        markRepositorySyncFailed(id);
        audit(
          request.user.email,
          "repository.synced",
          repository.name,
          "failed",
        );
        throw error;
      }
    }),
  );

  app.get("/api/pipelines", async () => ({
    pipelines: listPipelines(),
  }));

  app.post("/api/pipelines", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const name = validateName(body.name, "流水线名称");
      const repositoryId = requiredString(body.repositoryId, "仓库", 100);
      if (!isEnvironment(body.environment)) {
        throw new Error("发布环境不合法。");
      }
      if (!Array.isArray(body.steps) || body.steps.length === 0) {
        throw new Error("流水线至少需要一个步骤。");
      }
      const stepNames = body.steps
        .slice(0, 20)
        .map((step, index) => validateName(step, `步骤 ${index + 1}`));
      const id = createPipeline({
        name,
        repositoryId,
        environment: body.environment,
        stepNames,
      });
      audit(
        request.user.email,
        "pipeline.created",
        `${name} / ${id}`,
        "success",
      );
      return reply.code(201).send({ pipeline: getPipeline(id) });
    }),
  );

  app.post("/api/pipelines/:id/run", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const pipeline = getPipeline(id);
      if (!pipeline) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "流水线不存在。" });
      }
      const runId = createRun(id, request.user.name);
      return reply.code(201).send({ run: getRun(runId) });
    }),
  );

  app.get("/api/runs", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
    return { runs: listRuns(Number.isFinite(limit) ? limit : 20) };
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getRun(id);
    if (!run) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "运行记录不存在。" });
    }
    return { run };
  });

  app.post("/api/runs/:id/approve", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      if (!approveRun(id, request.user.name)) {
        return reply.code(409).send({
          error: "invalid_state",
          message: "该运行不处于等待审批状态。",
        });
      }
      return { run: getRun(id) };
    }),
  );

  app.post("/api/runs/:id/analyze", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = getRun(id);
    if (!run) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "运行记录不存在。" });
    }
    audit(
      request.user.email,
      "ai.run_analysis",
      `${run.pipelineName} / ${id}`,
      "success",
    );
    return { analysis: analyzeRun(run) };
  });

  app.get("/api/cloud/accounts", async () => ({
    accounts: listCloudAccounts(),
    providers: Object.values(cloudAdapters).map((adapter) => ({
      provider: adapter.provider,
      label: adapter.label,
      supportsReadInventory: adapter.supportsReadInventory,
      supportsControlledChange: adapter.supportsControlledChange,
    })),
  }));

  app.get("/api/cloud/dns/changes", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
    return {
      changes: listDnsChangeRequests(Number.isFinite(limit) ? limit : 50),
    };
  });

  app.get("/api/cloud/dns/changes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const change = getDnsChangeRequest(id);
    if (!change) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "DNS 变更单不存在。" });
    }
    return { change };
  });

  app.post("/api/cloud/dns/changes", async (request, reply) =>
    handle(reply, async () => {
      const body = asRecord(request.body);
      const accountId = requiredString(body.accountId, "腾讯云子账号", 100);
      const account = requireTencentDnsAccount(accountId);
      const binding = normalizeDnsBindingInput({
        domain: body.domain,
        subdomain: body.subdomain,
        targetIp: body.targetIp,
        httpPort: body.httpPort,
        ttl: body.ttl,
      });
      const duplicate = listDnsChangeRequests(100).find(
        (change) =>
          change.accountId === account.id &&
          change.domain === binding.domain &&
          change.subdomain === binding.subdomain &&
          (["waiting_approval", "approved", "executing", "succeeded"].includes(
            change.status,
          ) ||
            (change.status === "failed" && Boolean(change.recordId))),
      );
      if (duplicate) {
        return reply.code(409).send({
          error: "duplicate_dns_change",
          message:
            duplicate.status === "failed"
              ? `该主机记录存在待清理的失败变更（RecordId ${duplicate.recordId}），请先完成回滚。`
              : `该主机记录已有 DNS 变更单 ${duplicate.id}，状态为 ${duplicate.status}。`,
          change: duplicate,
        });
      }

      const preflight = await runDnsChangePreflight(
        dnsCredentials(account),
        binding,
      );
      const change = createDnsChangeRequest({
        accountId: account.id,
        provider: account.provider,
        domain: binding.domain,
        subdomain: binding.subdomain,
        recordType: "A",
        targetValue: binding.targetIp,
        ttl: binding.ttl,
        finalUrl: binding.finalUrl,
        status: preflight.ok ? "waiting_approval" : "failed",
        requestedBy: request.user.email,
        preflight,
        error: preflight.ok
          ? ""
          : "创建变更单前的只读预检未通过，未执行任何 DNS 写操作。",
      });
      audit(
        request.user.email,
        "cloud.dns.change.created",
        `${binding.domain}/${binding.subdomain} / ${change.id}`,
        preflight.ok ? "success" : "failed",
        dnsChangeAuditMetadata(change, {
          preflightOk: preflight.ok,
          checks: preflight.checks,
        }),
      );
      return reply.code(201).send({ change });
    }),
  );

  app.post("/api/cloud/dns/changes/:id/approve", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const change = getDnsChangeRequest(id);
      if (!change) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "DNS 变更单不存在。" });
      }
      if (change.status !== "waiting_approval") {
        return reply.code(409).send({
          error: "invalid_state",
          message: "只有等待审批的变更单可以审批。",
        });
      }
      const body = asRecord(request.body);
      if (body.confirmation !== "APPROVE") {
        return reply.code(400).send({
          error: "confirmation_required",
          message: "审批请求必须包含确认值 APPROVE。",
        });
      }
      const account = requireTencentDnsAccount(change.accountId);
      const binding = dnsBindingFromChange(change);
      const preflight = await runDnsChangePreflight(
        dnsCredentials(account),
        binding,
      );
      refreshDnsChangePreflight(change.id, preflight);
      if (!preflight.ok) {
        audit(
          request.user.email,
          "cloud.dns.change.approved",
          `${change.domain}/${change.subdomain} / ${change.id}`,
          "failed",
          dnsChangeAuditMetadata(change, {
            reason: "approval_preflight_failed",
            checks: preflight.checks,
          }),
        );
        return reply.code(409).send({
          error: "preflight_failed",
          message: "审批前重新预检未通过，请查看最新检查结果。",
          change: getDnsChangeRequest(change.id),
        });
      }
      const note =
        typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      if (!approveDnsChangeRequest(change.id, request.user.email, note)) {
        return reply.code(409).send({
          error: "invalid_state",
          message: "变更单状态已变化，请刷新后重试。",
        });
      }
      const approved = getDnsChangeRequest(change.id);
      if (approved) {
        audit(
          request.user.email,
          "cloud.dns.change.approved",
          `${approved.domain}/${approved.subdomain} / ${approved.id}`,
          "success",
          dnsChangeAuditMetadata(approved, {
            selfApproval: approved.requestedBy === approved.approvedBy,
            approvalNote: note,
          }),
        );
      }
      return { change: approved };
    }),
  );

  app.post("/api/cloud/dns/changes/:id/execute", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const change = getDnsChangeRequest(id);
      if (!change) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "DNS 变更单不存在。" });
      }
      if (change.status !== "approved") {
        return reply.code(409).send({
          error: "invalid_state",
          message: "只有已审批的变更单可以执行。",
        });
      }
      const body = asRecord(request.body);
      if (body.confirmation !== change.finalUrl) {
        return reply.code(400).send({
          error: "confirmation_required",
          message: `执行确认值必须精确等于 ${change.finalUrl}`,
        });
      }
      const account = requireTencentDnsAccount(change.accountId);
      const credentials = dnsCredentials(account);
      const binding = dnsBindingFromChange(change);
      const refreshed = await runDnsChangePreflight(credentials, binding);
      refreshDnsChangePreflight(change.id, refreshed);
      if (!refreshed.ok) {
        failDnsChangeRequest(
          change.id,
          "执行前重新预检失败，未写入 DNS。",
          { stage: "preflight", checks: refreshed.checks },
        );
        const failed = getDnsChangeRequest(change.id);
        audit(
          request.user.email,
          "cloud.dns.change.executed",
          `${change.domain}/${change.subdomain} / ${change.id}`,
          "failed",
          dnsChangeAuditMetadata(change, {
            reason: "execution_preflight_failed",
            checks: refreshed.checks,
          }),
        );
        return reply.code(409).send({
          error: "preflight_failed",
          message: "执行前重新预检未通过，已锁定变更单且未写入 DNS。",
          change: failed,
        });
      }
      if (!startDnsChangeExecution(change.id)) {
        return reply.code(409).send({
          error: "invalid_state",
          message: "变更单状态已变化，请刷新后重试。",
        });
      }

      const execution: Record<string, unknown> = {
        stage: "creating",
        startedAt: new Date().toISOString(),
        domain: binding.domain,
        subdomain: binding.subdomain,
        recordType: "A",
        targetValue: binding.targetIp,
        ttl: binding.ttl,
        finalUrl: binding.finalUrl,
      };
      let recordId = "";
      let createRequestId = "";
      try {
        const created = await createDnsPodRecord(credentials, {
          domain: binding.domain,
          subdomain: binding.subdomain,
          recordType: "A",
          value: binding.targetIp,
          ttl: binding.ttl,
          recordLine: "默认",
          remark: `AI DevOps 变更单 ${change.id}`,
        });
        recordId = created.recordId;
        createRequestId = created.requestId;
        execution.recordId = recordId;
        execution.createRequestId = createRequestId;
        execution.stage = "created";

        const verification = await verifyDnsChange(
          credentials,
          binding,
          recordId,
        );
        execution.stage = "verified";
        if (!verification.ok) {
          failDnsChangeRequest(
            change.id,
            "DNS 记录已创建，但最终健康验证未通过；记录 ID 已保留，可执行精确回滚。",
            { ...execution, checks: verification.checks },
            recordId,
            createRequestId,
          );
          const failed = getDnsChangeRequest(change.id);
          audit(
            request.user.email,
            "cloud.dns.change.executed",
            `${binding.domain}/${binding.subdomain} / ${change.id}`,
            "failed",
            dnsChangeAuditMetadata(change, {
              recordId,
              createRequestId,
              verification,
            }),
          );
          return reply.code(409).send({
            error: "verification_failed",
            message:
              "DNS 记录已创建，但域名解析或最终 URL 健康检查未通过。请查看证据并决定是否回滚。",
            change: failed,
          });
        }
        completeDnsChangeRequest(change.id, {
          recordId,
          createRequestId,
          execution,
          verification,
        });
        const completed = getDnsChangeRequest(change.id);
        if (completed) {
          audit(
            request.user.email,
            "cloud.dns.change.executed",
            `${binding.domain}/${binding.subdomain} / ${change.id}`,
            "success",
            dnsChangeAuditMetadata(completed, {
              verification,
            }),
          );
        }
        return { change: completed };
      } catch (error) {
        if (!recordId) {
          try {
            const reconciled = await findMatchingDnsRecord(
              credentials,
              binding,
            );
            if (reconciled) {
              recordId = reconciled.recordId;
              execution.recordId = recordId;
              execution.reconciled = true;
            }
          } catch (reconcileError) {
            execution.reconcileError =
              reconcileError instanceof Error
                ? reconcileError.message
                : "记录核对失败";
          }
        }
        const message =
          error instanceof Error ? error.message : "DNS 记录创建失败";
        execution.stage = "create_failed";
        execution.error = message;
        failDnsChangeRequest(
          change.id,
          message,
          execution,
          recordId,
          createRequestId,
        );
        const failed = getDnsChangeRequest(change.id);
        if (failed) {
          audit(
            request.user.email,
            "cloud.dns.change.executed",
            `${binding.domain}/${binding.subdomain} / ${change.id}`,
            "failed",
            dnsChangeAuditMetadata(failed, {
              error: message,
              recordKnown: Boolean(recordId),
            }),
          );
        }
        throw error;
      }
    }),
  );

  app.post("/api/cloud/dns/changes/:id/reverify", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const change = getDnsChangeRequest(id);
      if (!change) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "DNS 变更单不存在。" });
      }
      if (change.status !== "failed" || !change.recordId) {
        return reply.code(409).send({
          error: "invalid_state",
          message:
            "只有失败且已记录 RecordId 的变更单可以执行安全复核。",
        });
      }
      const body = asRecord(request.body);
      if (body.confirmation !== `REVERIFY ${change.recordId}`) {
        return reply.code(400).send({
          error: "confirmation_required",
          message: `复核确认值必须精确等于 REVERIFY ${change.recordId}`,
        });
      }

      const account = requireTencentDnsAccount(change.accountId);
      const binding = dnsBindingFromChange(change);
      const verification = await verifyDnsChange(
        dnsCredentials(account),
        binding,
        change.recordId,
      );
      const reverifiedAt = new Date().toISOString();
      const execution = {
        ...change.execution,
        stage: verification.ok ? "reverified" : "reverification_failed",
        reverifiedAt,
        reverifiedBy: request.user.email,
        reverificationPassed: verification.ok,
      };
      if (
        !recordDnsChangeReverification({
          id: change.id,
          recordId: change.recordId,
          verification,
          execution,
          passed: verification.ok,
        })
      ) {
        return reply.code(409).send({
          error: "invalid_state",
          message: "变更单状态已变化，请刷新后重新复核。",
        });
      }

      const rechecked = getDnsChangeRequest(change.id);
      if (rechecked) {
        audit(
          request.user.email,
          "cloud.dns.change.reverified",
          `${change.domain}/${change.subdomain} / ${change.id}`,
          verification.ok ? "success" : "failed",
          dnsChangeAuditMetadata(rechecked, {
            previousStatus: "failed",
            recordId: change.recordId,
            createRequestId: change.createRequestId,
            verification,
          }),
        );
      }
      if (!verification.ok) {
        return reply.code(409).send({
          error: "verification_failed",
          message:
            "安全复核仍未通过，变更单保持失败状态，最新检查证据已保存。",
          change: rechecked,
        });
      }
      return { change: rechecked };
    }),
  );

  app.post("/api/cloud/dns/changes/:id/rollback", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const change = getDnsChangeRequest(id);
      if (!change) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "DNS 变更单不存在。" });
      }
      if (
        !["succeeded", "failed"].includes(change.status) ||
        !change.recordId
      ) {
        return reply.code(409).send({
          error: "invalid_state",
          message:
            "只有成功或失败且已记录 RecordId 的变更单才能执行精确回滚。",
        });
      }
      const body = asRecord(request.body);
      if (body.confirmation !== `ROLLBACK ${change.recordId}`) {
        return reply.code(400).send({
          error: "confirmation_required",
          message: `回滚确认值必须精确等于 ROLLBACK ${change.recordId}`,
        });
      }
      const account = requireTencentDnsAccount(change.accountId);
      const credentials = dnsCredentials(account);
      const binding = dnsBindingFromChange(change);
      const exact = await verifyRollbackRecord(
        credentials,
        binding,
        change.recordId,
      );
      if (!exact.ok) {
        audit(
          request.user.email,
          "cloud.dns.change.rolled_back",
          `${change.domain}/${change.subdomain} / ${change.id}`,
          "failed",
          dnsChangeAuditMetadata(change, {
            reason: "record_mismatch",
            detail: exact.detail,
          }),
        );
        return reply.code(409).send({
          error: "record_mismatch",
          message: `${exact.detail} 为防止误删其他解析，已停止回滚。`,
          change,
        });
      }
      const deleted = await deleteDnsPodRecord(
        credentials,
        change.domain,
        change.recordId,
      );
      const removed = await confirmRollbackRecordRemoved(
        credentials,
        change.domain,
        change.recordId,
      );
      if (!removed.ok) {
        audit(
          request.user.email,
          "cloud.dns.change.rolled_back",
          `${change.domain}/${change.subdomain} / ${change.id}`,
          "failed",
          dnsChangeAuditMetadata(change, {
            deleteRequestId: deleted.requestId,
            detail: removed.detail,
          }),
        );
        return reply.code(409).send({
          error: "rollback_verification_failed",
          message: removed.detail,
          deleteRequestId: deleted.requestId,
          change: getDnsChangeRequest(change.id),
        });
      }
      markDnsChangeRolledBack(change.id, deleted.requestId, {
        checkedAt: new Date().toISOString(),
        recordId: change.recordId,
        deleteRequestId: deleted.requestId,
        exactMatchVerified: true,
        removalVerified: true,
        detail: removed.detail,
      });
      const rolledBack = getDnsChangeRequest(change.id);
      if (rolledBack) {
        audit(
          request.user.email,
          "cloud.dns.change.rolled_back",
          `${change.domain}/${change.subdomain} / ${change.id}`,
          "success",
          dnsChangeAuditMetadata(rolledBack, {
            rollbackReason: "operator_requested",
          }),
        );
      }
      return { change: rolledBack };
    }),
  );

  app.post("/api/cloud/dns/changes/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const change = getDnsChangeRequest(id);
    if (!change) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "DNS 变更单不存在。" });
    }
    if (!cancelDnsChangeRequest(id)) {
      return reply.code(409).send({
        error: "invalid_state",
        message: "只有等待审批或已审批但未执行的变更单可以取消。",
      });
    }
    const cancelled = getDnsChangeRequest(id);
    if (cancelled) {
      audit(
        request.user.email,
        "cloud.dns.change.cancelled",
        `${cancelled.domain}/${cancelled.subdomain} / ${cancelled.id}`,
        "success",
        dnsChangeAuditMetadata(cancelled),
      );
    }
    return { change: cancelled };
  });

  app.post("/api/cloud/accounts", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      if (!isCloudProvider(body.provider)) {
        throw new Error("云厂商不合法。");
      }
      const name = validateName(body.name, "账号名称");
      const region = validateName(body.region, "地域");
      const accountType =
        body.accountType === "sub" ? "sub" : "main";
      const ownerId =
        typeof body.ownerId === "string"
          ? body.ownerId.trim().slice(0, 64)
          : "";
      if (ownerId && !/^[a-zA-Z0-9_-]{3,64}$/.test(ownerId)) {
        throw new Error("主账号 ID 格式不正确；可留空并在验证后自动核对。");
      }
      const accessKeyId = requiredString(body.accessKeyId, "API 密钥 ID", 128);
      if (!/^[a-zA-Z0-9_-]{3,128}$/.test(accessKeyId)) {
        throw new Error("API 密钥 ID 格式不正确。");
      }
      const secretKey = requiredString(body.secretKey, "API 密钥 Secret", 256);
      if (secretKey.length < 6) {
        throw new Error("API 密钥 Secret 长度不足。");
      }
      const note =
        typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      const id = createCloudAccount({
        name,
        provider: body.provider,
        region,
        accountType,
        ownerId,
        accessKeyId,
        secretKey,
        note,
      });
      audit(
        request.user.email,
        "cloud.account.created",
        `${name} / ${id}`,
        "success",
        { accountType, provider: body.provider },
      );
      return reply.code(201).send({ id });
    }),
  );

  app.patch("/api/cloud/accounts/:id", async (request, reply) =>
    handle(reply, () => {
      const params = request.params as { id: string };
      const body = asRecord(request.body);
      if (!isCloudProvider(body.provider)) {
        throw new Error("云厂商不合法。");
      }
      const name = validateName(body.name, "账号名称");
      const region = validateName(body.region, "地域");
      const accountType =
        body.accountType === "sub" ? "sub" : "main";
      const ownerId =
        typeof body.ownerId === "string"
          ? body.ownerId.trim().slice(0, 64)
          : "";
      if (ownerId && !/^[a-zA-Z0-9_-]{3,64}$/.test(ownerId)) {
        throw new Error("主账号 ID 格式不正确；可留空并在验证后自动核对。");
      }
      const accessKeyId = requiredString(body.accessKeyId, "API 密钥 ID", 128);
      if (!/^[a-zA-Z0-9_-]{3,128}$/.test(accessKeyId)) {
        throw new Error("API 密钥 ID 格式不正确。");
      }
      let secretKey = "";
      if (typeof body.secretKey === "string" && body.secretKey.trim()) {
        secretKey = body.secretKey.trim();
        if (secretKey.length < 6) {
          throw new Error("API 密钥 Secret 长度不足。");
        }
      }
      const note =
        typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      const updated = updateCloudAccount(params.id, {
        name,
        provider: body.provider,
        region,
        accountType,
        ownerId,
        accessKeyId,
        secretKey,
        note,
      });
      if (!updated) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "云账号不存在。" });
      }
      audit(
        request.user.email,
        "cloud.account.updated",
        `${name} / ${params.id}`,
        "success",
        { accountType, provider: body.provider },
      );
      return { ok: true };
    }),
  );

  app.get("/api/cloud/resources", async (request) => {
    const query = request.query as { accountId?: string };
    return {
      resources: listCloudResources(query.accountId || undefined),
    };
  });

  app.get("/api/cloud/lighthouse/:instanceId/firewall", async (request, reply) =>
    handle(reply, async () => {
      const { instanceId } = request.params as { instanceId: string };
      const query = request.query as {
        accountId?: string;
        region?: string;
        publicIp?: string;
      };
      const accountId = String(query.accountId ?? "");
      const account = accountId ? getCloudAccountSecret(accountId) : undefined;
      if (!account || account.provider !== "tencent") {
        return reply.code(404).send({ error: "not_found", message: "腾讯云账号不存在。" });
      }
      const region = String(query.region || account.region || "ap-guangzhou");
      const resolvedInstanceId = instanceId.startsWith("lhins-")
        ? instanceId
        : await resolveLighthouseInstanceId(
            { secretId: account.accessKeyId, secretKey: account.secretKey },
            region,
            String(query.publicIp || instanceId),
          );
      if (!resolvedInstanceId) {
        return reply.code(404).send({
          error: "not_found",
          message: "未找到对应的轻量应用服务器实例。",
        });
      }
      return {
        rules: await listLighthouseFirewallRules(
          { secretId: account.accessKeyId, secretKey: account.secretKey },
          region,
          resolvedInstanceId,
        ),
      };
    }),
  );

  app.post("/api/cloud/lighthouse/:instanceId/firewall/open", async (request, reply) =>
    handle(reply, async () => {
      const { instanceId } = request.params as { instanceId: string };
      const body = asRecord(request.body);
      const accountId = String(body.accountId ?? "");
      const account = accountId ? getCloudAccountSecret(accountId) : undefined;
      if (!account || account.provider !== "tencent") {
        return reply.code(404).send({ error: "not_found", message: "腾讯云账号不存在。" });
      }
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("端口号不正确。");
      }
      const region = String(body.region || account.region || "ap-guangzhou");
      const resolvedInstanceId = instanceId.startsWith("lhins-")
        ? instanceId
        : await resolveLighthouseInstanceId(
            { secretId: account.accessKeyId, secretKey: account.secretKey },
            region,
            String(body.publicIp || instanceId),
          );
      if (!resolvedInstanceId) {
        return reply.code(404).send({
          error: "not_found",
          message: "未找到对应的轻量应用服务器实例。",
        });
      }
      const result = await openLighthouseFirewallPort(
        { secretId: account.accessKeyId, secretKey: account.secretKey },
        region,
        resolvedInstanceId,
        port,
        String(body.description ?? ""),
      );
      audit(
        request.user.email,
        "cloud.lighthouse.firewall.open",
        `${resolvedInstanceId} / TCP ${port}`,
        "success",
        { added: result.added, region },
      );
      return result;
    }),
  );

  app.get(
    "/api/cloud/aliyun/instances/:instanceId/firewall",
    async (request, reply) =>
      handle(reply, async () => {
        const { instanceId } = request.params as { instanceId: string };
        if (!/^(?:i-[a-z0-9]+|(?:\d{1,3}\.){3}\d{1,3})$/i.test(instanceId)) {
          throw new Error("阿里云实例 ID 或公网 IP 格式不正确。");
        }
        const query = request.query as {
          accountId?: string;
          region?: string;
        };
        const account =
          (query.accountId
            ? getCloudAccountSecret(String(query.accountId))
            : undefined) ??
          listCloudAccounts()
            .filter((item) => item.provider === "aliyun")
            .map((item) => getCloudAccountSecret(item.id))
            .find(Boolean);
        if (!account || account.provider !== "aliyun") {
          return reply
            .code(404)
            .send({ error: "not_found", message: "阿里云账号不存在。" });
        }
        const region = String(query.region || account.region || "cn-hangzhou");
        return {
          groups: await listAliyunIngressRules(
            {
              accessKeyId: account.accessKeyId,
              secretKey: account.secretKey,
            },
            region,
            instanceId,
          ),
        };
      }),
  );

  app.post(
    "/api/cloud/aliyun/instances/:instanceId/firewall/open",
    async (request, reply) =>
      handle(reply, async () => {
        const { instanceId } = request.params as { instanceId: string };
        if (!/^(?:i-[a-z0-9]+|(?:\d{1,3}\.){3}\d{1,3})$/i.test(instanceId)) {
          throw new Error("阿里云实例 ID 或公网 IP 格式不正确。");
        }
        const body = asRecord(request.body);
        const account =
          (body.accountId
            ? getCloudAccountSecret(String(body.accountId))
            : undefined) ??
          listCloudAccounts()
            .filter((item) => item.provider === "aliyun")
            .map((item) => getCloudAccountSecret(item.id))
            .find(Boolean);
        if (!account || account.provider !== "aliyun") {
          return reply
            .code(404)
            .send({ error: "not_found", message: "阿里云账号不存在。" });
        }
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new Error("端口号不正确。");
        }
        const region = String(body.region || account.region || "cn-hangzhou");
        const result = await openAliyunSecurityGroupPort(
          {
            accessKeyId: account.accessKeyId,
            secretKey: account.secretKey,
          },
          region,
          instanceId,
          port,
          String(body.description ?? ""),
        );
        audit(
          request.user.email,
          "cloud.aliyun.firewall.open",
          `${instanceId} / TCP ${port}`,
          "success",
          { added: result.added, groups: result.changedGroups, region },
        );
        return result;
      }),
  );

  app.get("/api/apps", async () => ({
    types: listApplicationTypes(),
    applications: listApplications(),
  }));

  app.get("/api/apps/:id/runtime-env", async (request, reply) => {
    const remoteAddress = request.socket.remoteAddress ?? "";
    const isLoopback =
      remoteAddress === "127.0.0.1" ||
      remoteAddress === "::1" ||
      remoteAddress === "::ffff:127.0.0.1";
    if (!isLoopback) {
      return reply.code(403).send({
        error: "forbidden",
        message: "运行时密钥注入仅允许从控制面本机发起。",
      });
    }
    const { id } = request.params as { id: string };
    const application = getApplication(id);
    if (!application) {
      return reply.code(404).send({ error: "not_found", message: "应用不存在。" });
    }
    const envFile = getApplicationEnv(id);
    if (!envFile.trim()) {
      return reply.code(409).send({
        error: "env_not_configured",
        message: "应用尚未配置运行环境变量。",
      });
    }
    audit(
      request.user.email,
      "application.runtime_env.read",
      `${application.name} / ${id}`,
      "success",
      { purpose: "local_runtime_injection" },
    );
    reply.header("Cache-Control", "no-store");
    return { envFile };
  });

  app.get("/api/apps/:id/env", async (request, reply) => {
    const { id } = request.params as { id: string };
    const application = getApplication(id);
    if (!application) {
      return reply.code(404).send({ error: "not_found", message: "应用不存在。" });
    }
    return {
      status: getApplicationEnvStatus(id),
      envFile:
        typeof application.fields.envFile === "string"
          ? application.fields.envFile
          : "",
    };
  });

  app.put("/api/apps/:id/env", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const application = getApplication(id);
      if (!application) {
        return reply.code(404).send({ error: "not_found", message: "应用不存在。" });
      }
      const body = asRecord(request.body);
      const content = typeof body.content === "string" ? body.content : "";
      if (content.length > 20_000) {
        throw new Error("环境变量内容过长（最多 20000 字符）。");
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]?.trim() ?? "";
        if (!line || line.startsWith("#")) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
          throw new Error(`环境变量第 ${index + 1} 行格式不正确，应为 KEY=VALUE。`);
        }
      }
      const status = setApplicationEnv(id, content);
      audit(
        request.user.email,
        "application.env.updated",
        `${application.name} / ${id}`,
        "success",
        { variableCount: status.variableCount },
      );
      return { status };
    }),
  );

  app.get("/api/deployments", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
    return { deployments: listDeployments(limit) };
  });

  app.get("/api/monitoring/health", async () => {
    const checks = listHealthChecks();
    return {
      checks,
      summary: {
        total: checks.length,
        healthy: checks.filter((item) => item.status === "healthy").length,
        unhealthy: checks.filter((item) => item.status === "unhealthy").length,
      },
    };
  });

  app.get("/api/deployments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deployment = getDeployment(id);
    if (!deployment) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "部署任务不存在。" });
    }
    return { deployment };
  });

  app.post("/api/apps/:id/publish", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const application = getApplication(id);
      if (!application) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "应用不存在。" });
      }
      if (!application.repositoryId) {
        throw new Error("该应用还没有关联代码仓库，请先编辑应用选择仓库。");
      }
      const body = asRecord(request.body);
      if (!isEnvironment(body.environment)) {
        throw new Error("请选择发布环境。");
      }
      const repository = application.repositoryId
        ? getRepository(application.repositoryId)
        : undefined;
      const serverId = resolveDeliveryServer(listServerConnections(), {
        requested: typeof body.serverId === "string" ? body.serverId : "",
        preferredServerId: repository?.serverId,
      }).id;
      const server = getServerSecret(serverId);
      if (!server) {
        throw new Error("发布服务器不存在。");
      }
      const port = Number(application.fields.port ?? 80) || 80;
      const conflictingApp = listApplications().find(
        (item) =>
          item.id !== application.id &&
          Number(item.fields.port) === port,
      );
      if (conflictingApp) {
        throw new Error(
          `端口 ${port} 已被应用「${conflictingApp.name}」占用，请分配独立端口后再发布。`,
        );
      }
      const containerPort =
        Number(application.fields.containerPort ?? 80) || 80;
      const envFile =
        typeof application.fields.envFile === "string"
          ? application.fields.envFile.trim()
          : "";
      const volumes =
        typeof application.fields.volumes === "string"
          ? application.fields.volumes.trim()
          : "";
      const networkMode =
        application.fields.networkMode === "host" ? "host" : "bridge";
      const domain =
        typeof application.fields.domain === "string"
          ? application.fields.domain
              .trim()
              .replace(/^https?:\/\//i, "")
              .split("/")[0]
              ?.split(":")[0] ?? ""
          : "";
      const healthPath =
        typeof application.fields.healthPath === "string"
          ? application.fields.healthPath || "/"
          : "/";
      const deployment = createDeployment({
        appId: application.id,
        appName: application.name,
        repositoryId: application.repositoryId,
        repositoryName: application.repositoryName ?? "",
        serverId,
        serverName: server.name,
        environment: body.environment,
        port,
        containerPort,
        envFile,
        volumes,
        networkMode,
        domain,
        healthPath,
        triggeredBy: request.user.email,
      });
      audit(
        request.user.email,
        "deployment.started",
        `${application.name} / ${body.environment}`,
        "success",
        { deploymentId: deployment.id },
      );
      await runBuildAndPush({
        deploymentId: deployment.id,
        app: {
          id: application.id,
          name: application.name,
          fields: application.fields,
        },
        repositoryId: application.repositoryId,
        environment: body.environment,
      });
      return { deployment: getDeployment(deployment.id) };
    }),
  );

  app.post("/api/deployments/:id/approve", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const deployment = getDeployment(id);
      if (!deployment) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "部署任务不存在。" });
      }
      if (deployment.status !== "waiting_approval") {
        throw new Error("该部署任务不在等待审批状态。");
      }
      const application = getApplication(deployment.appId);
      if (!application) {
        throw new Error("应用不存在。");
      }
      audit(
        request.user.email,
        "deployment.approved",
        `${deployment.appName} / ${deployment.environment}`,
        "success",
        { deploymentId: deployment.id },
      );
      await deployContainer({
        deploymentId: deployment.id,
        app: {
          id: application.id,
          name: application.name,
          fields: application.fields,
        },
        repositoryId: deployment.repositoryId,
        environment: deployment.environment,
      }, request.user.email);
      return { deployment: getDeployment(deployment.id) };
    }),
  );

  app.post("/api/deployments/:id/cancel", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const deployment = getDeployment(id);
      if (!deployment) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "部署任务不存在。" });
      }
      if (deployment.status !== "waiting_approval") {
        throw new Error("只有等待审批的部署或回滚可以取消。");
      }
      const now = new Date().toISOString();
      const steps = deployment.steps.map((step) =>
        step.status === "pending" || step.status === "running"
          ? {
              ...step,
              status: "skipped" as const,
              finishedAt: now,
              result: "操作已由管理员取消",
            }
          : step,
      );
      updateDeployment(deployment.id, {
        status: "cancelled",
        steps,
        logs: [
          ...deployment.logs,
          {
            time: now,
            level: "warn",
            message: `操作已由 ${request.user.email} 取消，服务器未被修改`,
          },
        ],
        error: "",
        finishedAt: now,
      });
      audit(
        request.user.email,
        "deployment.cancelled",
        `${deployment.appName} / ${deployment.environment}`,
        "success",
        { deploymentId: deployment.id },
      );
      return { deployment: getDeployment(deployment.id) };
    }),
  );

  app.post("/api/apps/:id/rollbacks", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const application = getApplication(id);
      if (!application) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "应用不存在。" });
      }
      const body = asRecord(request.body);
      const targetDeploymentId =
        typeof body.targetDeploymentId === "string"
          ? body.targetDeploymentId.trim()
          : "";
      if (!targetDeploymentId) {
        throw new Error("请选择要回滚的历史版本。");
      }
      const deployment = prepareRollback({
        application,
        targetDeploymentId,
        actor: request.user.email,
      });
      audit(
        request.user.email,
        "deployment.rollback_requested",
        `${application.name} / ${deployment.environment}`,
        "success",
        {
          deploymentId: deployment.id,
          targetDeploymentId,
          targetImage: deployment.imageTag,
        },
      );
      return { deployment };
    }),
  );

  app.post("/api/agent/tokens", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const name = validateName(body.name, "智能体名称");
      const result = createAgentToken(name);
      audit(
        request.user.email,
        "agent.token.created",
        name,
        "success",
        { id: result.record.id },
      );
      return result;
    }),
  );

  app.get("/api/agent/tokens", async () => ({
    tokens: listAgentTokens(),
  }));

  app.post("/api/agent/tokens/:id/revoke", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const revoked = revokeAgentToken(id);
      if (!revoked) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "令牌不存在或已撤销。" });
      }
      audit(request.user.email, "agent.token.revoked", id, "success");
      return { ok: true };
    }),
  );

  app.patch("/api/agent/tokens/:id", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const body = asRecord(request.body);
      const name = validateName(body.name, "智能体名称");
      if (!renameAgentToken(id, name)) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "令牌不存在。" });
      }
      audit(request.user.email, "agent.token.renamed", id, "success", {
        name,
      });
      return { ok: true, name };
    }),
  );

  app.delete("/api/agent/tokens/:id", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const record = listAgentTokens().find((item) => item.id === id);
      if (!record) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "令牌不存在。" });
      }
      if (!record.revoked) {
        return reply.code(409).send({
          error: "conflict",
          message: "请先撤销该令牌，再删除记录。",
        });
      }
      deleteAgentToken(id);
      audit(request.user.email, "agent.token.deleted", id, "success");
      return { ok: true };
    }),
  );

  app.post("/api/agent/deliver", async (request, reply) =>
    handle(reply, async () => {
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const agent = findAgentByToken(token);
      if (!agent) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "智能体令牌无效。",
        });
      }
      const body = asRecord(request.body);
      const environment =
        body.environment === "development" ||
        body.environment === "staging" ||
        body.environment === "production"
          ? body.environment
          : "staging";
      const normalizeUrl = (value: string) =>
        value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
      const repositoryUrl =
        typeof body.repositoryUrl === "string"
          ? normalizeUrl(body.repositoryUrl)
          : "";
      const repositoryName =
        typeof body.repositoryName === "string"
          ? body.repositoryName.trim()
          : "";
      const repositories = listRepositories();
      const repository = repositoryUrl
        ? repositories.find(
            (item) => normalizeUrl(item.url) === repositoryUrl,
          )
        : repositories.find((item) => item.name === repositoryName);
      if (!repository) {
        throw new Error(
          "仓库未登记：请先在 AI DevOps“代码仓库”中接入该仓库（或提供正确的 repositoryUrl / repositoryName）。",
        );
      }
      const appName =
        typeof body.appName === "string" && body.appName.trim()
          ? body.appName.trim().slice(0, 80)
          : repository.name;
      let application = listApplications().find(
        (item) => item.name === appName,
      );
      if (!application) {
        const usedPorts = new Set(
          listApplications()
            .map((item) => Number(item.fields.port))
            .filter((port) => Number.isFinite(port) && port > 0),
        );
        let port = 8100;
        while (usedPorts.has(port) && port < 8400) port += 1;
        application = createApplication({
          name: appName,
          appType: "web",
          repositoryId: repository.id,
          targetProvider: "tencent",
          environment: environment === "production" ? "staging" : environment,
          fields: {
            runtimeKind: "static",
            domain: "",
            port,
            healthPath: "/",
            buildOutput: "dist",
          },
        });
      }
      const requestedServer =
        [
          typeof body.serverId === "string" ? body.serverId : "",
          typeof body.serverName === "string" ? body.serverName : "",
          typeof body.serverHost === "string" ? body.serverHost : "",
        ].find((value) => value.trim()) ?? "";
      const server = resolveDeliveryServer(listServerConnections(), {
        requested: requestedServer,
        preferredServerId: repository.serverId,
      });
      const port = Number(application.fields.port ?? 80) || 80;
      const containerPort = Number(application.fields.containerPort ?? 80) || 80;
      const envFile =
        typeof application.fields.envFile === "string"
          ? application.fields.envFile.trim()
          : "";
      const volumes =
        typeof application.fields.volumes === "string"
          ? application.fields.volumes.trim()
          : "";
      const networkMode =
        application.fields.networkMode === "host" ? "host" : "bridge";
      const domain =
        typeof application.fields.domain === "string"
          ? application.fields.domain
              .trim()
              .replace(/^https?:\/\//i, "")
              .split("/")[0]
              ?.split(":")[0] ?? ""
          : "";
      const healthPath =
        typeof application.fields.healthPath === "string"
          ? application.fields.healthPath || "/"
          : "/";
      const deployment = createDeployment({
        appId: application.id,
        appName: application.name,
        repositoryId: repository.id,
        repositoryName: repository.name,
        serverId: server.id,
        serverName: server.name,
        environment,
        port,
        containerPort,
        envFile,
        volumes,
        networkMode,
        domain,
        healthPath,
        agentId: agent.id,
      });
      audit(
        agent.name,
        "agent.deliver",
        `${application.name} / ${environment}`,
        "success",
        { deploymentId: deployment.id, repository: repository.name },
      );
      await runBuildAndPush({
        deploymentId: deployment.id,
        app: {
          id: application.id,
          name: application.name,
          fields: application.fields,
        },
        repositoryId: repository.id,
        environment,
      });
      const result = getDeployment(deployment.id);
      return {
        deployment: result,
        message:
          result?.status === "waiting_approval"
            ? "已构建并推送镜像，生产部署等待管理员在 AI DevOps 中审批。"
            : result?.status === "succeeded"
              ? `已自动部署成功，端口 ${result.port}${result.healthPath}。`
              : `发布失败：${result?.error ?? "未知原因"}`,
      };
    }),
  );

  app.get("/api/agent/status", async (request, reply) =>
    handle(reply, () => {
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const agent = findAgentByToken(token);
      if (!agent) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "智能体令牌无效。",
        });
      }
      return {
        agent: agent.name,
        deployments: listDeploymentsByAgent(agent.id, 20),
      };
    }),
  );

  app.get("/api/agent/resources", async (request, reply) =>
    handle(reply, () => {
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const agent = findAgentByToken(token);
      if (!agent) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "智能体令牌无效。",
        });
      }
      const query = request.query as { accountId?: unknown };
      if (
        query.accountId !== undefined &&
        (typeof query.accountId !== "string" ||
          query.accountId.length === 0 ||
          query.accountId.length > 100)
      ) {
        return reply.code(400).send({
          error: "bad_request",
          message: "accountId 格式不正确。",
        });
      }
      const resources = listCloudResources(query.accountId).map((resource) => ({
        id: resource.id,
        externalId: resource.externalId,
        resourceType: resource.resourceType,
        name: resource.name,
        status: resource.status,
        region: resource.region,
        tags: resource.tags,
        metrics: resource.metrics,
        metricsUpdatedAt: resource.metricsUpdatedAt,
        lastSeenAt: resource.lastSeenAt,
        accountId: resource.accountId,
        accountName: resource.accountName,
        provider: resource.provider,
      }));
      audit(
        agent.name,
        "agent.resources.read",
        query.accountId ?? "all",
        "success",
        { resourceCount: resources.length },
      );
      return { agent: agent.name, resources };
    }),
  );

  app.post("/api/apps", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const name = validateName(body.name, "应用名称");
      const appType = requiredString(body.appType, "应用类型", 60);
      const repositoryId =
        typeof body.repositoryId === "string" && body.repositoryId.trim()
          ? requiredString(body.repositoryId, "代码仓库", 100)
          : null;
      let targetProvider: string | null = null;
      if (typeof body.targetProvider === "string" && body.targetProvider.trim()) {
        if (!isCloudProvider(body.targetProvider)) {
          throw new Error("目标云厂商不合法。");
        }
        targetProvider = body.targetProvider;
      }
      const environment = body.environment ?? "staging";
      if (!isEnvironment(environment)) {
        throw new Error("目标环境不合法。");
      }
      const fields =
        body.fields && typeof body.fields === "object"
          ? (body.fields as Record<string, unknown>)
          : {};
      const application = createApplication({
        name,
        appType,
        repositoryId,
        targetProvider,
        environment,
        fields,
      });
      audit(
        request.user.email,
        "application.created",
        `${name} / ${appType}`,
        "success",
      );
      return reply.code(201).send({ application });
    }),
  );

  app.patch("/api/apps/:id", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      const body = asRecord(request.body);
      const name = validateName(body.name, "应用名称");
      const appType = requiredString(body.appType, "应用类型", 60);
      const repositoryId =
        typeof body.repositoryId === "string" && body.repositoryId.trim()
          ? requiredString(body.repositoryId, "代码仓库", 100)
          : null;
      let targetProvider: string | null = null;
      if (typeof body.targetProvider === "string" && body.targetProvider.trim()) {
        if (!isCloudProvider(body.targetProvider)) {
          throw new Error("目标云厂商不合法。");
        }
        targetProvider = body.targetProvider;
      }
      const environment = body.environment ?? "staging";
      if (!isEnvironment(environment)) {
        throw new Error("目标环境不合法。");
      }
      const fields =
        body.fields && typeof body.fields === "object"
          ? (body.fields as Record<string, unknown>)
          : {};
      const application = updateApplication(id, {
        name,
        appType,
        repositoryId,
        targetProvider,
        environment,
        fields,
      });
      if (!application) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "应用不存在。" });
      }
      audit(
        request.user.email,
        "application.updated",
        `${name} / ${id}`,
        "success",
      );
      return { application };
    }),
  );

  app.delete("/api/apps/:id", async (request, reply) =>
    handle(reply, () => {
      const { id } = request.params as { id: string };
      if (!deleteApplication(id)) {
        return reply.code(404).send({
          error: "not_found",
          message: "应用不存在，或演示应用不能删除。",
        });
      }
      audit(request.user.email, "application.deleted", id, "success");
      return { deleted: true };
    }),
  );

  app.post("/api/cloud/accounts/:id/verify", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const account = getCloudAccountSecret(id);
      if (!account) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "云账号不存在。" });
      }
      const adapter = cloudAdapters[account.provider];
      if (!adapter.verify) {
        throw new Error(
          `${adapter.label}的真实凭据验证尚未接入，请等待后续版本。`,
        );
      }
      try {
        const result = await adapter.verify({
          id: account.id,
          provider: account.provider,
          region: account.region,
          accountType: account.accountType,
          ownerId: account.ownerId,
          accessKeyId: account.accessKeyId,
          secretKey: account.secretKey,
          hasSecret: account.hasSecret,
        });
        updateCloudAccountStatus(account.id, "connected", result.detail);
        audit(
          request.user.email,
          "cloud.credentials.verified",
          `${account.name} / ${account.id}`,
          "success",
          { provider: account.provider },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "验证失败";
        updateCloudAccountStatus(account.id, "error", message);
        throw error;
      }
    }),
  );

  app.post("/api/cloud/scan-all", async (request) => {
    const accounts = listCloudAccounts();
    const results = await Promise.all(
      accounts.map(async (listed): Promise<CloudInventoryScanSummary> => {
        const account = getCloudAccountSecret(listed.id);
        if (!account) {
          return {
            ok: false,
            accountId: listed.id,
            accountName: listed.name,
            provider: listed.provider,
            live: false,
            resources: 0,
            domains: 0,
            cost: 0,
            warnings: ["云账号凭据不存在。"],
            scannedAt: new Date().toISOString(),
            error: "云账号凭据不存在。",
          };
        }
        try {
          return await scanCloudInventory(account, request.user.email);
        } catch (error) {
          const message = scanErrorMessage(error);
          return {
            ok: false,
            accountId: account.id,
            accountName: account.name,
            provider: account.provider,
            live: false,
            resources: 0,
            domains: 0,
            cost: 0,
            warnings: [message],
            scannedAt: new Date().toISOString(),
            error: message,
          };
        }
      }),
    );
    const successful = results.filter((result) => result.ok);
    const totals = {
      accounts: results.length,
      scannedAccounts: successful.length,
      failedAccounts: results.length - successful.length,
      resources: successful.reduce(
        (total, result) => total + result.resources,
        0,
      ),
      domains: successful.reduce((total, result) => total + result.domains, 0),
      warnings: results.reduce(
        (total, result) => total + result.warnings.length,
        0,
      ),
    };
    const scannedAt = new Date().toISOString();
    audit(
      request.user.email,
      "cloud.inventory.scanned_all",
      "全部云账号",
      totals.failedAccounts > 0 ? "partial" : "success",
      totals,
    );
    return { live: true, scannedAt, accounts: results, totals };
  });

  app.post("/api/cloud/accounts/:id/scan", async (request, reply) =>
    handle(reply, async () => {
      const { id } = request.params as { id: string };
      const account = getCloudAccountSecret(id);
      if (!account) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "云账号不存在。" });
      }
      const adapter = cloudAdapters[account.provider];
      const canLiveScan =
        account.hasSecret &&
        adapter.supportsReadInventory;
      if (canLiveScan) {
        return scanCloudInventory(account, request.user.email);
      }
      const result = refreshCloudAccount(id);
      if (!result) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "云账号不存在。" });
      }
      audit(
        request.user.email,
        "cloud.inventory.scanned",
        id,
        "success",
        result,
      );
      return {
        ...result,
        live: false,
        simulated: config.demoMode,
        scannedAt: new Date().toISOString(),
      };
    }),
  );

  app.get("/api/audit", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return {
      events: listAuditEvents(Number.isFinite(limit) ? limit : 50),
    };
  });

  app.get("/api/errors", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    return {
      events: listErrorEvents(Number.isFinite(limit) ? limit : 50),
    };
  });

  app.delete("/api/errors", async (request) => {
    const removed = clearErrorEvents();
    audit(
      request.user.email,
      "errors.clear",
      "故障诊断",
      "success",
      { removed },
    );
    return { removed };
  });

  app.post("/api/ai/chat", async (request, reply) =>
    handle(reply, async () => {
      const body = asRecord(request.body);
      if (!Array.isArray(body.messages)) {
        throw new Error("缺少对话消息。");
      }
      const messages = body.messages
        .slice(-12)
        .map((item) => {
          const message = asRecord(item);
          const role = message.role === "assistant" ? "assistant" : "user";
          const content = requiredString(
            message.content,
            "消息内容",
            4_000,
          );
          return { role, content } as const;
        });
      const result = await chat(messages);
      audit(
        request.user.email,
        "ai.chat",
        "AI Copilot",
        "success",
        { mode: result.mode },
      );
      return result;
    }),
  );

  app.get("/api/settings/git-credential", async () => ({
    credentials: listGitCredentials(),
  }));

  app.post("/api/settings/favicon", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const dataUrl = requiredString(body.dataUrl, "图标数据", 900_000);
      const match = dataUrl.match(
        /^data:(image\/(?:svg\+xml|png|x-icon));base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match) {
        throw new Error("只支持 SVG、PNG 或 ICO 格式的图标。");
      }
      const mime = match[1] ?? "";
      const buffer = Buffer.from(match[2] ?? "", "base64");
      if (buffer.length === 0 || buffer.length > 512_000) {
        throw new Error("图标文件不能超过 512KB。");
      }
      if (mime === "image/svg+xml") {
        const svgText = buffer.toString("utf8");
        if (/<script|onload\s*=|onerror\s*=/i.test(svgText)) {
          throw new Error("SVG 图标中不能包含脚本。");
        }
      }
      fs.mkdirSync(faviconDirectory, { recursive: true });
      for (const file of fs.readdirSync(faviconDirectory)) {
        if (file.startsWith("favicon.")) {
          fs.rmSync(path.join(faviconDirectory, file), { force: true });
        }
      }
      const extension =
        mime === "image/svg+xml" ? "svg" : mime === "image/png" ? "png" : "ico";
      const filename = `favicon.${extension}`;
      fs.writeFileSync(path.join(faviconDirectory, filename), buffer);
      fs.writeFileSync(
        faviconMetaPath,
        JSON.stringify({ filename, mime }),
      );
      audit(
        request.user.email,
        "settings.favicon.updated",
        filename,
        "success",
        { mime, size: buffer.length },
      );
      return { ok: true, mime, size: buffer.length };
    }),
  );

  app.delete("/api/settings/favicon", async (request, reply) =>
    handle(reply, () => {
      if (fs.existsSync(faviconDirectory)) {
        for (const file of fs.readdirSync(faviconDirectory)) {
          if (file.startsWith("favicon.")) {
            fs.rmSync(path.join(faviconDirectory, file), { force: true });
          }
        }
      }
      audit(
        request.user.email,
        "settings.favicon.reset",
        "default",
        "success",
      );
      return { ok: true };
    }),
  );

  app.post("/api/settings/git-credential", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const provider = requiredString(body.provider, "服务商", 40);
      const username = requiredString(body.username, "账号", 120);
      const password = requiredString(body.password, "密码/令牌", 300);
      const credential = upsertGitCredential({ provider, username, password });
      audit(
        request.user.email,
        "settings.git_credential.saved",
        provider,
        "success",
        { username },
      );
      return { credential };
    }),
  );

  app.get("/api/settings/registry", async () => ({
    credentials: listRegistryCredentials(),
  }));

  app.post("/api/settings/registry", async (request, reply) =>
    handle(reply, () => {
      const body = asRecord(request.body);
      const name = validateName(body.name, "凭据名称");
      const registry = requiredString(body.registry, "镜像仓库地址", 200);
      const username = requiredString(body.username, "用户名", 200);
      const password = requiredString(body.password, "密码/令牌", 300);
      const namespace =
        typeof body.namespace === "string"
          ? body.namespace.trim().slice(0, 100)
          : "";
      const credential = upsertRegistryCredential({
        name,
        registry,
        username,
        password,
        namespace,
      });
      audit(
        request.user.email,
        "settings.registry_credential.saved",
        registry,
        "success",
        { username },
      );
      return { credential };
    }),
  );

  app.get("/api/settings/status", async () => ({
    demoMode: config.demoMode,
    llmConfigured: isLlmConfigured,
    modelGateway: isLlmConfigured ? "已连接" : "本地安全分析",
    executionMode: "simulated",
    persistence: "SQLite · 单机模式",
    cloudAdapters: Object.values(cloudAdapters).map((adapter) => ({
      provider: adapter.provider,
      label: adapter.label,
      connected: adapter.supportsReadInventory,
    })),
    registryCredentials: listRegistryCredentials(),
    gitCredentials: listGitCredentials(),
  }));

  await registerDbRoutes(app);
  await registerServerRoutes(app);
}


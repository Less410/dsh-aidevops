import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CloudResourceResult } from "./cloud.js";
import type {
  DnsPreflightResult,
  DnsVerificationResult,
} from "./dnsChange.js";
import { config } from "./env.js";
import type {
  CloudProvider,
  EnvironmentName,
  LogLine,
  PipelineStep,
  RepositoryProvider,
  RunStatus,
} from "./types.js";

export interface RepositoryVersionRecord {
  id: string;
  branch: string;
  commitSha: string;
  message: string | null;
  syncedAt: string;
}

export interface RepositoryRecord {
  id: string;
  name: string;
  provider: RepositoryProvider;
  url: string;
  branch: string;
  status: string;
  serverId: string | null;
  serverName: string | null;
  hasToken: boolean;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  isDemo: boolean;
  createdAt: string;
  versions: RepositoryVersionRecord[];
}

interface RepositoryRow extends Omit<RepositoryRecord, "isDemo" | "versions"> {
  isDemo: number;
  tokenEnc?: string;
}

export interface PipelineRunRecord {
  id: string;
  status: RunStatus;
  commitSha: string | null;
  triggeredBy: string;
  riskLevel: "low" | "medium" | "high";
  steps: PipelineStep[];
  logs: LogLine[];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  pipelineId: string;
  pipelineName: string;
  environment: EnvironmentName;
  repositoryName: string;
}

interface RunRow
  extends Omit<PipelineRunRecord, "steps" | "logs"> {
  steps: string;
  logs: string;
}

export interface CloudAccountRecord {
  id: string;
  name: string;
  provider: CloudProvider;
  region: string;
  status: string;
  statusMessage: string;
  accountType: "main" | "sub";
  ownerId: string;
  accessKeyId: string;
  hasSecret: boolean;
  note: string;
  resourceCount: number;
  monthlyCost: number;
  lastScannedAt: string | null;
  isDemo: boolean;
  createdAt: string;
}

export type DnsChangeStatus =
  | "waiting_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "cancelled";

export interface DnsChangeRequestRecord {
  id: string;
  accountId: string;
  accountName: string;
  provider: CloudProvider;
  domain: string;
  subdomain: string;
  recordType: "A";
  targetValue: string;
  ttl: number;
  finalUrl: string;
  status: DnsChangeStatus;
  requestedBy: string;
  approvedBy: string;
  approvalNote: string;
  preflight: Record<string, unknown>;
  execution: Record<string, unknown>;
  verification: Record<string, unknown>;
  recordId: string;
  createRequestId: string;
  deleteRequestId: string;
  error: string;
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  completedAt: string | null;
  rolledBackAt: string | null;
  updatedAt: string;
}

interface CloudAccountRow
  extends Omit<CloudAccountRecord, "isDemo" | "hasSecret"> {
  isDemo: number;
  accessKeyEnc: string;
}

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'ready',
    last_commit TEXT,
    last_synced_at TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repository_versions (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    message TEXT,
    synced_at TEXT NOT NULL,
    UNIQUE(repository_id, commit_sha)
  );

  CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    environment TEXT NOT NULL,
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    steps TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
    status TEXT NOT NULL,
    commit_sha TEXT,
    triggered_by TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'low',
    steps TEXT NOT NULL,
    logs TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS cloud_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    region TEXT NOT NULL,
    status TEXT NOT NULL,
    credential_ref TEXT,
    resource_count INTEGER NOT NULL DEFAULT 0,
    monthly_cost REAL NOT NULL DEFAULT 0,
    last_scanned_at TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cloud_resources (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL,
    external_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    region TEXT NOT NULL,
    attributes TEXT NOT NULL DEFAULT '{}',
    tags_json TEXT NOT NULL DEFAULT '{}',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    metrics_updated_at TEXT,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dns_change_requests (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    domain TEXT NOT NULL,
    subdomain TEXT NOT NULL,
    record_type TEXT NOT NULL,
    target_value TEXT NOT NULL,
    ttl INTEGER NOT NULL,
    final_url TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    approved_by TEXT NOT NULL DEFAULT '',
    approval_note TEXT NOT NULL DEFAULT '',
    preflight_json TEXT NOT NULL DEFAULT '{}',
    execution_json TEXT NOT NULL DEFAULT '{}',
    verification_json TEXT NOT NULL DEFAULT '{}',
    record_id TEXT NOT NULL DEFAULT '',
    create_request_id TEXT NOT NULL DEFAULT '',
    delete_request_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    approved_at TEXT,
    executed_at TEXT,
    completed_at TEXT,
    rolled_back_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dns_change_requests_status
    ON dns_change_requests(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS cloud_change_requests (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    region TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    resource_name TEXT NOT NULL DEFAULT '',
    scope_tags_json TEXT NOT NULL DEFAULT '{}',
    action TEXT NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    approved_by TEXT NOT NULL DEFAULT '',
    approval_note TEXT NOT NULL DEFAULT '',
    preflight_json TEXT NOT NULL DEFAULT '{}',
    execution_json TEXT NOT NULL DEFAULT '{}',
    verification_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    approved_at TEXT,
    executed_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cloud_change_requests_status
    ON cloud_change_requests(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    app_type TEXT NOT NULL,
    repository_id TEXT REFERENCES repositories(id),
    target_provider TEXT,
    environment TEXT NOT NULL DEFAULT 'staging',
    fields_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'configured',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS application_env (
    application_id TEXT PRIMARY KEY,
    env_content_enc TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    result TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
`);

const cloudAccountColumns = new Set(
  (
    db.prepare("PRAGMA table_info(cloud_accounts)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name),
);
const cloudAccountMigrations: Array<[string, string]> = [
  ["account_type", "ALTER TABLE cloud_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'main'"],
  ["owner_id", "ALTER TABLE cloud_accounts ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''"],
  ["access_key_id", "ALTER TABLE cloud_accounts ADD COLUMN access_key_id TEXT NOT NULL DEFAULT ''"],
  ["access_key_enc", "ALTER TABLE cloud_accounts ADD COLUMN access_key_enc TEXT NOT NULL DEFAULT ''"],
  ["note", "ALTER TABLE cloud_accounts ADD COLUMN note TEXT NOT NULL DEFAULT ''"],
  ["status_message", "ALTER TABLE cloud_accounts ADD COLUMN status_message TEXT NOT NULL DEFAULT ''"],
];
for (const [columnName, statement] of cloudAccountMigrations) {
  if (!cloudAccountColumns.has(columnName)) {
    db.exec(statement);
  }
}

const cloudResourceColumns = new Set(
  (
    db.prepare("PRAGMA table_info(cloud_resources)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name),
);
for (const [columnName, statement] of [
  ["external_id", "ALTER TABLE cloud_resources ADD COLUMN external_id TEXT NOT NULL DEFAULT ''"],
  ["tags_json", "ALTER TABLE cloud_resources ADD COLUMN tags_json TEXT NOT NULL DEFAULT '{}'"],
  ["metrics_json", "ALTER TABLE cloud_resources ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '{}'"],
  ["metrics_updated_at", "ALTER TABLE cloud_resources ADD COLUMN metrics_updated_at TEXT"],
] as const) {
  if (!cloudResourceColumns.has(columnName)) {
    db.exec(statement);
  }
}
db.exec(`
  UPDATE cloud_resources SET external_id = id WHERE external_id = '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_resources_external
    ON cloud_resources(account_id, resource_type, region, external_id);
`);

const repositoryColumns = new Set(
  (
    db.prepare("PRAGMA table_info(repositories)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name),
);
if (!repositoryColumns.has("server_id")) {
  db.exec("ALTER TABLE repositories ADD COLUMN server_id TEXT");
}
if (!repositoryColumns.has("token_enc")) {
  db.exec(
    "ALTER TABLE repositories ADD COLUMN token_enc TEXT NOT NULL DEFAULT ''",
  );
}

const cloudSecretKey = crypto
  .createHash("sha256")
  .update(`${config.jwtSecret}:aidevops-cloudstore-v1`)
  .digest();

export function encryptCloudSecret(value: string): string {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cloudSecretKey, iv);
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

export function decryptCloudSecret(value: string): string {
  if (!value) return "";
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const iv = Buffer.from(parts[1] ?? "", "base64url");
    const tag = Buffer.from(parts[2] ?? "", "base64url");
    const data = Buffer.from(parts[3] ?? "", "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", cloudSecretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return "";
  }
}

const insertRepository = db.prepare(`
  INSERT OR IGNORE INTO repositories
  (id, name, provider, url, branch, status, last_commit, last_synced_at, is_demo, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertVersion = db.prepare(`
  INSERT OR IGNORE INTO repository_versions
  (id, repository_id, branch, commit_sha, message, synced_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertPipeline = db.prepare(`
  INSERT OR IGNORE INTO pipelines
  (id, name, repository_id, environment, trigger_type, steps, enabled, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertRun = db.prepare(`
  INSERT OR IGNORE INTO runs
  (id, pipeline_id, status, commit_sha, triggered_by, risk_level, steps, logs, started_at, finished_at, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertCloudAccount = db.prepare(`
  INSERT OR IGNORE INTO cloud_accounts
  (id, name, provider, region, status, resource_count, monthly_cost, last_scanned_at, is_demo, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertCloudResource = db.prepare(`
  INSERT INTO cloud_resources
  (id, account_id, resource_type, external_id, name, status, region,
   attributes, tags_json, metrics_json, metrics_updated_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_id, resource_type, region, external_id) DO UPDATE SET
    name = excluded.name,
    status = excluded.status,
    attributes = excluded.attributes,
    tags_json = CASE
      WHEN excluded.tags_json = '{}' THEN tags_json
      ELSE excluded.tags_json
    END,
    metrics_json = CASE
      WHEN excluded.metrics_json = '{}' THEN metrics_json
      ELSE excluded.metrics_json
    END,
    metrics_updated_at = CASE
      WHEN excluded.metrics_json = '{}' THEN metrics_updated_at
      ELSE excluded.metrics_updated_at
    END,
    last_seen_at = excluded.last_seen_at
`);

const insertAudit = db.prepare(`
  INSERT INTO audit_events
  (id, actor, action, target, result, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedDemoData(): void {
  if (!config.demoMode) {
    return;
  }
  const existing = db
    .prepare("SELECT COUNT(*) AS count FROM repositories")
    .get() as { count: number };
  if (existing.count > 0) {
    return;
  }

  const repos: Array<{
    id: string;
    name: string;
    provider: RepositoryProvider;
    url: string;
    branch: string;
    commit: string;
  }> = [
    {
      id: "repo-checkout",
      name: "checkout-service",
      provider: "github",
      url: "https://github.com/example/checkout-service.git",
      branch: "main",
      commit: "8f31c4a",
    },
    {
      id: "repo-console",
      name: "web-console",
      provider: "gitlab",
      url: "https://gitlab.com/example/web-console.git",
      branch: "main",
      commit: "3b7de19",
    },
    {
      id: "repo-gateway",
      name: "edge-gateway",
      provider: "gitea",
      url: "https://git.example.com/platform/edge-gateway.git",
      branch: "release",
      commit: "d04a7e2",
    },
  ];

  db.exec("BEGIN");
  try {
    repos.forEach((repo, index) => {
      const createdAt = isoMinutesAgo(60 * 24 * (4 - index));
      insertRepository.run(
        repo.id,
        repo.name,
        repo.provider,
        repo.url,
        repo.branch,
        "ready",
        repo.commit,
        isoMinutesAgo(18 + index * 14),
        1,
        createdAt,
      );
      insertVersion.run(
        crypto.randomUUID(),
        repo.id,
        repo.branch,
        repo.commit,
        index === 0 ? "feat: improve payment retry policy" : "chore: refresh release",
        isoMinutesAgo(18 + index * 14),
      );
    });

    const pipelineSteps = (environment: EnvironmentName): PipelineStep[] => [
      { name: "检出代码", description: "固定提交 SHA 并校验仓库", status: "pending" },
      { name: "质量门禁", description: "单测、SAST 与依赖扫描", status: "pending" },
      { name: "构建制品", description: "构建 OCI 镜像并生成 SBOM", status: "pending" },
      {
        name: environment === "production" ? "生产审批" : "滚动发布",
        description:
          environment === "production"
            ? "变更单与双人审批"
            : "部署至目标环境",
        status: "pending",
      },
      { name: "健康验证", description: "验证错误率、延迟与可用性", status: "pending" },
    ];

    const pipelines = [
      {
        id: "pipe-checkout-prod",
        name: "支付服务生产发布",
        repo: "repo-checkout",
        environment: "production" as const,
      },
      {
        id: "pipe-console-staging",
        name: "控制台预发交付",
        repo: "repo-console",
        environment: "staging" as const,
      },
      {
        id: "pipe-gateway-prod",
        name: "边缘网关安全发布",
        repo: "repo-gateway",
        environment: "production" as const,
      },
    ];

    pipelines.forEach((pipeline, index) => {
      insertPipeline.run(
        pipeline.id,
        pipeline.name,
        pipeline.repo,
        pipeline.environment,
        index === 1 ? "webhook" : "manual",
        JSON.stringify(pipelineSteps(pipeline.environment)),
        1,
        isoMinutesAgo(60 * 24 * 3),
      );
    });

    const completedSteps = (environment: EnvironmentName): PipelineStep[] =>
      pipelineSteps(environment).map((step, index) => ({
        ...step,
        status: index < 4 ? "succeeded" : "running",
        durationMs: 12_000 + index * 8_500,
      }));

    const failedSteps: PipelineStep[] = pipelineSteps("production").map(
      (step, index) => ({
        ...step,
        status: index < 2 ? "succeeded" : index === 2 ? "failed" : "skipped",
        durationMs: index < 2 ? 14_000 + index * 9_000 : 3_200,
      }),
    );

    const approvals: PipelineStep[] = pipelineSteps("production").map(
      (step, index) => ({
        ...step,
        status: index < 3 ? "succeeded" : "pending",
        durationMs: index < 3 ? 11_000 + index * 7_000 : undefined,
      }),
    );

    const successfulLogs: LogLine[] = [
      { time: isoMinutesAgo(9), level: "info", message: "固定 commit 8f31c4a 并完成仓库校验" },
      { time: isoMinutesAgo(8), level: "success", message: "单元测试 384/384 通过，SAST 无高危发现" },
      { time: isoMinutesAgo(6), level: "info", message: "镜像 sha256:91ac… 已推送，SBOM 已归档" },
      { time: isoMinutesAgo(4), level: "success", message: "灰度 10% -> 50% -> 100%，健康检查通过" },
    ];

    const failedLogs: LogLine[] = [
      { time: isoMinutesAgo(44), level: "info", message: "固定 commit d04a7e2，开始质量门禁" },
      { time: isoMinutesAgo(43), level: "error", message: "构建失败：找不到可选依赖 @gateway/tracing-lite" },
      { time: isoMinutesAgo(42), level: "warn", message: "该依赖仅出现在 edge/optional.ts，不在锁文件内" },
      { time: isoMinutesAgo(42), level: "info", message: "已停止后续步骤，未产生任何生产变更" },
    ];

    insertRun.run(
      "run-checkout-842",
      "pipe-checkout-prod",
      "succeeded",
      "8f31c4a",
      "演示用户",
      "medium",
      JSON.stringify(completedSteps("production")),
      JSON.stringify(successfulLogs),
      isoMinutesAgo(12),
      isoMinutesAgo(4),
      8 * 60_000,
    );
    insertRun.run(
      "run-gateway-139",
      "pipe-gateway-prod",
      "failed",
      "d04a7e2",
      "Codex Agent",
      "medium",
      JSON.stringify(failedSteps),
      JSON.stringify(failedLogs),
      isoMinutesAgo(46),
      isoMinutesAgo(42),
      4 * 60_000,
    );
    insertRun.run(
      "run-console-321",
      "pipe-console-staging",
      "succeeded",
      "3b7de19",
      "Webhook",
      "low",
      JSON.stringify(completedSteps("staging")),
      JSON.stringify(successfulLogs.slice(0, 3)),
      isoMinutesAgo(62),
      isoMinutesAgo(57),
      5 * 60_000,
    );
    insertRun.run(
      "run-checkout-843",
      "pipe-checkout-prod",
      "waiting_approval",
      "1a909bf",
      "演示用户",
      "high",
      JSON.stringify(approvals),
      JSON.stringify([
        ...successfulLogs.slice(0, 3),
        {
          time: isoMinutesAgo(2),
          level: "warn",
          message: "生产发布等待审批：变更涉及支付重试策略",
        },
      ]),
      isoMinutesAgo(3),
      null,
      null,
    );

    const accounts = [
      {
        id: "cloud-tencent",
        name: "腾讯云 · 生产",
        provider: "tencent" as const,
        region: "ap-shanghai",
        cost: 12840,
        count: 24,
      },
      {
        id: "cloud-aliyun",
        name: "阿里云 · 数据平台",
        provider: "aliyun" as const,
        region: "cn-hangzhou",
        cost: 18620,
        count: 31,
      },
      {
        id: "cloud-huawei",
        name: "华为云 · 灾备",
        provider: "huawei" as const,
        region: "cn-east-3",
        cost: 7260,
        count: 12,
      },
    ];

    accounts.forEach((account, index) => {
      insertCloudAccount.run(
        account.id,
        account.name,
        account.provider,
        account.region,
        "demo",
        account.count,
        account.cost,
        isoMinutesAgo(10 + index * 8),
        1,
        isoMinutesAgo(60 * 24 * 60),
      );
    });

    const resources = [
      ["res-tke-prod", "cloud-tencent", "TKE", "prod-shanghai-01", "healthy", "ap-shanghai"],
      ["res-cvm-api", "cloud-tencent", "CVM", "api-worker-03", "healthy", "ap-shanghai"],
      ["res-clb-edge", "cloud-tencent", "CLB", "gateway-public", "warning", "ap-shanghai"],
      ["res-ack-data", "cloud-aliyun", "ACK", "data-hangzhou-01", "healthy", "cn-hangzhou"],
      ["res-ecs-jobs", "cloud-aliyun", "ECS", "batch-jobs-08", "healthy", "cn-hangzhou"],
      ["res-rds-core", "cloud-aliyun", "RDS", "core-mysql-primary", "healthy", "cn-hangzhou"],
      ["res-cce-dr", "cloud-huawei", "CCE", "dr-east-01", "healthy", "cn-east-3"],
      ["res-obs-backup", "cloud-huawei", "OBS", "finance-backup", "healthy", "cn-east-3"],
    ] as const;

    resources.forEach(([id, accountId, type, name, status, region]) => {
      upsertCloudResource.run(
        id,
        accountId,
        type,
        id,
        name,
        status,
        region,
        JSON.stringify({ demo: true, health: status === "healthy" ? 99.99 : 97.31 }),
        "{}",
        "{}",
        null,
        isoMinutesAgo(12),
      );
    });

    const audits = [
      ["演示用户", "pipeline.approved", "支付服务生产发布 / #842", "success", 5],
      ["Codex Agent", "pipeline.failed", "边缘网关安全发布 / #139", "failed", 42],
      ["系统", "cloud.inventory.scanned", "腾讯云 · 生产", "success", 58],
      ["Webhook", "repository.push", "web-console / 3b7de19", "success", 62],
    ] as const;
    audits.forEach(([actor, action, target, result, minutes]) => {
      insertAudit.run(
        crypto.randomUUID(),
        actor,
        action,
        target,
        result,
        "{}",
        isoMinutesAgo(minutes),
      );
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

seedDemoData();

function purgeDemoData(): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      DELETE FROM runs WHERE pipeline_id IN (
        SELECT p.id FROM pipelines p
        JOIN repositories r ON r.id = p.repository_id
        WHERE r.is_demo = 1
      );
      DELETE FROM pipelines WHERE repository_id IN (
        SELECT id FROM repositories WHERE is_demo = 1
      );
      DELETE FROM repository_versions WHERE repository_id IN (
        SELECT id FROM repositories WHERE is_demo = 1
      );
      DELETE FROM applications WHERE is_demo = 1;
      DELETE FROM applications WHERE repository_id IN (
        SELECT id FROM repositories WHERE is_demo = 1
      );
      DELETE FROM repositories WHERE is_demo = 1;
      DELETE FROM cloud_resources WHERE account_id IN (
        SELECT id FROM cloud_accounts WHERE is_demo = 1
      );
      DELETE FROM cloud_accounts WHERE is_demo = 1;
      DELETE FROM audit_events WHERE target IN (
        '支付服务生产发布 / #842',
        '边缘网关安全发布 / #139',
        '腾讯云 · 生产',
        'web-console / 3b7de19'
      );
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (!config.demoMode) {
  purgeDemoData();
}

export function audit(
  actor: string,
  action: string,
  target: string,
  result: string,
  metadata: Record<string, unknown> = {},
): void {
  insertAudit.run(
    crypto.randomUUID(),
    actor,
    action,
    target,
    result,
    JSON.stringify(metadata),
    new Date().toISOString(),
  );
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function listRepositories(): RepositoryRecord[] {
  return db
    .prepare(`
      SELECT
        repositories.id, repositories.name, repositories.provider,
        repositories.url, repositories.branch, repositories.status,
        repositories.server_id AS serverId,
        servers.name AS serverName,
        CASE WHEN repositories.token_enc <> '' THEN 1 ELSE 0 END AS hasToken,
        repositories.last_commit AS lastCommit,
        repositories.last_synced_at AS lastSyncedAt,
        repositories.is_demo AS isDemo,
        repositories.created_at AS createdAt
      FROM repositories
      LEFT JOIN cloud_servers servers ON servers.id = repositories.server_id
      ORDER BY repositories.created_at ASC
    `)
    .all()
    .map((rawRow) => {
      const row = rawRow as unknown as RepositoryRow;
      return {
        ...row,
        isDemo: Boolean(row.isDemo),
        hasToken: Boolean(row.hasToken),
        versions: db
        .prepare(`
          SELECT id, branch, commit_sha AS commitSha, message, synced_at AS syncedAt
          FROM repository_versions
          WHERE repository_id = ?
          ORDER BY synced_at DESC
          LIMIT 5
        `)
          .all(row.id) as unknown as RepositoryVersionRecord[],
      };
    });
}

export function getRepository(
  id: string,
): Omit<RepositoryRecord, "versions"> | undefined {
  const row = db
    .prepare(`
      SELECT
        id, name, provider, url, branch, status,
        server_id AS serverId,
        CASE WHEN token_enc <> '' THEN 1 ELSE 0 END AS hasToken,
        last_commit AS lastCommit,
        last_synced_at AS lastSyncedAt,
        is_demo AS isDemo,
        created_at AS createdAt
      FROM repositories
      WHERE id = ?
    `)
    .get(id) as unknown as RepositoryRow | undefined;
  if (!row) {
    return undefined;
  }
  return { ...row, isDemo: Boolean(row.isDemo), hasToken: Boolean(row.hasToken) };
}

export function createRepository(input: {
  name: string;
  provider: RepositoryProvider;
  url: string;
  branch: string;
  serverId: string | null;
  token: string;
}) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO repositories
    (id, name, provider, url, branch, status, server_id, token_enc,
     last_commit, last_synced_at, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, 0, ?)
  `).run(
    id,
    input.name,
    input.provider,
    input.url,
    input.branch,
    input.serverId,
    input.token ? encryptCloudSecret(input.token) : "",
    new Date().toISOString(),
  );
  return getRepository(id);
}

export function updateRepositoryInfo(
  id: string,
  input: {
    name: string;
    provider: RepositoryProvider;
    url: string;
    branch: string;
    serverId: string | null;
    token: string;
  },
): Omit<RepositoryRecord, "versions"> | undefined {
  const existing = db
    .prepare("SELECT token_enc FROM repositories WHERE id = ?")
    .get(id) as { token_enc: string } | undefined;
  if (!existing) return undefined;
  const tokenEnc = input.token
    ? encryptCloudSecret(input.token)
    : existing.token_enc;
  db.prepare(`
    UPDATE repositories
    SET name = ?, provider = ?, url = ?, branch = ?, server_id = ?, token_enc = ?
    WHERE id = ?
  `).run(
    input.name,
    input.provider,
    input.url,
    input.branch,
    input.serverId,
    tokenEnc,
    id,
  );
  return getRepository(id);
}

export function updateRepositoryAfterSync(
  id: string,
  commitSha: string,
  message: string,
): void {
  const now = new Date().toISOString();
  const repository = getRepository(id) as { branch: string } | undefined;
  if (!repository) {
    throw new Error("repository not found");
  }
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE repositories
      SET status = 'ready', last_commit = ?, last_synced_at = ?
      WHERE id = ?
    `).run(commitSha, now, id);
    insertVersion.run(
      crypto.randomUUID(),
      id,
      repository.branch,
      commitSha,
      message,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markRepositorySyncFailed(id: string): void {
  db.prepare("UPDATE repositories SET status = 'sync_error' WHERE id = ?").run(id);
}

export function getRepositoryAccess(id: string):
  | {
      url: string;
      provider: RepositoryProvider;
      branch: string;
      serverId: string | null;
      token: string;
    }
  | undefined {
  const row = db
    .prepare(
      `SELECT url, provider, branch, server_id AS serverId, token_enc AS tokenEnc
       FROM repositories WHERE id = ?`,
    )
    .get(id) as
    | {
        url: string;
        provider: string;
        branch: string;
        serverId: string | null;
        tokenEnc: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    url: row.url,
    provider: row.provider as RepositoryProvider,
    branch: row.branch,
    serverId: row.serverId,
    token: decryptCloudSecret(row.tokenEnc),
  };
}

export interface RegistryCredentialRecord {
  id: string;
  name: string;
  registry: string;
  username: string;
  namespace: string;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GitCredentialRecord {
  id: string;
  provider: string;
  username: string;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS registry_credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    registry TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    namespace TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS git_credentials (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export function upsertRegistryCredential(input: {
  name: string;
  registry: string;
  username: string;
  password: string;
  namespace: string;
}): RegistryCredentialRecord {
  const existing = db
    .prepare(
      "SELECT id FROM registry_credentials WHERE registry = ? AND username = ?",
    )
    .get(input.registry, input.username) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE registry_credentials SET name = ?, password_enc = ?, namespace = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      encryptCloudSecret(input.password),
      input.namespace,
      now,
      existing.id,
    );
  } else {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO registry_credentials
       (id, name, registry, username, password_enc, namespace, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.registry,
      input.username,
      encryptCloudSecret(input.password),
      input.namespace,
      now,
      now,
    );
  }
  return listRegistryCredentials().find(
    (item) =>
      item.registry === input.registry && item.username === input.username,
  ) as RegistryCredentialRecord;
}

export function listRegistryCredentials(): RegistryCredentialRecord[] {
  const rows = db
    .prepare("SELECT * FROM registry_credentials ORDER BY created_at ASC")
    .all() as unknown as Array<{
    id: string;
    name: string;
    registry: string;
    username: string;
    password_enc: string;
    namespace: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    registry: row.registry,
    username: row.username,
    namespace: row.namespace,
    hasPassword: row.password_enc.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getRegistryCredentialSecret(id: string):
  | {
      id: string;
      name: string;
      registry: string;
      username: string;
      password: string;
      namespace: string;
    }
  | undefined {
  const row = db
    .prepare("SELECT * FROM registry_credentials WHERE id = ?")
    .get(id) as
    | {
        id: string;
        name: string;
        registry: string;
        username: string;
        password_enc: string;
        namespace: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    registry: row.registry,
    username: row.username,
    password: decryptCloudSecret(row.password_enc),
    namespace: row.namespace,
  };
}

export function upsertGitCredential(input: {
  provider: string;
  username: string;
  password: string;
}): GitCredentialRecord {
  const existing = db
    .prepare("SELECT id FROM git_credentials WHERE provider = ?")
    .get(input.provider) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      "UPDATE git_credentials SET username = ?, password_enc = ?, updated_at = ? WHERE id = ?",
    ).run(input.username, encryptCloudSecret(input.password), now, existing.id);
  } else {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO git_credentials
       (id, provider, username, password_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.provider,
      input.username,
      encryptCloudSecret(input.password),
      now,
      now,
    );
  }
  return listGitCredentials().find(
    (item) => item.provider === input.provider,
  ) as GitCredentialRecord;
}

export function listGitCredentials(): GitCredentialRecord[] {
  const rows = db
    .prepare("SELECT * FROM git_credentials ORDER BY created_at ASC")
    .all() as unknown as Array<{
    id: string;
    provider: string;
    username: string;
    password_enc: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    username: row.username,
    hasPassword: row.password_enc.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getGitCredentialSecret(provider: string):
  | { username: string; password: string }
  | undefined {
  const row = db
    .prepare(
      "SELECT username, password_enc FROM git_credentials WHERE provider = ?",
    )
    .get(provider) as { username: string; password_enc: string } | undefined;
  if (!row) return undefined;
  return {
    username: row.username,
    password: decryptCloudSecret(row.password_enc),
  };
}

export interface DeploymentRecord {
  id: string;
  appId: string;
  appName: string;
  repositoryId: string;
  repositoryName: string;
  serverId: string;
  serverName: string;
  serverHost: string;
  environment: EnvironmentName;
  status:
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled";
  kind: "release" | "rollback" | "auto_rollback";
  targetDeploymentId: string;
  triggeredBy: string;
  approvedBy: string;
  imageTag: string;
  commitSha: string;
  port: number;
  containerPort: number;
  envFile: string;
  volumes: string;
  networkMode: string;
  domain: string;
  healthPath: string;
  steps: PipelineStep[];
  logs: LogLine[];
  error: string;
  previousImageTag: string;
  startedAt: string;
  finishedAt: string | null;
  approvedAt: string | null;
  agentName: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'release',
    target_deployment_id TEXT NOT NULL DEFAULT '',
    triggered_by TEXT NOT NULL DEFAULT '',
    approved_by TEXT NOT NULL DEFAULT '',
    image_tag TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 80,
    container_port INTEGER NOT NULL DEFAULT 80,
    env_file TEXT NOT NULL DEFAULT '',
    volumes TEXT NOT NULL DEFAULT '',
    network_mode TEXT NOT NULL DEFAULT 'bridge',
    domain TEXT NOT NULL DEFAULT '',
    health_path TEXT NOT NULL DEFAULT '/',
    steps TEXT NOT NULL DEFAULT '[]',
    logs TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    previous_image_tag TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    approved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS health_checks (
    deployment_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    server_id TEXT NOT NULL,
    port INTEGER NOT NULL,
    health_path TEXT NOT NULL DEFAULT '/',
    status TEXT NOT NULL DEFAULT 'unknown',
    http_status INTEGER NOT NULL DEFAULT 0,
    response_ms INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    checked_at TEXT NOT NULL
  );
`);

export interface HealthCheckRecord {
  deploymentId: string;
  appId: string;
  appName: string;
  serverId: string;
  port: number;
  healthPath: string;
  status: "healthy" | "unhealthy" | "unknown";
  httpStatus: number;
  responseMs: number;
  consecutiveFailures: number;
  message: string;
  checkedAt: string;
}

export function upsertHealthCheck(input: HealthCheckRecord): void {
  db.prepare(
    `INSERT INTO health_checks
     (deployment_id, app_id, app_name, server_id, port, health_path, status,
      http_status, response_ms, consecutive_failures, message, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(deployment_id) DO UPDATE SET
       status = excluded.status,
       http_status = excluded.http_status,
       response_ms = excluded.response_ms,
       consecutive_failures = excluded.consecutive_failures,
       message = excluded.message,
       checked_at = excluded.checked_at`,
  ).run(
    input.deploymentId,
    input.appId,
    input.appName,
    input.serverId,
    input.port,
    input.healthPath,
    input.status,
    input.httpStatus,
    input.responseMs,
    input.consecutiveFailures,
    input.message,
    input.checkedAt,
  );
}

export function listHealthChecks(): HealthCheckRecord[] {
  const rows = db
    .prepare("SELECT * FROM health_checks ORDER BY checked_at DESC")
    .all() as unknown as Array<{
    deployment_id: string;
    app_id: string;
    app_name: string;
    server_id: string;
    port: number;
    health_path: string;
    status: string;
    http_status: number;
    response_ms: number;
    consecutive_failures: number;
    message: string;
    checked_at: string;
  }>;
  return rows.map((row) => ({
    deploymentId: row.deployment_id,
    appId: row.app_id,
    appName: row.app_name,
    serverId: row.server_id,
    port: row.port,
    healthPath: row.health_path,
    status:
      row.status === "healthy" || row.status === "unhealthy"
        ? row.status
        : "unknown",
    httpStatus: row.http_status,
    responseMs: row.response_ms,
    consecutiveFailures: row.consecutive_failures,
    message: row.message,
    checkedAt: row.checked_at,
  }));
}

const deploymentColumns = new Set(
  (
    db.prepare("PRAGMA table_info(deployments)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name),
);
if (!deploymentColumns.has("agent_id")) {
  db.exec("ALTER TABLE deployments ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
}
for (const [column, ddl] of [
  ["kind", "kind TEXT NOT NULL DEFAULT 'release'"],
  [
    "target_deployment_id",
    "target_deployment_id TEXT NOT NULL DEFAULT ''",
  ],
  ["triggered_by", "triggered_by TEXT NOT NULL DEFAULT ''"],
  ["approved_by", "approved_by TEXT NOT NULL DEFAULT ''"],
  ["container_port", "container_port INTEGER NOT NULL DEFAULT 80"],
  ["env_file", "env_file TEXT NOT NULL DEFAULT ''"],
  ["volumes", "volumes TEXT NOT NULL DEFAULT ''"],
  ["network_mode", "network_mode TEXT NOT NULL DEFAULT 'bridge'"],
  ["domain", "domain TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!deploymentColumns.has(column)) {
    db.exec(`ALTER TABLE deployments ADD COLUMN ${ddl}`);
  }
}

export function createDeployment(input: {
  appId: string;
  appName: string;
  repositoryId: string;
  repositoryName: string;
  serverId: string;
  serverName: string;
  environment: EnvironmentName;
  port: number;
  containerPort?: number;
  envFile?: string;
  volumes?: string;
  networkMode?: string;
  domain?: string;
  healthPath: string;
  agentId?: string;
  kind?: DeploymentRecord["kind"];
  targetDeploymentId?: string;
  triggeredBy?: string;
}): DeploymentRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deployments
     (id, app_id, repository_id, server_id, environment, status, kind,
      target_deployment_id, triggered_by, port,
      container_port, env_file, volumes, network_mode, domain, health_path,
      agent_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.appId,
    input.repositoryId,
    input.serverId,
    input.environment,
    input.kind ?? "release",
    input.targetDeploymentId ?? "",
    input.triggeredBy ?? "",
    input.port,
    input.containerPort ?? 80,
    input.envFile ?? "",
    input.volumes ?? "",
    input.networkMode ?? "bridge",
    input.domain ?? "",
    input.healthPath,
    input.agentId ?? "",
    now,
  );
  return getDeployment(id) as DeploymentRecord;
}

export function getDeployment(id: string): DeploymentRecord | undefined {
  const row = db
    .prepare(
      `SELECT d.*, a.name AS app_name, r.name AS repository_name, s.name AS server_name, s.host AS server_host
       FROM deployments d
       LEFT JOIN applications a ON a.id = d.app_id
       LEFT JOIN repositories r ON r.id = d.repository_id
       LEFT JOIN cloud_servers s ON s.id = d.server_id
       WHERE d.id = ?`,
    )
    .get(id) as
    | {
        id: string;
        app_id: string;
        repository_id: string;
        server_id: string;
        environment: string;
        status: string;
        kind: string;
        target_deployment_id: string;
        triggered_by: string;
        approved_by: string;
        image_tag: string;
        commit_sha: string;
        port: number;
        container_port: number;
        env_file: string;
        volumes: string;
        network_mode: string;
        domain: string;
        health_path: string;
        steps: string;
        logs: string;
        error: string;
        previous_image_tag: string;
        started_at: string;
        finished_at: string | null;
        approved_at: string | null;
        agent_id: string;
        app_name: string | null;
        repository_name: string | null;
        server_name: string | null;
        server_host: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    appId: row.app_id,
    appName: row.app_name ?? "",
    repositoryId: row.repository_id,
    repositoryName: row.repository_name ?? "",
    serverId: row.server_id,
    serverName: row.server_name ?? "",
    serverHost: row.server_host ?? "",
    environment: row.environment as EnvironmentName,
    status: row.status as DeploymentRecord["status"],
    kind:
      row.kind === "rollback" || row.kind === "auto_rollback"
        ? row.kind
        : "release",
    targetDeploymentId: row.target_deployment_id,
    triggeredBy: row.triggered_by,
    approvedBy: row.approved_by,
    imageTag: row.image_tag,
    commitSha: row.commit_sha,
    port: row.port,
    containerPort: row.container_port,
    envFile: row.env_file,
    volumes: row.volumes,
    networkMode: row.network_mode,
    domain: row.domain,
    healthPath: row.health_path,
    steps: parseJson<PipelineStep[]>(row.steps, []),
    logs: parseJson<LogLine[]>(row.logs, []),
    error: row.error,
    previousImageTag: row.previous_image_tag,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    approvedAt: row.approved_at,
    agentName: "",
  };
}

export function listDeployments(limit = 20): DeploymentRecord[] {
  const rows = db
    .prepare("SELECT id FROM deployments ORDER BY started_at DESC LIMIT ?")
    .all(limit) as unknown as Array<{ id: string }>;
  return rows
    .map((row) => getDeployment(row.id))
    .filter((item): item is DeploymentRecord => Boolean(item));
}

export function listDeploymentsByAgent(
  agentId: string,
  limit = 20,
): DeploymentRecord[] {
  const rows = db
    .prepare(
      `SELECT id FROM deployments WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as unknown as Array<{ id: string }>;
  return rows
    .map((row) => getDeployment(row.id))
    .filter((item): item is DeploymentRecord => Boolean(item));
}

export interface AgentTokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createAgentToken(name: string): {
  token: string;
  record: AgentTokenRecord;
} {
  const id = crypto.randomUUID();
  const token = `aid_${crypto.randomBytes(32).toString("base64url")}`;
  db.prepare(
    `INSERT INTO agent_tokens (id, name, token_hash, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, name, hashAgentToken(token), new Date().toISOString());
  const row = db
    .prepare(
      `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at
       FROM agent_tokens WHERE id = ?`,
    )
    .get(id) as {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    revoked_at: string | null;
  };
  return {
    token,
    record: {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revoked: Boolean(row.revoked_at),
    },
  };
}

export function listAgentTokens(): AgentTokenRecord[] {
  const rows = db
    .prepare(
      `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at
       FROM agent_tokens ORDER BY created_at DESC`,
    )
    .all() as unknown as Array<{
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    revoked_at: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revoked: Boolean(row.revoked_at),
  }));
}

export function revokeAgentToken(id: string): boolean {
  const result = db
    .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

/** Rename a token (active or revoked); the secret itself is never touched. */
export function renameAgentToken(id: string, name: string): boolean {
  const result = db
    .prepare("UPDATE agent_tokens SET name = ? WHERE id = ?")
    .run(name, id);
  return result.changes > 0;
}

/** Delete a revoked token record; an active token must be revoked first. */
export function deleteAgentToken(id: string): boolean {
  const result = db
    .prepare("DELETE FROM agent_tokens WHERE id = ? AND revoked_at IS NOT NULL")
    .run(id);
  return result.changes > 0;
}

export function findAgentByToken(token: string):
  | { id: string; name: string }
  | undefined {
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT id, name FROM agent_tokens
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .get(hashAgentToken(token)) as { id: string; name: string } | undefined;
  if (!row) return undefined;
  db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id,
  );
  return row;
}

export function updateDeployment(
  id: string,
  patch: {
    status?: DeploymentRecord["status"];
    imageTag?: string;
    commitSha?: string;
    steps?: PipelineStep[];
    logs?: LogLine[];
    error?: string;
    previousImageTag?: string;
    finishedAt?: string | null;
    approvedAt?: string | null;
    approvedBy?: string;
  },
): void {
  const current = getDeployment(id);
  if (!current) return;
  db.prepare(
    `UPDATE deployments SET
       status = ?, image_tag = ?, commit_sha = ?, steps = ?, logs = ?,
       error = ?, previous_image_tag = ?, finished_at = ?, approved_at = ?,
       approved_by = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.imageTag ?? current.imageTag,
    patch.commitSha ?? current.commitSha,
    JSON.stringify(patch.steps ?? current.steps),
    JSON.stringify(patch.logs ?? current.logs),
    patch.error ?? current.error,
    patch.previousImageTag ?? current.previousImageTag,
    patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
    patch.approvedAt === undefined ? current.approvedAt : patch.approvedAt,
    patch.approvedBy ?? current.approvedBy,
    id,
  );
}

export function getLastSucceededDeployment(
  appId: string,
  environment?: EnvironmentName,
): DeploymentRecord | undefined {
  const row = (environment
    ? db
        .prepare(
          `SELECT id FROM deployments
           WHERE app_id = ? AND environment = ? AND status = 'succeeded'
             AND image_tag <> ''
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(appId, environment)
    : db
        .prepare(
          `SELECT id FROM deployments
           WHERE app_id = ? AND status = 'succeeded' AND image_tag <> ''
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(appId)) as { id: string } | undefined;
  return row ? getDeployment(row.id) : undefined;
}

export function findSucceededDeploymentByImage(
  appId: string,
  imageTag: string,
  environment?: EnvironmentName,
): DeploymentRecord | undefined {
  if (!imageTag) return undefined;
  const row = (environment
    ? db
        .prepare(
          `SELECT id FROM deployments
           WHERE app_id = ? AND environment = ? AND status = 'succeeded'
             AND image_tag = ?
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(appId, environment, imageTag)
    : db
        .prepare(
          `SELECT id FROM deployments
           WHERE app_id = ? AND status = 'succeeded' AND image_tag = ?
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(appId, imageTag)) as { id: string } | undefined;
  return row ? getDeployment(row.id) : undefined;
}

export function listPipelines() {
  return db
    .prepare(`
      SELECT
        p.id, p.name, p.environment, p.trigger_type AS triggerType,
        p.steps, p.enabled, p.created_at AS createdAt,
        r.id AS repositoryId, r.name AS repositoryName,
        r.last_commit AS lastCommit
      FROM pipelines p
      JOIN repositories r ON r.id = p.repository_id
      ORDER BY p.created_at ASC
    `)
    .all()
    .map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      steps: parseJson<PipelineStep[]>(String(row.steps), []),
    }));
}

export function getPipeline(id: string) {
  const row = db
    .prepare(`
      SELECT
        p.id, p.name, p.environment, p.trigger_type AS triggerType,
        p.steps, p.enabled, p.repository_id AS repositoryId,
        r.name AS repositoryName, r.last_commit AS lastCommit
      FROM pipelines p
      JOIN repositories r ON r.id = p.repository_id
      WHERE p.id = ?
    `)
    .get(id);
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    enabled: Boolean(row.enabled),
    steps: parseJson<PipelineStep[]>(String(row.steps), []),
  };
}

export function createPipeline(input: {
  name: string;
  repositoryId: string;
  environment: EnvironmentName;
  stepNames: string[];
}): string {
  const id = crypto.randomUUID();
  const steps: PipelineStep[] = input.stepNames.map((name) => ({
    name,
    status: "pending",
  }));
  db.prepare(`
    INSERT INTO pipelines
    (id, name, repository_id, environment, trigger_type, steps, enabled, created_at)
    VALUES (?, ?, ?, ?, 'manual', ?, 1, ?)
  `).run(
    id,
    input.name,
    input.repositoryId,
    input.environment,
    JSON.stringify(steps),
    new Date().toISOString(),
  );
  return id;
}

export function listRuns(limit = 20): PipelineRunRecord[] {
  return db
    .prepare(`
      SELECT
        run.id, run.status, run.commit_sha AS commitSha,
        run.triggered_by AS triggeredBy, run.risk_level AS riskLevel,
        run.steps, run.logs, run.started_at AS startedAt,
        run.finished_at AS finishedAt, run.duration_ms AS durationMs,
        pipeline.id AS pipelineId, pipeline.name AS pipelineName,
        pipeline.environment, repository.name AS repositoryName
      FROM runs run
      JOIN pipelines pipeline ON pipeline.id = run.pipeline_id
      JOIN repositories repository ON repository.id = pipeline.repository_id
      ORDER BY run.started_at DESC
      LIMIT ?
    `)
    .all(limit)
    .map((rawRow) => {
      const row = rawRow as unknown as RunRow;
      return {
        ...row,
        steps: parseJson<PipelineStep[]>(row.steps, []),
        logs: parseJson<LogLine[]>(row.logs, []),
      };
    });
}

export function getRun(id: string): PipelineRunRecord | undefined {
  return listRuns(200).find((run) => run.id === id);
}

export function createRun(pipelineId: string, actor: string): string {
  const pipeline = db
    .prepare(`
      SELECT p.name, p.environment, p.steps, r.last_commit AS commitSha
      FROM pipelines p
      JOIN repositories r ON r.id = p.repository_id
      WHERE p.id = ?
    `)
    .get(pipelineId) as
    | {
        name: string;
        environment: EnvironmentName;
        steps: string;
        commitSha: string | null;
      }
    | undefined;
  if (!pipeline) {
    throw new Error("pipeline not found");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const isProduction = pipeline.environment === "production";
  const steps = parseJson<PipelineStep[]>(pipeline.steps, []).map(
    (step, index) => ({
      ...step,
      status: isProduction
        ? index < 3
          ? ("succeeded" as const)
          : ("pending" as const)
        : ("succeeded" as const),
      durationMs: isProduction && index >= 3 ? undefined : 8_000 + index * 4_200,
    }),
  );
  const logs: LogLine[] = [
    { time: now, level: "info", message: "流水线已由受控模拟 Runner 接收" },
    {
      time: new Date().toISOString(),
      level: "success",
      message: `固定 commit ${pipeline.commitSha ?? "unknown"}`,
    },
    {
      time: new Date().toISOString(),
      level: "success",
      message: "质量门禁与制品构建通过（模拟结果）",
    },
  ];
  if (isProduction) {
    logs.push({
      time: new Date().toISOString(),
      level: "warn",
      message: "生产变更等待审批；当前未执行任何生产写入",
    });
  } else {
    steps.forEach((step) => {
      step.status = "succeeded";
    });
    logs.push({
      time: new Date().toISOString(),
      level: "success",
      message: "预发部署和健康验证通过（模拟结果）",
    });
  }

  insertRun.run(
    id,
    pipelineId,
    isProduction ? "waiting_approval" : "succeeded",
    pipeline.commitSha,
    actor,
    isProduction ? "high" : "low",
    JSON.stringify(steps),
    JSON.stringify(logs),
    now,
    isProduction ? null : new Date().toISOString(),
    isProduction ? null : 32_000,
  );
  audit(actor, "pipeline.started", `${pipeline.name} / ${id}`, "success", {
    pipelineId,
    environment: pipeline.environment,
  });
  return id;
}

export function approveRun(id: string, actor: string): boolean {
  const run = getRun(id) as
    | {
        status: RunStatus;
        pipelineName: string;
        environment: EnvironmentName;
        steps: PipelineStep[];
        logs: LogLine[];
        startedAt: string;
      }
    | undefined;
  if (!run || run.status !== "waiting_approval") {
    return false;
  }
  const finishedAt = new Date().toISOString();
  const steps = run.steps.map((step) => ({
    ...step,
    status: "succeeded" as const,
    durationMs: step.durationMs ?? 9_200,
  }));
  const logs = [
    ...run.logs,
    {
      time: finishedAt,
      level: "success" as const,
      message: `生产审批已通过，审批人 ${actor}；模拟发布与健康验证完成`,
    },
  ];
  const durationMs = Date.now() - new Date(run.startedAt).getTime();
  db.prepare(`
    UPDATE runs
    SET status = 'succeeded', steps = ?, logs = ?, finished_at = ?, duration_ms = ?
    WHERE id = ?
  `).run(
    JSON.stringify(steps),
    JSON.stringify(logs),
    finishedAt,
    durationMs,
    id,
  );
  audit(actor, "pipeline.approved", `${run.pipelineName} / ${id}`, "success", {
    environment: run.environment,
  });
  return true;
}

export function listCloudAccounts(): CloudAccountRecord[] {
  return db
    .prepare(`
      SELECT
        id, name, provider, region, status,
        account_type AS accountType,
        owner_id AS ownerId,
        access_key_id AS accessKeyId,
        access_key_enc AS accessKeyEnc,
        status_message AS statusMessage,
        note,
        resource_count AS resourceCount,
        monthly_cost AS monthlyCost,
        last_scanned_at AS lastScannedAt,
        is_demo AS isDemo,
        created_at AS createdAt
      FROM cloud_accounts
      ORDER BY created_at ASC
    `)
    .all()
    .map((rawRow) => {
      const row = rawRow as unknown as CloudAccountRow;
      return {
        id: row.id,
        name: row.name,
        provider: row.provider,
        region: row.region,
        status: row.status,
        statusMessage: row.statusMessage,
        accountType: row.accountType === "sub" ? "sub" : "main",
        ownerId: row.ownerId,
        accessKeyId: row.accessKeyId,
        hasSecret: Boolean(row.accessKeyEnc),
        note: row.note,
        resourceCount: row.resourceCount,
        monthlyCost: row.monthlyCost,
        lastScannedAt: row.lastScannedAt,
        isDemo: Boolean(row.isDemo),
        createdAt: row.createdAt,
      };
    });
}

export function createCloudAccount(input: {
  name: string;
  provider: CloudProvider;
  region: string;
  accountType: "main" | "sub";
  ownerId: string;
  accessKeyId: string;
  secretKey: string;
  note: string;
}) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO cloud_accounts
    (id, name, provider, region, status, account_type,
     owner_id, access_key_id, access_key_enc, note,
     resource_count, monthly_cost, last_scanned_at, is_demo, created_at)
    VALUES (?, ?, ?, ?, 'awaiting_credentials', ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?)
  `).run(
    id,
    input.name,
    input.provider,
    input.region,
    input.accountType,
    input.ownerId,
    input.accessKeyId,
    encryptCloudSecret(input.secretKey),
    input.note,
    new Date().toISOString(),
  );
  return id;
}

export function updateCloudAccount(
  id: string,
  input: {
    name: string;
    provider: CloudProvider;
    region: string;
    accountType: "main" | "sub";
    ownerId: string;
    accessKeyId: string;
    secretKey: string;
    note: string;
  },
): boolean {
  const existing = db
    .prepare("SELECT access_key_enc FROM cloud_accounts WHERE id = ?")
    .get(id) as { access_key_enc: string } | undefined;
  if (!existing) return false;
  const secretEnc = input.secretKey
    ? encryptCloudSecret(input.secretKey)
    : existing.access_key_enc;
  db.prepare(`
    UPDATE cloud_accounts SET
      name = ?, provider = ?, region = ?,
      account_type = ?, owner_id = ?,
      access_key_id = ?, access_key_enc = ?, note = ?
    WHERE id = ?
  `).run(
    input.name,
    input.provider,
    input.region,
    input.accountType,
    input.ownerId,
    input.accessKeyId,
    secretEnc,
    input.note,
    id,
  );
  return true;
}

export interface CloudAccountSecret {
  id: string;
  name: string;
  provider: CloudProvider;
  region: string;
  accountType: "main" | "sub";
  ownerId: string;
  accessKeyId: string;
  secretKey: string;
  hasSecret: boolean;
}

export function getCloudAccountSecret(
  id: string,
): CloudAccountSecret | undefined {
  const row = db
    .prepare(
      `SELECT id, name, provider, region,
              account_type AS accountType, owner_id AS ownerId,
              access_key_id AS accessKeyId, access_key_enc AS accessKeyEnc
       FROM cloud_accounts WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        name: string;
        provider: string;
        region: string;
        accountType: string;
        ownerId: string;
        accessKeyId: string;
        accessKeyEnc: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as CloudProvider,
    region: row.region,
    accountType: row.accountType === "sub" ? "sub" : "main",
    ownerId: row.ownerId,
    accessKeyId: row.accessKeyId,
    secretKey: decryptCloudSecret(row.accessKeyEnc),
    hasSecret: row.accessKeyEnc.length > 0,
  };
}

export function updateCloudAccountStatus(
  id: string,
  status: string,
  message: string,
): void {
  db.prepare(
    "UPDATE cloud_accounts SET status = ?, status_message = ? WHERE id = ?",
  ).run(status, message.slice(0, 500), id);
}

export function setCloudAccountScanResult(id: string, count: number): void {
  db.prepare(
    "UPDATE cloud_accounts SET resource_count = ?, last_scanned_at = ? WHERE id = ?",
  ).run(count, new Date().toISOString(), id);
}

export function setCloudAccountMonthlyCost(id: string, cost: number): void {
  db.prepare("UPDATE cloud_accounts SET monthly_cost = ? WHERE id = ?").run(
    cost,
    id,
  );
}

export function replaceCloudResources(
  accountId: string,
  resources: CloudResourceResult[],
  region: string,
  complete: boolean,
): number {
  db.exec("BEGIN");
  try {
    const now = new Date().toISOString();
    for (const resource of resources) {
      if (!resource.id) continue;
      upsertCloudResource.run(
        crypto.randomUUID(),
        accountId,
        resource.type,
        resource.externalId || resource.id,
        resource.name,
        resource.status,
        resource.region || region,
        JSON.stringify(resource.attributes),
        JSON.stringify(resource.tags ?? {}),
        JSON.stringify(resource.metrics ?? {}),
        resource.metricsUpdatedAt ?? (resource.metrics ? now : null),
        now,
      );
    }
    if (complete) {
      db.prepare(
        "DELETE FROM cloud_resources WHERE account_id = ? AND last_seen_at <> ?",
      ).run(accountId, now);
    }
    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM cloud_resources WHERE account_id = ?")
        .get(accountId) as { count: number }
    ).count;
    db.exec("COMMIT");
    return count;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface CloudResourceRecord {
  id: string;
  resourceType: string;
  externalId: string;
  name: string;
  status: string;
  region: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  metrics: Record<string, unknown> | null;
  metricsUpdatedAt: string | null;
  lastSeenAt: string;
  accountId: string;
  accountName: string;
  provider: CloudProvider;
}

export function listCloudResources(
  accountId?: string,
): CloudResourceRecord[] {
  const where = accountId ? "WHERE resource.account_id = ?" : "";
  const statement = db.prepare(`
    SELECT
      resource.id, resource.resource_type AS resourceType,
      resource.external_id AS externalId,
      resource.name, resource.status, resource.region,
      resource.attributes, resource.tags_json AS tagsJson,
      resource.metrics_json AS metricsJson,
      resource.metrics_updated_at AS metricsUpdatedAt,
      resource.last_seen_at AS lastSeenAt,
      account.id AS accountId, account.name AS accountName,
      account.provider
    FROM cloud_resources resource
    JOIN cloud_accounts account ON account.id = resource.account_id
    ${where}
    ORDER BY account.provider ASC, resource.resource_type ASC
  `);
  const rows = (accountId ? statement.all(accountId) : statement.all()) as Array<
    Record<string, any>
  >;
  return rows.map((row) => {
    const metrics = parseJson<Record<string, unknown>>(
      String(row.metricsJson),
      {},
    );
    return {
      id: String(row.id ?? ""),
      externalId: String(row.externalId ?? "") || String(row.id),
      resourceType: String(row.resourceType ?? ""),
      name: String(row.name ?? ""),
      status: String(row.status ?? "unknown"),
      region: String(row.region ?? ""),
      attributes: parseJson<Record<string, unknown>>(
        String(row.attributes),
        {},
      ),
      tags: parseJson<Record<string, string>>(String(row.tagsJson), {}),
      metrics: Object.keys(metrics).length > 0 ? metrics : null,
      metricsUpdatedAt: row.metricsUpdatedAt
        ? String(row.metricsUpdatedAt)
        : null,
      lastSeenAt: String(row.lastSeenAt ?? ""),
      accountId: String(row.accountId ?? ""),
      accountName: String(row.accountName ?? ""),
      provider: String(row.provider ?? "") as CloudProvider,
    };
  });
}

interface DnsChangeRow {
  id: string;
  accountId: string;
  accountName: string;
  provider: CloudProvider;
  domain: string;
  subdomain: string;
  recordType: string;
  targetValue: string;
  ttl: number;
  finalUrl: string;
  status: DnsChangeStatus;
  requestedBy: string;
  approvedBy: string;
  approvalNote: string;
  preflightJson: string;
  executionJson: string;
  verificationJson: string;
  recordId: string;
  createRequestId: string;
  deleteRequestId: string;
  error: string;
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  completedAt: string | null;
  rolledBackAt: string | null;
  updatedAt: string;
}

const dnsChangeSelect = `
  SELECT
    change.id,
    change.account_id AS accountId,
    account.name AS accountName,
    change.provider,
    change.domain,
    change.subdomain,
    change.record_type AS recordType,
    change.target_value AS targetValue,
    change.ttl,
    change.final_url AS finalUrl,
    change.status,
    change.requested_by AS requestedBy,
    change.approved_by AS approvedBy,
    change.approval_note AS approvalNote,
    change.preflight_json AS preflightJson,
    change.execution_json AS executionJson,
    change.verification_json AS verificationJson,
    change.record_id AS recordId,
    change.create_request_id AS createRequestId,
    change.delete_request_id AS deleteRequestId,
    change.error,
    change.created_at AS createdAt,
    change.approved_at AS approvedAt,
    change.executed_at AS executedAt,
    change.completed_at AS completedAt,
    change.rolled_back_at AS rolledBackAt,
    change.updated_at AS updatedAt
  FROM dns_change_requests change
  JOIN cloud_accounts account ON account.id = change.account_id
`;

function mapDnsChangeRow(rawRow: unknown): DnsChangeRequestRecord {
  const row = rawRow as unknown as DnsChangeRow;
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    provider: row.provider,
    domain: row.domain,
    subdomain: row.subdomain,
    recordType: row.recordType === "A" ? "A" : "A",
    targetValue: row.targetValue,
    ttl: row.ttl,
    finalUrl: row.finalUrl,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvalNote: row.approvalNote,
    preflight: parseJson<Record<string, unknown>>(row.preflightJson, {}),
    execution: parseJson<Record<string, unknown>>(row.executionJson, {}),
    verification: parseJson<Record<string, unknown>>(row.verificationJson, {}),
    recordId: row.recordId,
    createRequestId: row.createRequestId,
    deleteRequestId: row.deleteRequestId,
    error: row.error,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    executedAt: row.executedAt,
    completedAt: row.completedAt,
    rolledBackAt: row.rolledBackAt,
    updatedAt: row.updatedAt,
  };
}

export function listDnsChangeRequests(limit = 50): DnsChangeRequestRecord[] {
  return db
    .prepare(`${dnsChangeSelect} ORDER BY change.created_at DESC LIMIT ?`)
    .all(limit)
    .map(mapDnsChangeRow);
}

export function getDnsChangeRequest(
  id: string,
): DnsChangeRequestRecord | undefined {
  const row = db
    .prepare(`${dnsChangeSelect} WHERE change.id = ?`)
    .get(id);
  return row ? mapDnsChangeRow(row) : undefined;
}

export function createDnsChangeRequest(input: {
  accountId: string;
  provider: CloudProvider;
  domain: string;
  subdomain: string;
  recordType: "A";
  targetValue: string;
  ttl: number;
  finalUrl: string;
  status: DnsChangeStatus;
  requestedBy: string;
  preflight: DnsPreflightResult;
  error: string;
}): DnsChangeRequestRecord {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO dns_change_requests
    (id, account_id, provider, domain, subdomain, record_type, target_value,
     ttl, final_url, status, requested_by, preflight_json, error,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.accountId,
    input.provider,
    input.domain,
    input.subdomain,
    input.recordType,
    input.targetValue,
    input.ttl,
    input.finalUrl,
    input.status,
    input.requestedBy,
    JSON.stringify(input.preflight),
    input.error,
    now,
    now,
  );
  const created = getDnsChangeRequest(id);
  if (!created) {
    throw new Error("DNS 变更单创建后无法读取。");
  }
  return created;
}

export function refreshDnsChangePreflight(
  id: string,
  preflight: DnsPreflightResult,
): boolean {
  return (
    db.prepare(`
      UPDATE dns_change_requests
      SET preflight_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('waiting_approval', 'approved')
    `).run(
      JSON.stringify(preflight),
      new Date().toISOString(),
      id,
    ).changes > 0
  );
}

export function approveDnsChangeRequest(
  id: string,
  actor: string,
  note: string,
): boolean {
  const now = new Date().toISOString();
  return (
    db.prepare(`
      UPDATE dns_change_requests
      SET status = 'approved', approved_by = ?, approval_note = ?,
          approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'waiting_approval'
    `).run(actor, note.slice(0, 500), now, now, id).changes > 0
  );
}

export function startDnsChangeExecution(id: string): boolean {
  const now = new Date().toISOString();
  return (
    db.prepare(`
      UPDATE dns_change_requests
      SET status = 'executing', executed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'approved'
    `).run(now, now, id).changes > 0
  );
}

export function completeDnsChangeRequest(
  id: string,
  input: {
    recordId: string;
    createRequestId: string;
    execution: Record<string, unknown>;
    verification: DnsVerificationResult;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE dns_change_requests
    SET status = 'succeeded', record_id = ?, create_request_id = ?,
        execution_json = ?, verification_json = ?, error = '',
        completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'executing'
  `).run(
    input.recordId,
    input.createRequestId,
    JSON.stringify(input.execution),
    JSON.stringify(input.verification),
    now,
    now,
    id,
  );
}

export function failDnsChangeRequest(
  id: string,
  error: string,
  execution: Record<string, unknown> = {},
  recordId = "",
  createRequestId = "",
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE dns_change_requests
    SET status = 'failed', error = ?, execution_json = ?,
        record_id = CASE WHEN ? <> '' THEN ? ELSE record_id END,
        create_request_id = CASE WHEN ? <> '' THEN ? ELSE create_request_id END,
        completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('approved', 'executing')
  `).run(
    error.slice(0, 2_000),
    JSON.stringify(execution),
    recordId,
    recordId,
    createRequestId,
    createRequestId,
    now,
    now,
    id,
  );
}

export function recordDnsChangeReverification(input: {
  id: string;
  recordId: string;
  verification: DnsVerificationResult;
  execution: Record<string, unknown>;
  passed: boolean;
}): boolean {
  const now = new Date().toISOString();
  if (!input.passed) {
    return (
      db.prepare(`
        UPDATE dns_change_requests
        SET verification_json = ?, updated_at = ?
        WHERE id = ? AND status = 'failed' AND record_id = ?
      `).run(
        JSON.stringify(input.verification),
        now,
        input.id,
        input.recordId,
      ).changes > 0
    );
  }
  return (
    db.prepare(`
      UPDATE dns_change_requests
      SET status = 'succeeded', verification_json = ?, execution_json = ?,
          error = '', completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'failed' AND record_id = ?
    `).run(
      JSON.stringify(input.verification),
      JSON.stringify(input.execution),
      now,
      now,
      input.id,
      input.recordId,
    ).changes > 0
  );
}

export function markDnsChangeRolledBack(
  id: string,
  deleteRequestId: string,
  rollback: Record<string, unknown>,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE dns_change_requests
    SET status = 'rolled_back', delete_request_id = ?, verification_json = ?,
        rolled_back_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('succeeded', 'failed')
  `).run(
    deleteRequestId,
    JSON.stringify(rollback),
    now,
    now,
    id,
  );
}

export function cancelDnsChangeRequest(id: string): boolean {
  const now = new Date().toISOString();
  return (
    db.prepare(`
      UPDATE dns_change_requests
      SET status = 'cancelled', completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('waiting_approval', 'approved')
    `).run(now, now, id).changes > 0
  );
}

export function refreshCloudAccount(id: string): {
  resources: number;
  cost: number;
} | null {
  const account = db
    .prepare("SELECT id, resource_count, monthly_cost FROM cloud_accounts WHERE id = ?")
    .get(id) as
    | { id: string; resource_count: number; monthly_cost: number }
    | undefined;
  if (!account) {
    return null;
  }
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE cloud_accounts SET last_scanned_at = ? WHERE id = ?
  `).run(now, id);
  db.prepare(`
    UPDATE cloud_resources SET last_seen_at = ? WHERE account_id = ?
  `).run(now, id);
  return {
    resources: account.resource_count,
    cost: account.monthly_cost,
  };
}

export function listAuditEvents(limit = 50) {
  return db
    .prepare(`
      SELECT
        id, actor, action, target, result, metadata,
        created_at AS createdAt
      FROM audit_events
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => ({
      ...row,
      metadata: parseJson<Record<string, unknown>>(String(row.metadata), {}),
    }));
}

export function getPonytailActivity() {
  const now = Date.now();
  const cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(`
      SELECT target, metadata, created_at AS createdAt
      FROM audit_events
      WHERE action = 'ponytail.command.generated' AND created_at >= ?
      ORDER BY created_at DESC
    `)
    .all(cutoff) as Array<{
    target: string;
    metadata: string;
    createdAt: string;
  }>;
  const generatedCommands = { "7d": 0, "30d": 0, "90d": 0 };
  const bySkill: Record<string, number> = {};

  for (const row of rows) {
    const age = now - Date.parse(row.createdAt);
    if (age <= 7 * 24 * 60 * 60 * 1000) generatedCommands["7d"] += 1;
    if (age <= 30 * 24 * 60 * 60 * 1000) generatedCommands["30d"] += 1;
    generatedCommands["90d"] += 1;
    bySkill[row.target] = (bySkill[row.target] ?? 0) + 1;
  }

  return {
    generatedCommands,
    bySkill,
    recent: rows.slice(0, 8).map((row) => {
      const metadata = parseJson<Record<string, unknown>>(row.metadata, {});
      return {
        skill: row.target,
        mode: typeof metadata.mode === "string" ? metadata.mode : null,
        createdAt: row.createdAt,
      };
    }),
  };
}

export function getOverview() {
  const repositories = listRepositories();
  const accounts = listCloudAccounts();
  const recentDeployments = listDeployments(5);
  const pendingDeployments = listDeployments(100).filter(
    (deployment) => deployment.status === "waiting_approval",
  );
  const deploymentTotal = (
    db.prepare("SELECT COUNT(*) AS count FROM deployments").get() as {
      count: number;
    }
  ).count;
  const succeededDeploymentCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM deployments WHERE status = 'succeeded'",
      )
      .get() as { count: number }
  ).count;
  const failedDeploymentCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM deployments WHERE status = 'failed'",
      )
      .get() as { count: number }
  ).count;
  const pendingDeploymentApprovals = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM deployments WHERE status = 'waiting_approval'",
      )
      .get() as { count: number }
  ).count;
  const completed = succeededDeploymentCount + failedDeploymentCount;
  const succeededTotal = succeededDeploymentCount;
  const deploymentSuccessRate =
    completed > 0
      ? Math.round((succeededTotal / completed) * 1000) / 10
      : 0;
  const cloudResourceCount = (
    db.prepare("SELECT COUNT(*) AS count FROM cloud_resources").get() as {
      count: number;
    }
  ).count;
  const deploymentCount = deploymentTotal;
  const succeededDeployments = succeededDeploymentCount;
  return {
    metrics: {
      repositoryCount: repositories.length,
      cloudResourceCount,
      deploymentCount,
      succeededDeployments,
      failedDeployments: failedDeploymentCount,
      deploymentSuccessRate,
      pendingDeploymentApprovals,
      monthlyCost: accounts.reduce(
        (sum, account) => sum + Number(account.monthlyCost),
        0,
      ),
    },
    recentDeployments,
    pendingDeployments,
    repositories,
    cloudAccounts: accounts,
  };
}


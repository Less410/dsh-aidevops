export type PageId =
  | "overview"
  | "guide"
  | "repositories"
  | "apps"
  | "pipelines"
  | "versions"
  | "cloud"
  | "servers"
  | "databases"
  | "copilot"
  | "ponytail"
  | "errors"
  | "audit"
  | "settings";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SessionUser {
  email: string;
  name: string;
  role: "admin";
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: SessionUser;
}

export interface Version {
  id: string;
  branch: string;
  commitSha: string;
  message: string;
  syncedAt: string;
}

export interface Repository {
  id: string;
  name: string;
  provider: "github" | "gitlab" | "gitea" | "gitee";
  url: string;
  branch: string;
  status: "ready" | "pending" | "sync_error";
  serverId: string | null;
  serverName: string | null;
  hasToken: boolean;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  isDemo: boolean;
  createdAt: string;
  versions: Version[];
}

export interface PipelineStep {
  key?: string;
  name: string;
  description?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  command?: string;
  exitCode?: number | null;
  result?: string;
  evidence?: string[];
}

export interface Pipeline {
  id: string;
  name: string;
  environment: "development" | "staging" | "production";
  triggerType: "manual" | "webhook";
  steps: PipelineStep[];
  enabled: boolean;
  createdAt: string;
  repositoryId: string;
  repositoryName: string;
  lastCommit: string | null;
}

export interface LogLine {
  time: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface PipelineRun {
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
  environment: "development" | "staging" | "production";
  repositoryName: string;
}

export interface Metrics {
  repositoryCount: number;
  cloudResourceCount: number;
  deploymentCount: number;
  succeededDeployments: number;
  failedDeployments: number;
  deploymentSuccessRate: number;
  pendingDeploymentApprovals: number;
  monthlyCost: number;
}

export interface CloudAccount {
  id: string;
  name: string;
  provider: "tencent" | "aliyun" | "huawei";
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

export interface CloudResource {
  id: string;
  externalId: string;
  resourceType: string;
  name: string;
  status: "healthy" | "warning" | "critical" | "unknown";
  region: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  metrics: CloudResourceMetrics | null;
  metricsUpdatedAt: string | null;
  lastSeenAt: string;
  accountId: string;
  accountName: string;
  provider: "tencent" | "aliyun" | "huawei";
}

export interface CloudResourceMetrics {
  status: "ok" | "partial" | "unavailable";
  cpuPercent?: number;
  memoryPercent?: number;
  cpuMetric?: string;
  memoryMetric?: string;
  periodSeconds?: number;
  updatedAt: string;
  requestId?: string;
  error?: string;
}

export type CloudChangeAction =
  | "START_INSTANCE"
  | "STOP_INSTANCE"
  | "REBOOT_INSTANCE"
  | "CREATE_INSTANCE"
  | "RELEASE_INSTANCE"
  | "ADD_SECURITY_RULE"
  | "DELETE_SECURITY_RULE"
  | "CREATE_SNAPSHOT"
  | "EXPAND_DISK";

export interface CloudChangeRequest {
  id: string;
  accountId: string;
  accountName: string;
  provider: "tencent" | "aliyun" | "huawei";
  region: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  scopeTags: Record<string, string>;
  action: CloudChangeAction;
  parameters: Record<string, unknown>;
  status:
    | "waiting_approval"
    | "approved"
    | "executing"
    | "succeeded"
    | "failed"
    | "cancelled";
  requestedBy: string;
  approvedBy: string;
  approvalNote: string;
  preflight: Record<string, unknown>;
  execution: Record<string, unknown>;
  verification: Record<string, unknown>;
  error: string;
  createdAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type DnsChangeStatus =
  | "waiting_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "cancelled";

export interface DnsCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface DnsChangeRequest {
  id: string;
  accountId: string;
  accountName: string;
  provider: "tencent" | "aliyun" | "huawei";
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
  preflight: {
    ok?: boolean;
    checkedAt?: string;
    checks?: DnsCheck[];
    existingRecords?: Array<{
      recordId: string;
      subdomain: string;
      recordType: string;
      value: string;
      ttl: number;
    }>;
    conflictRecordIds?: string[];
    [key: string]: unknown;
  };
  execution: {
    stage?: string;
    recordId?: string;
    createRequestId?: string;
    error?: string;
    checks?: DnsCheck[];
    [key: string]: unknown;
  };
  verification: {
    ok?: boolean;
    checkedAt?: string;
    checks?: DnsCheck[];
    resolvedIps?: string[];
    http?: {
      ok: boolean;
      statusCode: number | null;
      durationMs: number;
      url: string;
      hostHeader: string;
      detail: string;
    } | null;
    detail?: string;
    [key: string]: unknown;
  };
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

export interface AppFieldDefinition {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "url" | "select" | "boolean";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
  group?: string;
}

export interface AppTypeDefinition {
  id: string;
  label: string;
  short: string;
  description: string;
  fields: AppFieldDefinition[];
}

export interface Application {
  id: string;
  name: string;
  appType: string;
  appTypeLabel: string;
  repositoryId: string | null;
  repositoryName: string | null;
  targetProvider: string | null;
  environment: string;
  fields: Record<string, string | number | boolean>;
  status: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Overview {
  metrics: Metrics;
  recentDeployments: Deployment[];
  pendingDeployments: Deployment[];
  repositories: Repository[];
  cloudAccounts: CloudAccount[];
}

export interface PonytailStatus {
  installed: boolean;
  complete: boolean;
  version: string | null;
  location: string | null;
  expectedSkills: string[];
  skills: string[];
  checkedAt: string;
  generatedCommands: Record<"7d" | "30d" | "90d", number>;
  bySkill: Record<string, number>;
  recent: Array<{
    skill: string;
    mode: string | null;
    createdAt: string;
  }>;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  target: string;
  result: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AiProposal {
  id: string;
  title: string;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
}

export interface AiResponse {
  message: string;
  mode: "local-analysis" | "model";
  proposals: AiProposal[];
}

export interface RunAnalysis {
  severity: "low" | "medium" | "high";
  summary: string;
  evidence: string[];
  recommendations: Array<{
    title: string;
    risk: "low" | "medium" | "high";
    requiresApproval: boolean;
  }>;
}

export interface SettingsStatus {
  demoMode: boolean;
  llmConfigured: boolean;
  modelGateway: string;
  executionMode: string;
  persistence: string;
  registryCredentials: Array<{
    id: string;
    name: string;
    registry: string;
    username: string;
    namespace: string;
    hasPassword: boolean;
  }>;
  gitCredentials: Array<{
    id: string;
    provider: string;
    username: string;
    hasPassword: boolean;
  }>;
  cloudAdapters: Array<{
    provider: string;
    label: string;
    connected: boolean;
  }>;
}

export interface DbConnection {
  id: string;
  name: string;
  kind: "cloud_managed" | "self_hosted";
  vendor: "tencent" | "aliyun" | "huawei" | "other";
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

export interface DbDatabaseInfo {
  name: string;
  system: boolean;
}

export interface DbTableInfo {
  name: string;
  type: string;
  engine: string;
  rows: number;
  sizeBytes: number;
}

export interface DbColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  extra: string;
  defaultValue: string | null;
  comment: string;
}

export interface DbTableDetail {
  name: string;
  type: "table" | "view";
  ddl: string;
  columns: DbColumnInfo[];
  rows: Array<Record<string, unknown>>;
  rowCountHint: number;
}

export interface DbQueryResult {
  kind: "resultset" | "executed";
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  affectedRows: number;
  changedRows: number;
  elapsedMs: number;
}

export interface DbBackup {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  filename: string;
  sizeBytes: number;
  tableCount: number;
  createdAt: string;
}

export interface CloudServer {
  id: string;
  name: string;
  osType: "ubuntu" | "linux" | "windows";
  provider: "tencent" | "aliyun" | "huawei" | "other";
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

export interface ServerExecResult {
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

export interface ErrorEvent {
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

export interface Deployment {
  id: string;
  appId: string;
  appName: string;
  repositoryId: string;
  repositoryName: string;
  serverId: string;
  serverName: string;
  serverHost: string;
  environment: "development" | "staging" | "production";
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
}

export interface HealthCheck {
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


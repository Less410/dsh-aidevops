export type RepositoryProvider = "github" | "gitlab" | "gitea" | "gitee";
export type CloudProvider = "tencent" | "aliyun" | "huawei";
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
export type CloudChangeStatus =
  | "waiting_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled";
export type EnvironmentName = "development" | "staging" | "production";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

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

export interface LogLine {
  time: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface SessionUser {
  email: string;
  name: string;
  role: "admin";
  exp: number;
}


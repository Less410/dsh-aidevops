import {
  audit,
  findSucceededDeploymentByImage,
  listDeployments,
  listHealthChecks,
  upsertHealthCheck,
  type DeploymentRecord,
} from "./db.js";
import { autoRollbackToTarget } from "./deploy.js";
import { execServerCommand } from "./servers.js";

const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS ?? 60_000);
const FAILURE_THRESHOLD = 3;
let running = false;
let timer: NodeJS.Timeout | null = null;

function containerName(appId: string): string {
  return `aidevops-${appId.slice(0, 12)}`;
}

function latestDeployments(): DeploymentRecord[] {
  const deployments = listDeployments(500);
  const latestByApp = new Map<string, DeploymentRecord>();
  for (const deployment of deployments) {
    if (deployment.status !== "succeeded") continue;
    const key = `${deployment.appId}:${deployment.environment}`;
    const existing = latestByApp.get(key);
    if (
      !existing ||
      new Date(deployment.startedAt).getTime() >
        new Date(existing.startedAt).getTime()
    ) {
      latestByApp.set(key, deployment);
    }
  }
  return Array.from(latestByApp.values());
}

async function checkGroup(serverId: string, deployments: DeploymentRecord[]) {
  const lines = deployments
    .map(
      (deployment) =>
        `start=$(date +%s%3N); code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:${deployment.port}${deployment.healthPath || "/"}' 2>/dev/null || echo 000); end=$(date +%s%3N); echo "H|${deployment.id}|$code|$((end-start))"`,
    )
    .join("; ");
  const result = await execServerCommand(serverId, lines, {
    timeoutMs: 90_000,
  });
  const checks = new Map<
    string,
    { httpStatus: number; responseMs: number }
  >();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^H\|([^|]+)\|(\d+)\|(\d+)$/);
    if (!match) continue;
    checks.set(match[1] ?? "", {
      httpStatus: Number(match[2]),
      responseMs: Number(match[3]),
    });
  }
  return checks;
}

async function attemptRecovery(
  deployment: DeploymentRecord,
  previousFailures: number,
): Promise<{ recovered: boolean; message: string }> {
  if (previousFailures < FAILURE_THRESHOLD) {
    return { recovered: false, message: "" };
  }
  // 每累计 3 次失败尝试一次恢复，避免每分钟重复操作。
  if (previousFailures > FAILURE_THRESHOLD && previousFailures % 10 !== 0) {
    return { recovered: false, message: "" };
  }
  const container = containerName(deployment.appId);
  try {
    await execServerCommand(
      deployment.serverId,
      `docker restart '${container}' >/dev/null 2>&1 || true`,
      { timeoutMs: 60_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const recheck = await execServerCommand(
      deployment.serverId,
      `code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:${deployment.port}${deployment.healthPath || "/"}' 2>/dev/null || echo 000); echo RECHECK=$code`,
      { timeoutMs: 30_000 },
    );
    if (/RECHECK=2\d\d|RECHECK=3\d\d/.test(recheck.stdout)) {
      audit("monitor", "health.auto_restart", deployment.appName, "success");
      return { recovered: true, message: "连续失败后自动重启容器并恢复" };
    }
    if (deployment.previousImageTag) {
      const target = findSucceededDeploymentByImage(
        deployment.appId,
        deployment.previousImageTag,
        deployment.environment,
      );
      if (target) {
        const rollback = await autoRollbackToTarget({
          source: deployment,
          target,
          reason: `连续 ${previousFailures} 次健康检查失败`,
        });
        if (rollback.recovered) {
          return {
            recovered: true,
            message: rollback.message,
          };
        }
        return {
          recovered: false,
          message: rollback.message,
        };
      }
    }
    audit("monitor", "health.auto_recovery", deployment.appName, "failed");
    return { recovered: false, message: "自动重启与回滚均未恢复" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    audit("monitor", "health.auto_recovery", deployment.appName, "failed", {
      message,
    });
    return { recovered: false, message: `自动恢复失败：${message}` };
  }
}

export async function runHealthCheck(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const deployments = latestDeployments();
    if (deployments.length === 0) return;
    const previous = new Map(
      listHealthChecks().map((check) => [check.deploymentId, check]),
    );
    const byServer = new Map<string, DeploymentRecord[]>();
    for (const deployment of deployments) {
      const list = byServer.get(deployment.serverId) ?? [];
      list.push(deployment);
      byServer.set(deployment.serverId, list);
    }
    for (const [serverId, items] of byServer) {
      const checks = await checkGroup(serverId, items);
      for (const deployment of items) {
        const check = checks.get(deployment.id) ?? {
          httpStatus: 0,
          responseMs: 0,
        };
        const healthy =
          check.httpStatus >= 200 && check.httpStatus < 400;
        const old = previous.get(deployment.id);
        let consecutiveFailures = healthy
          ? 0
          : (old?.consecutiveFailures ?? 0) + 1;
        let status: "healthy" | "unhealthy" = healthy
          ? "healthy"
          : "unhealthy";
        let message = healthy
          ? `HTTP ${check.httpStatus}`
          : `HTTP ${check.httpStatus || "无响应"}，连续失败 ${consecutiveFailures} 次`;
        if (!healthy) {
          const recovery = await attemptRecovery(
            deployment,
            consecutiveFailures,
          );
          if (recovery.recovered) {
            status = "healthy";
            consecutiveFailures = 0;
            message = recovery.message;
          } else if (recovery.message) {
            message = `${message}；${recovery.message}`;
          }
        }
        upsertHealthCheck({
          deploymentId: deployment.id,
          appId: deployment.appId,
          appName: deployment.appName,
          serverId: deployment.serverId,
          port: deployment.port,
          healthPath: deployment.healthPath || "/",
          status,
          httpStatus: check.httpStatus,
          responseMs: check.responseMs,
          consecutiveFailures,
          message,
          checkedAt: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    console.error("[monitor] health check failed:", error);
  } finally {
    running = false;
  }
}

export function startHealthMonitor(): void {
  if (timer) return;
  setTimeout(() => void runHealthCheck(), 15_000);
  timer = setInterval(() => void runHealthCheck(), INTERVAL_MS);
  console.log(`[monitor] health monitor started, interval=${INTERVAL_MS}ms`);
}

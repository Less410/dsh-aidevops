import { audit } from "./db.js";
import {
  deleteBackup,
  dumpDatabase,
  listBackups,
  listDatabases,
  listDbConnections,
} from "./dbmanage.js";

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 20 * 60 * 60 * 1000;
let running = false;
let timer: NodeJS.Timeout | null = null;

export async function runScheduledBackups(force = false): Promise<number> {
  if (running) return 0;
  running = true;
  let created = 0;
  try {
    const last = listBackups()[0];
    const needsRun =
      force ||
      !last ||
      Date.now() - new Date(last.createdAt).getTime() > MAX_AGE_MS;
    if (needsRun) {
      for (const connection of listDbConnections()) {
        try {
          const databases = await listDatabases(connection.id);
          const targets = databases.filter((item) => !item.system).slice(0, 10);
          for (const database of targets) {
            try {
              const backup = await dumpDatabase(connection.id, database.name);
              created += 1;
              audit(
                "scheduler",
                "db.backup.scheduled",
                `${connection.name}/${database.name}`,
                "success",
                { sizeBytes: backup.sizeBytes },
              );
            } catch (error) {
              audit(
                "scheduler",
                "db.backup.scheduled",
                `${connection.name}/${database.name}`,
                "failed",
                {
                  message:
                    error instanceof Error ? error.message : "备份失败",
                },
              );
            }
          }
        } catch (error) {
          audit(
            "scheduler",
            "db.backup.scheduled",
            connection.name,
            "failed",
            {
              message: error instanceof Error ? error.message : "连接失败",
            },
          );
        }
      }
    }
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const backup of listBackups()) {
      if (new Date(backup.createdAt).getTime() < cutoff) {
        deleteBackup(backup.id);
      }
    }
  } finally {
    running = false;
  }
  return created;
}

export function backupSchedulerStatus(): {
  enabled: boolean;
  retentionDays: number;
  lastBackupAt: string | null;
  lastBackupName: string | null;
  schedule: string;
} {
  const last = listBackups()[0];
  return {
    enabled: true,
    retentionDays: RETENTION_DAYS,
    lastBackupAt: last?.createdAt ?? null,
    lastBackupName: last?.filename ?? null,
    schedule: "每小时检查 · 每天至少自动备份一次",
  };
}

export function startBackupScheduler(): void {
  if (timer) return;
  setTimeout(() => void runScheduledBackups(), 20_000);
  timer = setInterval(() => void runScheduledBackups(), CHECK_INTERVAL_MS);
  console.log(
    `[scheduler] backup scheduler started, retention=${RETENTION_DAYS}d`,
  );
}

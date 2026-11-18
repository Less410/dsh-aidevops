import type { CloudProvider } from "./types.js";
import {
  scanAllTencentResources,
  verifyTencentAccount,
} from "./tencent.js";
import {
  scanAllAliyunResources,
  verifyAliyunAccount,
} from "./aliyun.js";

export interface CloudAccountReference {
  id: string;
  provider: CloudProvider;
  region: string;
  accountType: "main" | "sub";
  ownerId: string;
  accessKeyId: string;
  secretKey: string;
  hasSecret: boolean;
}

export interface CloudResourceResult {
  id: string;
  externalId?: string;
  type: string;
  name: string;
  status: "healthy" | "warning" | "critical" | "unknown";
  region: string;
  attributes: Record<string, unknown>;
  tags?: Record<string, string>;
  metrics?: CloudResourceMetrics;
  metricsUpdatedAt?: string;
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

export interface CloudScanResult {
  resources: CloudResourceResult[];
  warnings: string[];
  complete: boolean;
}

export interface CloudProviderAdapter {
  provider: CloudProvider;
  label: string;
  supportsReadInventory: boolean;
  supportsControlledChange: boolean;
  scan(account: CloudAccountReference): Promise<CloudScanResult>;
  verify?(account: CloudAccountReference): Promise<{ ok: true; detail: string }>;
}

class NotConnectedAdapter implements CloudProviderAdapter {
  readonly supportsReadInventory = false;
  readonly supportsControlledChange = false;

  constructor(
    readonly provider: CloudProvider,
    readonly label: string,
  ) {}

  async scan(_account: CloudAccountReference): Promise<CloudScanResult> {
    throw new Error(
      `${this.label}连接器尚未激活。请等待后续版本支持 API 凭据接入。`,
    );
  }
}

class TencentAdapter implements CloudProviderAdapter {
  readonly provider = "tencent" as const;
  readonly label = "腾讯云";
  readonly supportsReadInventory = true;
  readonly supportsControlledChange = true;

  private credentials(account: CloudAccountReference) {
    if (!account.accessKeyId || !account.secretKey) {
      throw new Error(
        "该账号还没有保存腾讯云 API 密钥。请编辑账号并填写 SecretId / SecretKey。",
      );
    }
    return {
      secretId: account.accessKeyId,
      secretKey: account.secretKey,
    };
  }

  async verify(account: CloudAccountReference): Promise<{ ok: true; detail: string }> {
    const identity = await verifyTencentAccount(this.credentials(account));
    if (account.ownerId && account.ownerId !== identity.accountId) {
      throw new Error(
        `腾讯云主账号 UIN 与登记值不一致：登记 ${account.ownerId}，实际 ${identity.accountId}。请核对后重新保存。`,
      );
    }
    return {
      ok: true,
      detail: [
        `腾讯云 API 凭据验证成功 · 调用身份 UIN ${identity.userId}`,
        ` · 所属主账号 UIN ${identity.accountId}`,
      ].join(""),
    };
  }

  async scan(account: CloudAccountReference): Promise<CloudScanResult> {
    const credentials = this.credentials(account);
    return scanAllTencentResources(credentials, account.region);
  }
}

class AliyunAdapter implements CloudProviderAdapter {
  readonly provider = "aliyun" as const;
  readonly label = "阿里云";
  readonly supportsReadInventory = true;
  readonly supportsControlledChange = true;

  private credentials(account: CloudAccountReference) {
    if (!account.accessKeyId || !account.secretKey) {
      throw new Error(
        "该账号还没有保存阿里云 API 凭据。请编辑账号并填写 AccessKey ID / Secret。",
      );
    }
    return {
      accessKeyId: account.accessKeyId,
      secretKey: account.secretKey,
    };
  }

  async verify(account: CloudAccountReference): Promise<{ ok: true; detail: string }> {
    const identity = await verifyAliyunAccount(this.credentials(account));
    if (account.ownerId && account.ownerId !== identity.accountId) {
      throw new Error(
        `阿里云主账号 UID 与登记值不一致：登记 ${account.ownerId}，实际 ${identity.accountId}。请核对后重新保存。`,
      );
    }
    return {
      ok: true,
      detail: `阿里云 RAM 凭据验证成功 · 主账号 UID ${identity.accountId} · 身份 ${identity.identityType || "RAM 用户"}`,
    };
  }

  async scan(account: CloudAccountReference): Promise<CloudScanResult> {
    return scanAllAliyunResources(this.credentials(account), account.region);
  }
}

export const cloudAdapters: Record<CloudProvider, CloudProviderAdapter> = {
  tencent: new TencentAdapter(),
  aliyun: new AliyunAdapter(),
  huawei: new NotConnectedAdapter("huawei", "华为云"),
};

export function isCloudProvider(value: unknown): value is CloudProvider {
  return value === "tencent" || value === "aliyun" || value === "huawei";
}


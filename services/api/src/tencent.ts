import crypto from "node:crypto";
import type { CloudResourceResult, CloudScanResult } from "./cloud.js";

export interface TencentCredentials {
  secretId: string;
  secretKey: string;
}

function sha256Hex(message: string): string {
  return crypto.createHash("sha256").update(message).digest("hex");
}

function hmac(key: Buffer | string, message: string): Buffer {
  return crypto.createHmac("sha256", key).update(message).digest();
}

interface TencentApiInput extends TencentCredentials {
  service: string;
  host: string;
  region: string;
  action: string;
  version: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}

export class TencentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(
      `腾讯云接口错误：${code} - ${message}${
        requestId ? `（RequestId ${requestId}）` : ""
      }`,
    );
    this.name = "TencentApiError";
  }
}

export async function callTencentApi(
  input: TencentApiInput,
): Promise<{ json: Record<string, any>; requestId: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payloadJson = JSON.stringify(input.payload ?? {});
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${input.host}`,
    `x-tc-action:${input.action.toLowerCase()}`,
  ].join("\n");
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    sha256Hex(payloadJson),
  ].join("\n");
  const credentialScope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${input.secretKey}`, date);
  const secretService = hmac(secretDate, input.service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = crypto
    .createHmac("sha256", secretSigning)
    .update(stringToSign)
    .digest("hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let response: Response;
  try {
    response = await fetch(`https://${input.host}/`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": contentType,
        Host: input.host,
        "X-TC-Action": input.action,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": input.version,
        ...(input.region ? { "X-TC-Region": input.region } : {}),
      },
      body: payloadJson,
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "请求腾讯云接口超时，请检查网络。"
        : `无法访问腾讯云接口：${error instanceof Error ? error.message : "网络错误"}`;
    throw new Error(message);
  }

  const text = await response.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    json = null;
  }
  if (!json) {
    throw new Error(`腾讯云接口返回无法解析的内容（HTTP ${response.status}）。`);
  }
  const body = json.Response as Record<string, any> | undefined;
  if (!body) {
    throw new Error(`腾讯云接口响应格式异常（HTTP ${response.status}）。`);
  }
  if (body.Error) {
    const error = body.Error as { Code?: string; Message?: string };
    throw new TencentApiError(
      error.Code ?? "Unknown",
      error.Message ?? "未知原因",
      typeof body.RequestId === "string" ? body.RequestId : "",
    );
  }
  return {
    json: body,
    requestId: typeof body.RequestId === "string" ? body.RequestId : "",
  };
}

export interface TencentCallerIdentity {
  accountId: string;
  arn: string;
  userId: string;
  principalId: string;
  appId: string;
  type: string;
}

export async function verifyTencentAccount(
  credentials: TencentCredentials,
): Promise<TencentCallerIdentity> {
  const { json } = await callTencentApi({
    ...credentials,
    service: "sts",
    host: "sts.tencentcloudapi.com",
    region: "",
    action: "GetCallerIdentity",
    version: "2018-08-13",
    payload: {},
  });
  return {
    accountId: String(json.AccountId ?? ""),
    arn: String(json.Arn ?? ""),
    userId: String(json.UserId ?? ""),
    principalId: String(json.PrincipalId ?? ""),
    appId: "",
    type: String(json.Type ?? "Unknown"),
  };
}

export function assertTencentRegion(region: string): string {
  if (!/^[a-z]{2}-[a-z]+(-\d+)?$/.test(region)) {
    throw new Error(
      "账号地域格式不正确（示例：ap-guangzhou）。请在编辑云账号时填写正确地域。",
    );
  }
  return region;
}

export async function listCvmInstances(
  credentials: TencentCredentials,
  region: string,
): Promise<CloudResourceResult[]> {
  const safeRegion = assertTencentRegion(region);
  const { json } = await callTencentApi({
    ...credentials,
    service: "cvm",
    host: `cvm.${safeRegion}.tencentcloudapi.com`,
    region: safeRegion,
    action: "DescribeInstances",
    version: "2017-03-12",
    payload: { Limit: 100, Offset: 0 },
  });
  const instances = Array.isArray(json.InstanceSet) ? json.InstanceSet : [];
  return instances.map((instance: Record<string, any>) => ({
    id: String(instance.InstanceId ?? ""),
    type: "CVM",
    name: String(instance.InstanceName || instance.InstanceId || ""),
    status: instance.InstanceState === "RUNNING" ? "healthy" : "unknown",
    region: safeRegion,
    attributes: {
      instanceType: String(instance.InstanceType ?? ""),
      osName: String(instance.OsName ?? ""),
      cpu: Number(instance.CPU ?? 0),
      memory: Number(instance.Memory ?? 0),
      publicIp: Array.isArray(instance.PublicIpAddresses)
        ? instance.PublicIpAddresses.join(", ")
        : "",
      privateIp: Array.isArray(instance.PrivateIpAddresses)
        ? instance.PrivateIpAddresses.join(", ")
        : "",
      instanceState: String(instance.InstanceState ?? ""),
      chargeType: String(instance.InstanceChargeType ?? ""),
      createdAt: String(instance.CreatedTime ?? ""),
    },
  }));
}

export async function listTencentCvmRegions(
  credentials: TencentCredentials,
): Promise<string[]> {
  return describeTencentRegions(credentials, "cvm", "2017-03-12");
}

async function describeTencentRegions(
  credentials: TencentCredentials,
  service: string,
  version: string,
): Promise<string[]> {
  const { json } = await callTencentApi({
    ...credentials,
    service,
    host: `${service}.tencentcloudapi.com`,
    region: "",
    action: "DescribeRegions",
    version,
    payload: {},
  });
  const regionSet = Array.isArray(json.RegionSet) ? json.RegionSet : [];
  return regionSet
    .map((item: Record<string, any>) => String(item.Region ?? ""))
    .filter((item: string) => Boolean(item));
}

export async function listCvmInstancesAcrossRegions(
  credentials: TencentCredentials,
  regions: string[],
  concurrency = 4,
): Promise<CloudResourceResult[]> {
  const results: CloudResourceResult[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, regions.length) },
    async () => {
      while (cursor < regions.length) {
        const region = regions[cursor++] ?? "";
        if (!region) continue;
        try {
          results.push(...(await listCvmInstances(credentials, region)));
        } catch {
          // 单个地域查询失败（例如无权限）跳过，继续探测其他地域。
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function listInstancesRaw(
  credentials: TencentCredentials,
  region: string,
  service: string,
  version: string,
): Promise<Array<Record<string, any>>> {
  const { json } = await callTencentApi({
    ...credentials,
    service,
    host: `${service}.${region}.tencentcloudapi.com`,
    region,
    action: "DescribeInstances",
    version,
    payload: { Limit: 100, Offset: 0 },
  });
  return Array.isArray(json.InstanceSet) ? json.InstanceSet : [];
}

export async function listLighthouseInstances(
  credentials: TencentCredentials,
  region: string,
): Promise<CloudResourceResult[]> {
  const safeRegion = assertTencentRegion(region);
  const instances = await listInstancesRaw(
    credentials,
    safeRegion,
    "lighthouse",
    "2020-03-24",
  );
  return instances.map((instance) => ({
    id: String(instance.InstanceId ?? ""),
    type: "Lighthouse",
    name: String(instance.InstanceName || instance.InstanceId || ""),
    status: instance.InstanceState === "RUNNING" ? "healthy" : "unknown",
    region: safeRegion,
    attributes: {
      instanceState: String(instance.InstanceState ?? ""),
      blueprintId: String(instance.BlueprintId ?? ""),
      publicIp: Array.isArray(instance.PublicAddresses)
        ? instance.PublicAddresses.join(", ")
        : "",
      privateIp: Array.isArray(instance.PrivateAddresses)
        ? instance.PrivateAddresses.join(", ")
        : "",
      zone: String(instance.Zone ?? ""),
      createdAt: String(instance.CreatedTime ?? ""),
      instanceId: String(instance.InstanceId ?? ""),
    },
  }));
}

export async function resolveLighthouseInstanceId(
  credentials: TencentCredentials,
  region: string,
  identifier: string,
): Promise<string> {
  const safeRegion = assertTencentRegion(region);
  const instances = await listInstancesRaw(
    credentials,
    safeRegion,
    "lighthouse",
    "2020-03-24",
  );
  const match = instances.find(
    (instance) =>
      String(instance.InstanceId ?? "") === identifier ||
      String(instance.InstanceName ?? "") === identifier ||
      (Array.isArray(instance.PublicAddresses) &&
        instance.PublicAddresses.map(String).includes(identifier)),
  );
  return String(match?.InstanceId ?? "");
}

export interface LighthouseFirewallRule {
  protocol: string;
  port: string;
  cidrBlock: string;
  action: string;
  description: string;
}

export async function listLighthouseFirewallRules(
  credentials: TencentCredentials,
  region: string,
  instanceId: string,
): Promise<LighthouseFirewallRule[]> {
  const safeRegion = assertTencentRegion(region);
  const { json } = await callTencentApi({
    ...credentials,
    service: "lighthouse",
    host: `lighthouse.${safeRegion}.tencentcloudapi.com`,
    region: safeRegion,
    action: "DescribeFirewallRules",
    version: "2020-03-24",
    payload: { InstanceId: instanceId, Limit: 100, Offset: 0 },
  });
  const rules = Array.isArray(json.FirewallRuleSet) ? json.FirewallRuleSet : [];
  return rules.map((rule: Record<string, any>) => ({
    protocol: String(rule.Protocol ?? ""),
    port: String(rule.Port ?? ""),
    cidrBlock: String(rule.CidrBlock ?? ""),
    action: String(rule.Action ?? ""),
    description: String(rule.FirewallRuleDescription ?? ""),
  }));
}

export async function openLighthouseFirewallPort(
  credentials: TencentCredentials,
  region: string,
  instanceId: string,
  port: number,
  description: string,
): Promise<{ added: boolean; rules: LighthouseFirewallRule[] }> {
  const safeRegion = assertTencentRegion(region);
  const existing = await listLighthouseFirewallRules(
    credentials,
    safeRegion,
    instanceId,
  );
  const targetPort = String(port);
  const alreadyOpen = existing.some(
    (rule) =>
      rule.protocol.toUpperCase() === "TCP" &&
      rule.port === targetPort &&
      rule.cidrBlock === "0.0.0.0/0" &&
      rule.action.toUpperCase() === "ACCEPT",
  );
  if (alreadyOpen) return { added: false, rules: existing };

  const nextRules = [
    ...existing.map((rule) => ({
      Protocol: rule.protocol,
      Port: rule.port,
      CidrBlock: rule.cidrBlock,
      Action: rule.action,
      FirewallRuleDescription: rule.description,
    })),
    {
      Protocol: "TCP",
      Port: targetPort,
      CidrBlock: "0.0.0.0/0",
      Action: "ACCEPT",
      FirewallRuleDescription: description.slice(0, 64) || `开放 TCP ${targetPort}`,
    },
  ];
  await callTencentApi({
    ...credentials,
    service: "lighthouse",
    host: `lighthouse.${safeRegion}.tencentcloudapi.com`,
    region: safeRegion,
    action: "ModifyFirewallRules",
    version: "2020-03-24",
    payload: { InstanceId: instanceId, FirewallRules: nextRules },
  });
  return {
    added: true,
    rules: await listLighthouseFirewallRules(credentials, safeRegion, instanceId),
  };
}

async function probeInstancesAcrossRegions(
  credentials: TencentCredentials,
  service: string,
  version: string,
  mapper: (
    instance: Record<string, any>,
    region: string,
  ) => CloudResourceResult,
  concurrency = 4,
): Promise<CloudResourceResult[]> {
  let regions: string[] = [];
  try {
    regions = await describeTencentRegions(credentials, service, version);
  } catch {
    return [];
  }
  const results: CloudResourceResult[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, regions.length) },
    async () => {
      while (cursor < regions.length) {
        const region = regions[cursor++] ?? "";
        if (!region) continue;
        try {
          const instances = await listInstancesRaw(
            credentials,
            region,
            service,
            version,
          );
          results.push(
            ...instances.map((instance) => mapper(instance, region)),
          );
        } catch {
          // 单个地域失败跳过。
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function probeCvmAcrossRegions(
  credentials: TencentCredentials,
): Promise<CloudResourceResult[]> {
  return probeInstancesAcrossRegions(
    credentials,
    "cvm",
    "2017-03-12",
    (instance, region) => ({
      id: String(instance.InstanceId ?? ""),
      type: "CVM",
      name: String(instance.InstanceName || instance.InstanceId || ""),
      status: instance.InstanceState === "RUNNING" ? "healthy" : "unknown",
      region,
      attributes: {
        instanceType: String(instance.InstanceType ?? ""),
        osName: String(instance.OsName ?? ""),
        cpu: Number(instance.CPU ?? 0),
        memory: Number(instance.Memory ?? 0),
        publicIp: Array.isArray(instance.PublicIpAddresses)
          ? instance.PublicIpAddresses.join(", ")
          : "",
        privateIp: Array.isArray(instance.PrivateIpAddresses)
          ? instance.PrivateIpAddresses.join(", ")
          : "",
        instanceState: String(instance.InstanceState ?? ""),
        chargeType: String(instance.InstanceChargeType ?? ""),
        createdAt: String(instance.CreatedTime ?? ""),
        instanceId: String(instance.InstanceId ?? ""),
      },
    }),
  );
}

export async function probeLighthouseAcrossRegions(
  credentials: TencentCredentials,
): Promise<CloudResourceResult[]> {
  return probeInstancesAcrossRegions(
    credentials,
    "lighthouse",
    "2020-03-24",
    (instance, region) => ({
      id: String(instance.InstanceId ?? ""),
      type: "Lighthouse",
      name: String(instance.InstanceName || instance.InstanceId || ""),
      status: instance.InstanceState === "RUNNING" ? "healthy" : "unknown",
      region,
      attributes: {
        instanceState: String(instance.InstanceState ?? ""),
        blueprintId: String(instance.BlueprintId ?? ""),
        publicIp: Array.isArray(instance.PublicAddresses)
          ? instance.PublicAddresses.join(", ")
          : "",
        privateIp: Array.isArray(instance.PrivateAddresses)
          ? instance.PrivateAddresses.join(", ")
          : "",
        zone: String(instance.Zone ?? ""),
        createdAt: String(instance.CreatedTime ?? ""),
      },
    }),
  );
}

const COMMON_REGIONS = [
  "ap-guangzhou",
  "ap-shanghai",
  "ap-beijing",
  "ap-chengdu",
  "ap-nanjing",
  "ap-chongqing",
  "ap-hongkong",
  "ap-singapore",
  "na-siliconvalley",
  "eu-frankfurt",
];

const EXTRA_REGIONS = [
  "ap-jakarta",
  "ap-seoul",
  "ap-tokyo",
  "ap-bangkok",
  "ap-mumbai",
  "na-ashburn",
  "na-toronto",
  "sa-saopaulo",
  "eu-moscow",
  "ap-shanghai-fsi",
  "ap-beijing-fsi",
  "ap-shenzhen-fsi",
];

interface ScanTask<T> {
  label: string;
  run: () => Promise<T>;
}

interface ScanPoolResult<T> {
  values: T[];
  warnings: string[];
}

async function runPool<T>(
  tasks: Array<ScanTask<T>>,
  concurrency: number,
): Promise<ScanPoolResult<T>> {
  const results: Array<{ index: number; value: T }> = [];
  const warnings: string[] = [];
  const warningKeys = new Set<string>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const index = cursor++;
        const task = tasks[index];
        if (!task) continue;
        try {
          results.push({ index, value: await task.run() });
        } catch (error) {
          // 部分腾讯云产品只在特定地域开放。探测其他地域时返回该错误
          // 属于正常发现过程，不应污染同步告警。
          if (
            error instanceof TencentApiError &&
            (error.code === "UnsupportedRegion" ||
              error.code === "InvalidParameterValue.UnsupportedRegion")
          ) {
            continue;
          }
          const message =
            error instanceof Error ? error.message : "未知同步错误";
          const warningKey = `${task.label.replace(/（.*$/, "")}|${message.replace(
            /（RequestId [^）]+）/g,
            "",
          )}`;
          if (!warningKeys.has(warningKey) && warnings.length < 30) {
            warningKeys.add(warningKey);
            warnings.push(`${task.label}：${message}`);
          }
        }
      }
    },
  );
  await Promise.all(workers);
  results.sort((left, right) => left.index - right.index);
  return {
    values: results.map((item) => item.value),
    warnings,
  };
}

interface RegionalScanSpec {
  service: string;
  version: string;
  action: string;
  type: string;
  payload: Record<string, unknown>;
  map: (raw: Record<string, any>, region: string) => CloudResourceResult[];
}

const REGIONAL_SCANS: RegionalScanSpec[] = [
  {
    service: "cvm",
    version: "2017-03-12",
    action: "DescribeInstances",
    type: "CVM",
    payload: { Limit: 100 },
    map: (raw, region) =>
      (Array.isArray(raw.InstanceSet) ? raw.InstanceSet : []).map((item) => ({
        id: String(item.InstanceId ?? ""),
        type: "CVM",
        name: String(item.InstanceName || item.InstanceId || ""),
        status: item.InstanceState === "RUNNING" ? "healthy" : "unknown",
        region,
        attributes: {
          instanceType: String(item.InstanceType ?? ""),
          osName: String(item.OsName ?? ""),
          cpu: Number(item.CPU ?? 0),
          memory: Number(item.Memory ?? 0),
          publicIp: Array.isArray(item.PublicIpAddresses)
            ? item.PublicIpAddresses.join(", ")
            : "",
          privateIp: Array.isArray(item.PrivateIpAddresses)
            ? item.PrivateIpAddresses.join(", ")
            : "",
          instanceState: String(item.InstanceState ?? ""),
          chargeType: String(item.InstanceChargeType ?? ""),
          createdAt: String(item.CreatedTime ?? ""),
        },
      })),
  },
  {
    service: "lighthouse",
    version: "2020-03-24",
    action: "DescribeInstances",
    type: "Lighthouse",
    payload: { Limit: 100 },
    map: (raw, region) =>
      (Array.isArray(raw.InstanceSet) ? raw.InstanceSet : []).map((item) => ({
        id: String(item.InstanceId ?? ""),
        type: "Lighthouse",
        name: String(item.InstanceName || item.InstanceId || ""),
        status: item.InstanceState === "RUNNING" ? "healthy" : "unknown",
        region,
        attributes: {
          instanceState: String(item.InstanceState ?? ""),
          blueprintId: String(item.BlueprintId ?? ""),
          publicIp: Array.isArray(item.PublicAddresses)
            ? item.PublicAddresses.join(", ")
            : "",
          privateIp: Array.isArray(item.PrivateAddresses)
            ? item.PrivateAddresses.join(", ")
            : "",
          zone: String(item.Zone ?? ""),
          createdAt: String(item.CreatedTime ?? ""),
        },
      })),
  },
  {
    service: "vpc",
    version: "2017-03-12",
    action: "DescribeVpcs",
    type: "VPC",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.VpcSet) ? raw.VpcSet : []).map((item) => ({
        id: String(item.VpcId ?? ""),
        type: "VPC",
        name: String(item.VpcName || item.VpcId || ""),
        status: "healthy",
        region,
        attributes: {
          cidr: String(item.CidrBlock ?? ""),
          isDefault: Boolean(item.IsDefault),
        },
      })),
  },
  {
    service: "vpc",
    version: "2017-03-12",
    action: "DescribeAddresses",
    type: "EIP",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.AddressSet) ? raw.AddressSet : []).map((item) => ({
        id: String(item.AddressId ?? ""),
        type: "EIP",
        name: String(item.AddressName || item.AddressIp || item.AddressId || ""),
        status: item.AddressStatus === "BIND" ? "healthy" : "warning",
        region,
        attributes: {
          addressIp: String(item.AddressIp ?? ""),
          status: String(item.AddressStatus ?? ""),
          instanceId: String(item.InstanceId ?? ""),
        },
      })),
  },
  {
    service: "vpc",
    version: "2017-03-12",
    action: "DescribeSecurityGroups",
    type: "SecurityGroup",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.SecurityGroupSet) ? raw.SecurityGroupSet : []).map(
        (item) => ({
          id: String(item.SecurityGroupId ?? ""),
          type: "SecurityGroup",
          name: String(item.SecurityGroupName || item.SecurityGroupId || ""),
          status: "healthy",
          region,
          attributes: {
            projectId: String(item.ProjectId ?? ""),
          },
        }),
      ),
  },
  {
    service: "clb",
    version: "2018-03-17",
    action: "DescribeLoadBalancers",
    type: "CLB",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.LoadBalancerSet) ? raw.LoadBalancerSet : []).map(
        (item) => ({
          id: String(item.LoadBalancerId ?? ""),
          type: "CLB",
          name: String(item.LoadBalancerName || item.LoadBalancerId || ""),
          status: item.Status === 1 ? "healthy" : "unknown",
          region,
          attributes: {
            type: String(item.LoadBalancerType ?? ""),
            vip: String(item.Vip ?? ""),
          },
        }),
      ),
  },
  {
    service: "cbs",
    version: "2017-03-12",
    action: "DescribeDisks",
    type: "CBS",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.DiskSet) ? raw.DiskSet : []).map((item) => ({
        id: String(item.DiskId ?? ""),
        type: "CBS",
        name: String(item.DiskName || item.DiskId || ""),
        status: item.DiskState === "ATTACHED" ? "healthy" : "unknown",
        region,
        attributes: {
          diskType: String(item.DiskType ?? ""),
          diskSize: Number(item.DiskSize ?? 0),
          attachedTo: String(item.InstanceId ?? ""),
        },
      })),
  },
  {
    service: "cdb",
    version: "2017-03-20",
    action: "DescribeDBInstances",
    type: "CDB",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.Items) ? raw.Items : []).map((item) => ({
        id: String(item.InstanceId ?? ""),
        type: "CDB",
        name: String(item.InstanceName || item.InstanceId || ""),
        status: item.Status === 1 ? "healthy" : "unknown",
        region,
        attributes: {
          engineVersion: String(item.EngineVersion ?? ""),
          vip: String(item.Vip ?? ""),
          port: Number(item.Vport ?? 3306),
        },
      })),
  },
  {
    service: "redis",
    version: "2018-04-12",
    action: "DescribeInstances",
    type: "Redis",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.InstanceSet) ? raw.InstanceSet : []).map((item) => ({
        id: String(item.InstanceId ?? ""),
        type: "Redis",
        name: String(item.InstanceName || item.InstanceId || ""),
        status: item.Status === 2 ? "healthy" : "unknown",
        region,
        attributes: {
          type: Number(item.Type ?? 0),
          vip: String(item.WanIp ?? ""),
          port: Number(item.Port ?? 6379),
        },
      })),
  },
  {
    service: "cynosdb",
    version: "2019-01-07",
    action: "DescribeClusters",
    type: "CynosDB",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.ClusterSet) ? raw.ClusterSet : []).map((item) => ({
        id: String(item.ClusterId ?? ""),
        type: "CynosDB",
        name: String(item.ClusterName || item.ClusterId || ""),
        status: item.Status === "running" ? "healthy" : "unknown",
        region,
        attributes: {
          dbVersion: String(item.DbVersion ?? ""),
          status: String(item.Status ?? ""),
          vip: String(item.Vip ?? ""),
          port: Number(item.Vport ?? 3306),
        },
      })),
  },
  {
    service: "tke",
    version: "2018-05-25",
    action: "DescribeClusters",
    type: "TKE",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.Clusters) ? raw.Clusters : []).map((item) => ({
        id: String(item.ClusterId ?? ""),
        type: "TKE",
        name: String(item.ClusterName || item.ClusterId || ""),
        status: item.ClusterStatus === "Running" ? "healthy" : "unknown",
        region,
        attributes: {
          version: String(item.ClusterVersion ?? ""),
          nodeCount: Number(item.NodeCount ?? 0),
        },
      })),
  },
  {
    service: "cfs",
    version: "2019-07-19",
    action: "DescribeCfsFileSystems",
    type: "CFS",
    payload: {},
    map: (raw, region) =>
      (Array.isArray(raw.CfsFileSystems) ? raw.CfsFileSystems : []).map(
        (item) => ({
          id: String(item.FileSystemId ?? ""),
          type: "CFS",
          name: String(item.FsName || item.FileSystemId || ""),
          status: item.LifeCycleState === "available" ? "healthy" : "unknown",
          region,
          attributes: {
            protocol: String(item.Protocol ?? ""),
            size: Number(item.SizeByte ?? 0),
          },
        }),
      ),
  },
];

interface RegionlessScanSpec {
  service: string;
  version: string;
  action: string;
  type: string;
  payload: Record<string, unknown>;
  map: (raw: Record<string, any>) => CloudResourceResult[];
}

const REGIONLESS_SCANS: RegionlessScanSpec[] = [
  {
    service: "cdn",
    version: "2018-06-06",
    action: "DescribeDomains",
    type: "CDN",
    payload: { Offset: 0, Limit: 100 },
    map: (raw) =>
      (Array.isArray(raw.Domains) ? raw.Domains : []).map((item) => ({
        id: String(item.Domain ?? ""),
        type: "CDN",
        name: String(item.Domain ?? ""),
        status: item.Status === "online" ? "healthy" : "unknown",
        region: "全局",
        attributes: {
          serviceType: String(item.ServiceType ?? ""),
          status: String(item.Status ?? ""),
        },
      })),
  },
  {
    service: "ssl",
    version: "2019-12-05",
    action: "DescribeCertificates",
    type: "SSL",
    payload: { Offset: 0, Limit: 100 },
    map: (raw) =>
      (Array.isArray(raw.Certificates) ? raw.Certificates : []).map((item) => ({
        id: String(item.CertificateId ?? ""),
        type: "SSL",
        name: String(item.Alias || item.Domain || item.CertificateId || ""),
        status: item.Status === 1 ? "healthy" : "unknown",
        region: "全局",
        attributes: {
          domain: String(item.Domain ?? ""),
          certType: String(item.CertType ?? ""),
          expiredAt: String(item.CertEndTime ?? ""),
        },
      })),
  },
];

const criticalDomainStatuses = new Set([
  "serverHold",
  "clientHold",
  "redemptionPeriod",
  "pendingDelete",
]);

const warningDomainStatuses = new Set([
  "pendingVerification",
  "pendingTransfer",
  "pendingRenew",
]);

function domainStatusText(status: string): string {
  const labels: Record<string, string> = {
    ok: "正常",
    serverHold: "注册局暂停解析",
    clientHold: "注册商暂停解析",
    redemptionPeriod: "赎回期",
    pendingDelete: "待删除",
    pendingVerification: "待实名认证",
    pendingTransfer: "转移中",
  };
  return labels[status] || status;
}

function buyStatusText(status: string): string {
  const labels: Record<string, string> = {
    ok: "正常",
    AboutToExpire: "即将到期",
    RenewPending: "续费期",
    RedemptionPending: "赎回期",
  };
  return labels[status] || status || "未知";
}

function autoRenewText(value: unknown): string {
  const normalized = Number(value);
  if (normalized === 1) return "已开启";
  if (normalized === 2) return "已关闭";
  return "未开启";
}

function domainHealth(
  statuses: string[],
  buyStatus: string,
  expiresAt: string,
): CloudResourceResult["status"] {
  if (
    statuses.some((status) => criticalDomainStatuses.has(status)) ||
    buyStatus === "RedemptionPending"
  ) {
    return "critical";
  }
  const expiry = Date.parse(expiresAt.replace(" ", "T"));
  if (Number.isFinite(expiry)) {
    const daysToExpiry = (expiry - Date.now()) / 86_400_000;
    if (daysToExpiry <= 0) return "critical";
    if (daysToExpiry <= 30) return "warning";
  }
  if (
    statuses.some((status) => warningDomainStatuses.has(status)) ||
    statuses.some((status) => status !== "ok") ||
    buyStatus === "AboutToExpire" ||
    buyStatus === "RenewPending"
  ) {
    return "warning";
  }
  if (statuses.length === 0 && !expiresAt) return "unknown";
  return "healthy";
}

export async function listRegisteredTencentDomains(
  credentials: TencentCredentials,
): Promise<CloudResourceResult[]> {
  const resources: CloudResourceResult[] = [];
  const limit = 100;
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  for (let page = 0; page < 1_000 && offset < totalCount; page += 1) {
    const { json } = await callTencentApi({
      ...credentials,
      service: "domain",
      host: "domain.tencentcloudapi.com",
      region: "",
      action: "DescribeDomainNameList",
      version: "2018-08-08",
      payload: { Offset: offset, Limit: limit },
    });
    const items = Array.isArray(json.DomainSet) ? json.DomainSet : [];
    totalCount = Number(json.TotalCount ?? offset + items.length);
    if (!Number.isFinite(totalCount)) {
      totalCount = offset + items.length;
    }

    for (const item of items as Array<Record<string, any>>) {
      const statuses = Array.isArray(item.DomainStatus)
        ? item.DomainStatus.map((value: unknown) => String(value)).filter(Boolean)
        : [];
      const buyStatus = String(item.BuyStatus ?? "");
      const expiresAt = String(item.ExpirationDate ?? "");
      resources.push({
        id: String(item.DomainId ?? item.DomainName ?? ""),
        type: "Domain",
        name: String(item.DomainName ?? item.DomainId ?? ""),
        status: domainHealth(statuses, buyStatus, expiresAt),
        region: "全局",
        attributes: {
          domainId: String(item.DomainId ?? ""),
          domainStatus: statuses.join(", "),
          domainStatusText:
            statuses.map(domainStatusText).join("、") || "未知",
          buyStatus,
          buyStatusText: buyStatusText(buyStatus),
          autoRenew: Number(item.AutoRenew ?? 0),
          autoRenewText: autoRenewText(item.AutoRenew),
          createdAt: String(item.CreationDate ?? ""),
          expiresAt,
          tld: String(item.Tld ?? ""),
          codeTld: String(item.CodeTld ?? ""),
          isPremium: Boolean(item.IsPremium),
        },
      });
    }

    if (items.length === 0) break;
    offset += items.length;
    if (items.length < limit) break;
  }

  return resources;
}

export async function listTencentDnsPodDomains(
  credentials: TencentCredentials,
): Promise<CloudResourceResult[]> {
  const resources: CloudResourceResult[] = [];
  const limit = 200;
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  for (let page = 0; page < 1_000 && offset < totalCount; page += 1) {
    const { json } = await callTencentApi({
      ...credentials,
      service: "dnspod",
      host: "dnspod.tencentcloudapi.com",
      region: "",
      action: "DescribeDomainList",
      version: "2021-03-23",
      payload: { Offset: offset, Limit: limit },
    });
    const items = Array.isArray(json.DomainList) ? json.DomainList : [];
    const countInfo =
      json.DomainCountInfo && typeof json.DomainCountInfo === "object"
        ? (json.DomainCountInfo as Record<string, unknown>)
        : {};
    totalCount = Number(
      countInfo.AllTotal ??
        countInfo.DomainTotal ??
        json.TotalCount ??
        offset + items.length,
    );
    if (!Number.isFinite(totalCount)) {
      totalCount = offset + items.length;
    }

    for (const item of items as Array<Record<string, any>>) {
      resources.push({
        id: String(item.DomainId ?? item.Name ?? ""),
        type: "DNSPod",
        name: String(item.Name ?? item.DomainId ?? ""),
        status: item.Status === "ENABLE" ? "healthy" : "warning",
        region: "全局",
        attributes: {
          status: String(item.Status ?? ""),
          recordCount: Number(item.RecordCount ?? 0),
          grade: String(item.Grade ?? ""),
          effectiveDns: String(item.EffectiveDNS ?? ""),
        },
      });
    }

    if (items.length === 0) break;
    offset += items.length;
    if (items.length < limit) break;
  }

  return resources;
}

export interface DnsPodRecord {
  recordId: string;
  domain: string;
  subdomain: string;
  recordType: string;
  value: string;
  ttl: number;
  recordLine: string;
  status: string;
  updatedAt: string;
}

export async function listDnsPodRecords(
  credentials: TencentCredentials,
  domain: string,
  subdomain?: string,
): Promise<DnsPodRecord[]> {
  const records: DnsPodRecord[] = [];
  const limit = 100;
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  for (let page = 0; page < 1_000 && offset < totalCount; page += 1) {
    const { json } = await callTencentApi({
      ...credentials,
      service: "dnspod",
      host: "dnspod.tencentcloudapi.com",
      region: "",
      action: "DescribeRecordList",
      version: "2021-03-23",
      payload: {
        Domain: domain,
        ...(subdomain ? { Subdomain: subdomain } : {}),
        Offset: offset,
        Limit: limit,
      },
    });
    const items = Array.isArray(json.RecordList) ? json.RecordList : [];
    const countInfo =
      json.RecordCountInfo && typeof json.RecordCountInfo === "object"
        ? (json.RecordCountInfo as Record<string, unknown>)
        : {};
    totalCount = Number(
      countInfo.TotalCount ?? json.TotalCount ?? offset + items.length,
    );
    if (!Number.isFinite(totalCount)) {
      totalCount = offset + items.length;
    }

    for (const item of items as Array<Record<string, any>>) {
      records.push({
        recordId: String(item.RecordId ?? ""),
        domain,
        subdomain: String(item.Name ?? item.SubDomain ?? ""),
        recordType: String(item.Type ?? item.RecordType ?? ""),
        value: String(item.Value ?? ""),
        ttl: Number(item.TTL ?? 0),
        recordLine: String(item.Line ?? ""),
        status: String(item.Status ?? ""),
        updatedAt: String(item.UpdatedOn ?? ""),
      });
    }

    if (items.length === 0) break;
    offset += items.length;
    if (items.length < limit) break;
  }

  return records;
}

export async function createDnsPodRecord(
  credentials: TencentCredentials,
  input: {
    domain: string;
    subdomain: string;
    recordType: "A";
    value: string;
    ttl: number;
    recordLine?: string;
    remark?: string;
  },
): Promise<{ recordId: string; requestId: string }> {
  const { json, requestId } = await callTencentApi({
    ...credentials,
    service: "dnspod",
    host: "dnspod.tencentcloudapi.com",
    region: "",
    action: "CreateRecord",
    version: "2021-03-23",
    payload: {
      Domain: input.domain,
      SubDomain: input.subdomain,
      RecordType: input.recordType,
      RecordLine: input.recordLine || "默认",
      Value: input.value,
      TTL: input.ttl,
      Status: "ENABLE",
      ...(input.remark ? { Remark: input.remark.slice(0, 200) } : {}),
    },
  });
  const recordId = String(json.RecordId ?? "");
  if (!recordId) {
    throw new Error(
      `腾讯云未返回 DNS 记录 ID${requestId ? `（RequestId ${requestId}）` : ""}。`,
    );
  }
  return { recordId, requestId };
}

export async function deleteDnsPodRecord(
  credentials: TencentCredentials,
  domain: string,
  recordId: string,
): Promise<{ requestId: string }> {
  const numericRecordId = Number(recordId);
  if (!Number.isSafeInteger(numericRecordId) || numericRecordId <= 0) {
    throw new Error("DNS 记录 ID 格式不正确，已阻止删除。");
  }
  const { requestId } = await callTencentApi({
    ...credentials,
    service: "dnspod",
    host: "dnspod.tencentcloudapi.com",
    region: "",
    action: "DeleteRecord",
    version: "2021-03-23",
    payload: {
      Domain: domain,
      RecordId: numericRecordId,
    },
  });
  return { requestId };
}

export async function listCosBuckets(
  credentials: TencentCredentials,
): Promise<CloudResourceResult[]> {
  const now = Math.floor(Date.now() / 1000);
  const signTime = `${now};${now + 900}`;
  const signKey = crypto
    .createHmac("sha1", credentials.secretKey)
    .update(signTime)
    .digest();
  const httpString = "get\n/\n\nhost=service.cos.myqcloud.com\n";
  const stringToSign = `sha1\n${signTime}\n${sha256Hex(httpString)}\n`;
  const signature = crypto
    .createHmac("sha1", signKey)
    .update(stringToSign)
    .digest();
  const authorization = [
    "q-sign-algorithm=sha1",
    `q-ak=${credentials.secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    "q-header-list=host",
    "q-url-param-list=",
    `q-signature=${signature.toString("hex")}`,
  ].join("&");
  let response: Response;
  try {
    response = await fetch("https://service.cos.myqcloud.com/", {
      method: "GET",
      headers: {
        Host: "service.cos.myqcloud.com",
        Authorization: authorization,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return [];
  }
  const text = await response.text();
  if (!response.ok) {
    return [];
  }
  const buckets: CloudResourceResult[] = [];
  const bucketPattern = /<Bucket>\s*<Name>([^<]+)<\/Name>\s*<Location>([^<]*)<\/Location>[\s\S]*?<\/Bucket>/g;
  for (const match of text.matchAll(bucketPattern)) {
    const name = match[1] ?? "";
    const location = match[2] ?? "";
    if (!name) continue;
    buckets.push({
      id: name,
      type: "COS",
      name,
      status: "healthy",
      region: location || "全局",
      attributes: { location: location || "" },
    });
  }
  return buckets;
}

export function parseTencentMetricValues(
  json: Record<string, any>,
  fallbackInstanceIds: string[] = [],
): Map<string, number> {
  const values = new Map<string, { timestamp: number; value: number }>();
  const points = Array.isArray(json.DataPoints) ? json.DataPoints : [];
  for (const point of points) {
    const dimensions = Array.isArray(point?.Dimensions)
      ? point.Dimensions
      : [];
    const dimension = dimensions.find(
      (item: Record<string, any>) => item?.Name === "InstanceId",
    );
    const fallbackId =
      fallbackInstanceIds.length === 1 ? fallbackInstanceIds[0] : "";
    const instanceId = String(dimension?.Value || fallbackId);
    if (!instanceId || !Array.isArray(point?.Values)) continue;
    const timestamps = Array.isArray(point.Timestamps)
      ? point.Timestamps
      : [];
    point.Values.forEach((rawValue: unknown, index: number) => {
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim()
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(value)) return;
      const parsedTimestamp = Number(timestamps[index] ?? index);
      const timestamp = Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : index;
      const previous = values.get(instanceId);
      if (!previous || timestamp >= previous.timestamp) {
        values.set(instanceId, { timestamp, value });
      }
    });
  }
  return new Map(
    Array.from(values, ([instanceId, point]) => [instanceId, point.value]),
  );
}

interface TencentMetricQueryResult {
  values: Map<string, number>;
  requestId: string;
  error?: string;
}

async function queryTencentMetric(
  credentials: TencentCredentials,
  region: string,
  namespace: string,
  metricName: string,
  instanceIds: string[],
): Promise<TencentMetricQueryResult> {
  const values = new Map<string, number>();
  const requestIds = new Set<string>();
  const errors: string[] = [];
  for (let index = 0; index < instanceIds.length; index += 50) {
    const batch = instanceIds.slice(index, index + 50);
    try {
      const { json, requestId } = await callTencentApi({
        ...credentials,
        service: "monitor",
        host: "monitor.tencentcloudapi.com",
        region,
        action: "GetMonitorData",
        version: "2018-07-24",
        payload: {
          Namespace: namespace,
          MetricName: metricName,
          Instances: batch.map((instanceId) => ({
            Dimensions: [{ Name: "InstanceId", Value: instanceId }],
          })),
          Period: 60,
        },
      });
      if (requestId) requestIds.add(requestId);
      for (const [instanceId, value] of parseTencentMetricValues(json, batch)) {
        values.set(instanceId, value);
      }
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : `${metricName} 查询失败`,
      );
    }
  }
  return {
    values,
    requestId: Array.from(requestIds).join(","),
    error: errors.length > 0 ? errors.join("；") : undefined,
  };
}

interface TencentMetricSpec {
  type: "CVM" | "Lighthouse";
  namespace: string;
  cpuMetric: string;
  memoryMetric: string;
}

const TENCENT_METRIC_SPECS: TencentMetricSpec[] = [
  {
    type: "CVM",
    namespace: "QCE/CVM",
    cpuMetric: "CpuUsage",
    memoryMetric: "MemUsage",
  },
  {
    type: "Lighthouse",
    namespace: "QCE/LIGHTHOUSE",
    cpuMetric: "CpuUsage",
    memoryMetric: "MemUsage",
  },
];

async function attachTencentMetrics(
  credentials: TencentCredentials,
  resources: CloudResourceResult[],
): Promise<CloudResourceResult[]> {
  const tasks: Array<{
    label: string;
    run: () => Promise<CloudResourceResult[]>;
  }> = [];
  for (const spec of TENCENT_METRIC_SPECS) {
    const byRegion = new Map<string, CloudResourceResult[]>();
    for (const resource of resources) {
      if (resource.type !== spec.type || !resource.id) continue;
      const list = byRegion.get(resource.region) ?? [];
      list.push(resource);
      byRegion.set(resource.region, list);
    }
    for (const [region, regionResources] of byRegion) {
      tasks.push({
        label: `${spec.type} 监控（${region}）`,
        run: async () => {
          const instanceIds = regionResources.map((resource) => resource.id);
          const [cpu, memory] = await Promise.all([
            queryTencentMetric(
              credentials,
              region,
              spec.namespace,
              spec.cpuMetric,
              instanceIds,
            ),
            queryTencentMetric(
              credentials,
              region,
              spec.namespace,
              spec.memoryMetric,
              instanceIds,
            ),
          ]);
          const updatedAt = new Date().toISOString();
          return regionResources.map((resource) => {
            const cpuPercent = cpu.values.get(resource.id);
            const memoryPercent = memory.values.get(resource.id);
            const errors = [cpu.error, memory.error].filter(Boolean) as string[];
            if (cpuPercent === undefined) errors.push(`${spec.cpuMetric} 暂无数据`);
            if (memoryPercent === undefined) {
              errors.push(`${spec.memoryMetric} 暂无数据`);
            }
            const status =
              cpuPercent !== undefined && memoryPercent !== undefined
                ? "ok"
                : cpuPercent !== undefined || memoryPercent !== undefined
                  ? "partial"
                  : "unavailable";
            return {
              ...resource,
              metrics: {
                status,
                ...(cpuPercent !== undefined ? { cpuPercent } : {}),
                ...(memoryPercent !== undefined ? { memoryPercent } : {}),
                cpuMetric: spec.cpuMetric,
                memoryMetric: spec.memoryMetric,
                periodSeconds: 60,
                updatedAt,
                requestId: [cpu.requestId, memory.requestId]
                  .filter(Boolean)
                  .join(","),
                ...(errors.length > 0 ? { error: errors.join("；") } : {}),
              },
              metricsUpdatedAt: updatedAt,
            };
          });
        },
      });
    }
  }
  const result = await runPool(tasks, 4);
  const withMetrics = new Map(
    result.values
      .flat()
      .map((resource) => [
        `${resource.type}:${resource.region}:${resource.id}`,
        resource,
      ]),
  );
  return resources.map(
    (resource) =>
      withMetrics.get(`${resource.type}:${resource.region}:${resource.id}`) ??
      resource,
  );
}

export async function scanAllTencentResources(
  credentials: TencentCredentials,
  configuredRegion: string,
): Promise<CloudScanResult> {
  const validRegion = (region: string) =>
    /^[a-z]{2}-[a-z]+(-\d+)?$/.test(region);

  const [cvmRegions, lighthouseRegions] = await Promise.all([
    describeTencentRegions(credentials, "cvm", "2017-03-12").catch(
      () => [] as string[],
    ),
    describeTencentRegions(credentials, "lighthouse", "2020-03-24").catch(
      () => [] as string[],
    ),
  ]);

  const baseRegions = Array.from(
    new Set(
      [
        configuredRegion,
        ...cvmRegions,
        ...lighthouseRegions,
        ...EXTRA_REGIONS,
        ...COMMON_REGIONS,
      ].filter(validRegion),
    ),
  );
  const cvmRegionSet =
    cvmRegions.filter(validRegion).length > 0
      ? cvmRegions.filter(validRegion)
      : baseRegions;
  const lighthouseRegionSet =
    lighthouseRegions.filter(validRegion).length > 0
      ? lighthouseRegions.filter(validRegion)
      : baseRegions;
  const regionsFor = (service: string) =>
    service === "cvm"
      ? cvmRegionSet
      : service === "lighthouse"
        ? lighthouseRegionSet
        : baseRegions;

  const regionalTasks: Array<ScanTask<CloudResourceResult[]>> = [];
  for (const spec of REGIONAL_SCANS) {
    for (const region of regionsFor(spec.service)) {
      regionalTasks.push({
        label: `${spec.type}（${region}）`,
        run: async () => {
          const { json } = await callTencentApi({
            ...credentials,
            service: spec.service,
            host: `${spec.service}.${region}.tencentcloudapi.com`,
            region,
            action: spec.action,
            version: spec.version,
            payload: spec.payload,
          });
          return spec.map(json, region);
        },
      });
    }
  }

  const regionlessTasks: Array<ScanTask<CloudResourceResult[]>> =
    REGIONLESS_SCANS.map((spec) => ({
      label: spec.type,
      run: async () => {
        const { json } = await callTencentApi({
          ...credentials,
          service: spec.service,
          host: `${spec.service}.tencentcloudapi.com`,
          region: "",
          action: spec.action,
          version: spec.version,
          payload: spec.payload,
        });
        return spec.map(json);
      },
    }));
  regionlessTasks.push(
    {
      label: "腾讯云注册域名",
      run: () => listRegisteredTencentDomains(credentials),
    },
    {
      label: "DNSPod 解析域名",
      run: () => listTencentDnsPodDomains(credentials),
    },
    {
      label: "COS 对象存储",
      run: () => listCosBuckets(credentials),
    },
  );

  const [regionalResults, regionlessResults] = await Promise.all([
    runPool(regionalTasks, 12),
    runPool(regionlessTasks, 4),
  ]);
  const resources = [
    ...regionalResults.values.flat(),
    ...regionlessResults.values.flat(),
  ];
  return {
    resources: await attachTencentMetrics(credentials, resources),
    warnings: [
      ...regionalResults.warnings,
      ...regionlessResults.warnings,
    ],
    complete:
      regionalResults.warnings.length === 0 &&
      regionlessResults.warnings.length === 0,
  };
}

export async function getTencentMonthlyBill(
  credentials: TencentCredentials,
  now = new Date(),
): Promise<number> {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  const beginTime = `${year}-${pad(month)}-01 00:00:00`;
  const endTime = `${year}-${pad(month)}-${pad(lastDay)} 23:59:59`;
  const { json } = await callTencentApi({
    ...credentials,
    service: "billing",
    host: "billing.tencentcloudapi.com",
    region: "",
    action: "DescribeBillSummaryByProduct",
    version: "2018-07-09",
    payload: { BeginTime: beginTime, EndTime: endTime, PayType: "consume" },
  });
  const total = Number(json.SummaryTotal?.RealTotalCost ?? 0);
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : 0;
}

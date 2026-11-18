import crypto from "node:crypto";
import type { CloudResourceResult, CloudScanResult } from "./cloud.js";

export interface AliyunCredentials {
  accessKeyId: string;
  secretKey: string;
}

type AliyunParamValue = string | number | boolean | undefined;

interface AliyunApiInput extends AliyunCredentials {
  service: string;
  host?: string;
  action: string;
  version: string;
  params?: Record<string, AliyunParamValue>;
  timeoutMs?: number;
}

interface AliyunScanSpec {
  service: string;
  action: string;
  version: string;
  pageSize: number;
  collection: (json: Record<string, any>) => Array<Record<string, any>>;
  map: (item: Record<string, any>, region: string) => CloudResourceResult;
}

const FALLBACK_REGIONS = [
  "cn-hangzhou",
  "cn-shanghai",
  "cn-nanjing",
  "cn-beijing",
  "cn-zhangjiakou",
  "cn-huhehaote",
  "cn-wulanchabu",
  "cn-shenzhen",
  "cn-heyuan",
  "cn-guangzhou",
  "cn-chengdu",
  "cn-hongkong",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-5",
  "ap-northeast-1",
  "ap-south-1",
  "eu-central-1",
  "eu-west-1",
  "us-west-1",
  "us-east-1",
  "me-east-1",
];

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === "" ? [] : [value];
}

function nestedList(
  value: unknown,
  parent: string,
  child: string,
): Array<Record<string, any>> {
  return asList(asRecord(value)[parent])
    .flatMap((item) => asList(asRecord(item)[child]))
    .map(asRecord);
}

function stringListFromAddress(value: unknown): string[] {
  return asList(asRecord(value).IpAddress)
    .map(String)
    .filter(Boolean);
}

function resourceStatus(
  status: string,
  healthy: string[],
  warning: string[] = [],
): CloudResourceResult["status"] {
  if (healthy.includes(status)) return "healthy";
  if (warning.includes(status)) return "warning";
  return status ? "unknown" : "unknown";
}

function status(name: string, healthy: string[], warning: string[] = []) {
  return resourceStatus(name, healthy, warning);
}

function encodeAliyunComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%20/g, "%20");
}

function compareAliyunParameters(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function aliyunRpcSignature(
  secretKey: string,
  parameters: Record<string, AliyunParamValue>,
): string {
  const canonicalQuery = Object.entries(parameters)
    .filter(([key, value]) => key !== "Signature" && value !== undefined)
    .sort(([left], [right]) => compareAliyunParameters(left, right))
    .map(
      ([key, value]) =>
        `${encodeAliyunComponent(key)}=${encodeAliyunComponent(String(value))}`,
    )
    .join("&");
  const stringToSign = `GET&%2F&${encodeAliyunComponent(canonicalQuery)}`;
  return crypto
    .createHmac("sha1", `${secretKey}&`)
    .update(stringToSign)
    .digest("base64");
}

export class AliyunApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
  ) {
    super(
      `阿里云接口错误：${code} - ${message}${
        requestId ? `（RequestId ${requestId}）` : ""
      }`,
    );
    this.name = "AliyunApiError";
  }
}

export async function callAliyunApi(
  input: AliyunApiInput,
): Promise<{ json: Record<string, any>; requestId: string }> {
  const parameters: Record<string, AliyunParamValue> = {
    AccessKeyId: input.accessKeyId,
    Action: input.action,
    Format: "JSON",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: input.version,
    ...input.params,
  };
  const signature = aliyunRpcSignature(input.secretKey, parameters);
  const query = Object.entries({ ...parameters, Signature: signature })
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => compareAliyunParameters(left, right))
    .map(
      ([key, value]) =>
        `${encodeAliyunComponent(key)}=${encodeAliyunComponent(String(value))}`,
    )
    .join("&");

  let response: Response;
  try {
    const host = input.host ?? `${input.service}.aliyuncs.com`;
    response = await fetch(`https://${host}/?${query}`, {
      method: "GET",
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "请求阿里云接口超时，请检查网络。"
        : `无法访问阿里云接口：${error instanceof Error ? error.message : "网络错误"}`;
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
    throw new Error(`阿里云接口返回无法解析的内容（HTTP ${response.status}）。`);
  }
  if (json.Code && json.Message) {
    throw new AliyunApiError(
      String(json.Code),
      String(json.Message),
      String(json.RequestId ?? ""),
    );
  }
  if (!response.ok) {
    throw new Error(`阿里云接口返回 HTTP ${response.status}。`);
  }
  return {
    json,
    requestId: String(json.RequestId ?? ""),
  };
}

export async function verifyAliyunAccount(
  credentials: AliyunCredentials,
): Promise<{
  accountId: string;
  arn: string;
  identityType: string;
  principalId: string;
}> {
  const { json } = await callAliyunApi({
    ...credentials,
    service: "sts",
    action: "GetCallerIdentity",
    version: "2015-04-01",
  });
  return {
    accountId: String(json.AccountId ?? ""),
    arn: String(json.Arn ?? ""),
    identityType: String(json.IdentityType ?? ""),
    principalId: String(json.PrincipalId ?? ""),
  };
}

async function describeAliyunInstance(
  credentials: AliyunCredentials,
  region: string,
  identifier: string,
) {
  const instanceParams = /^i-/i.test(identifier)
    ? { InstanceIds: JSON.stringify([identifier]) }
    : { PublicIpAddresses: JSON.stringify([identifier]) };
  const { json } = await callAliyunApi({
    ...credentials,
    service: "ecs",
    action: "DescribeInstances",
    version: "2014-05-26",
    params: {
      RegionId: assertAliyunRegion(region),
      ...instanceParams,
    },
  });
  const instance = nestedList(json, "Instances", "Instance")[0];
  if (!instance) throw new Error(`阿里云实例 ${identifier} 不存在。`);
  return {
    instanceId: String(instance.InstanceId ?? identifier),
    securityGroupIds: asList(
      asRecord(instance.SecurityGroupIds).SecurityGroupId,
    )
      .map(String)
      .filter(Boolean),
  };
}

export async function getAliyunInstanceSecurityGroups(
  credentials: AliyunCredentials,
  region: string,
  identifier: string,
) {
  const instance = await describeAliyunInstance(
    credentials,
    region,
    identifier,
  );
  return instance.securityGroupIds;
}

export async function listAliyunIngressRules(
  credentials: AliyunCredentials,
  region: string,
  identifier: string,
) {
  const instance = await describeAliyunInstance(
    credentials,
    region,
    identifier,
  );
  if (!instance.securityGroupIds.length) throw new Error("实例没有关联安全组。");
  const groups = [];
  for (const securityGroupId of instance.securityGroupIds) {
    const { json, requestId } = await callAliyunApi({
      ...credentials,
      service: "ecs",
      action: "DescribeSecurityGroupAttribute",
      version: "2014-05-26",
      params: {
        RegionId: assertAliyunRegion(region),
        SecurityGroupId: securityGroupId,
        Direction: "ingress",
      },
    });
    groups.push({
      securityGroupId,
      requestId,
      rules: asList(asRecord(json.Permissions).Permission).map((rule) => {
        const value = asRecord(rule);
        return {
          ipProtocol: String(value.IpProtocol ?? ""),
          portRange: String(value.PortRange ?? ""),
          sourceCidrIp: String(value.SourceCidrIp ?? ""),
          description: String(value.Description ?? ""),
          priority: Number(value.Priority ?? 0),
        };
      }),
    });
  }
  return groups;
}

export async function openAliyunSecurityGroupPort(
  credentials: AliyunCredentials,
  region: string,
  identifier: string,
  port: number,
  description = "",
) {
  const groups = await listAliyunIngressRules(
    credentials,
    region,
    identifier,
  );
  const portRange = `${port}/${port}`;
  const changedGroups: string[] = [];
  for (const group of groups) {
    const exists = group.rules.some(
      (rule) =>
        rule.ipProtocol.toLowerCase() === "tcp" &&
        rule.portRange === portRange &&
        rule.sourceCidrIp === "0.0.0.0/0",
    );
    if (exists) continue;
    await callAliyunApi({
      ...credentials,
      service: "ecs",
      action: "AuthorizeSecurityGroup",
      version: "2014-05-26",
      params: {
        RegionId: assertAliyunRegion(region),
        SecurityGroupId: group.securityGroupId,
        IpProtocol: "tcp",
        PortRange: portRange,
        SourceCidrIp: "0.0.0.0/0",
        Priority: 1,
        Description: (
          description || `AI DevOps 放行 TCP ${port}`
        ).slice(0, 80),
      },
    });
    changedGroups.push(group.securityGroupId);
  }
  return {
    added: changedGroups.length > 0,
    changedGroups,
    securityGroupIds: groups.map((group) => group.securityGroupId),
    port,
  };
}

export function assertAliyunRegion(region: string): string {
  if (!/^[a-z]{2,}(?:-[a-z0-9]+)+$/.test(region)) {
    throw new Error(
      "账号地域格式不正确（示例：cn-hangzhou）。请在编辑云账号时填写正确地域。",
    );
  }
  return region;
}

async function listAliyunRegions(
  credentials: AliyunCredentials,
): Promise<string[]> {
  const { json } = await callAliyunApi({
    ...credentials,
    service: "ecs",
    action: "DescribeRegions",
    version: "2014-05-26",
  });
  return nestedList(json, "Regions", "Region")
    .map((item) => String(item.RegionId ?? ""))
    .filter(Boolean);
}

async function listPaged(
  credentials: AliyunCredentials,
  spec: AliyunScanSpec,
  region: string,
): Promise<Array<Record<string, any>>> {
  const records: Array<Record<string, any>> = [];
  for (let page = 1; page <= 50; page += 1) {
    const { json } = await callAliyunApi({
      ...credentials,
      service: spec.service,
      action: spec.action,
      version: spec.version,
      params: {
        RegionId: region,
        PageNumber: page,
        PageSize: spec.pageSize,
      },
    });
    const batch = spec.collection(json);
    records.push(...batch);
    if (batch.length < spec.pageSize) break;
  }
  return records;
}

const SCAN_SPECS: AliyunScanSpec[] = [
  {
    service: "ecs",
    action: "DescribeInstances",
    version: "2014-05-26",
    pageSize: 100,
    collection: (json) => nestedList(json, "Instances", "Instance"),
    map: (instance, region) => {
      const currentStatus = String(instance.Status ?? "");
      const publicIps = stringListFromAddress(instance.PublicIpAddress);
      if (instance.EipAddress?.IpAddress) {
        publicIps.push(String(instance.EipAddress.IpAddress));
      }
      return {
        id: String(instance.InstanceId ?? ""),
        type: "ECS",
        name: String(instance.InstanceName || instance.InstanceId || ""),
        status: status(
          currentStatus,
          ["Running"],
          ["Stopped", "Starting", "Stopping"],
        ),
        region,
        attributes: {
          instanceType: String(instance.InstanceType ?? ""),
          osName: String(instance.OSName ?? ""),
          cpu: Number(instance.Cpu ?? 0),
          memory: Number(instance.Memory ?? 0),
          publicIp: Array.from(new Set(publicIps)).join(", "),
          privateIp: stringListFromAddress(
            asRecord(instance.VpcAttributes).PrivateIpAddress,
          ).join(", "),
          instanceState: currentStatus,
          chargeType: String(instance.InstanceChargeType ?? ""),
          zone: String(instance.ZoneId ?? ""),
          createdAt: String(instance.CreationTime ?? ""),
        },
      };
    },
  },
  {
    service: "vpc",
    action: "DescribeVpcs",
    version: "2016-04-28",
    pageSize: 50,
    collection: (json) => nestedList(json, "Vpcs", "Vpc"),
    map: (vpc, region) => {
      const currentStatus = String(vpc.Status ?? "");
      return {
        id: String(vpc.VpcId ?? ""),
        type: "VPC",
        name: String(vpc.VpcName || vpc.VpcId || ""),
        status: status(currentStatus, ["Available"]),
        region,
        attributes: {
          cidrBlock: String(vpc.CidrBlock ?? ""),
          vpcStatus: currentStatus,
          vRouterId: String(vpc.VRouterId ?? ""),
          isDefault: Boolean(vpc.IsDefault),
          createdAt: String(vpc.CreationTime ?? ""),
        },
      };
    },
  },
  {
    service: "slb",
    action: "DescribeLoadBalancers",
    version: "2014-05-15",
    pageSize: 100,
    collection: (json) =>
      nestedList(json, "LoadBalancers", "LoadBalancer"),
    map: (loadBalancer, region) => {
      const currentStatus = String(loadBalancer.LoadBalancerStatus ?? "");
      return {
        id: String(loadBalancer.LoadBalancerId ?? ""),
        type: "SLB",
        name: String(
          loadBalancer.LoadBalancerName ||
            loadBalancer.LoadBalancerId ||
            "",
        ),
        status: status(currentStatus.toLowerCase(), ["active"]),
        region,
        attributes: {
          address: String(loadBalancer.Address ?? ""),
          addressType: String(loadBalancer.AddressType ?? ""),
          loadBalancerStatus: currentStatus,
          vpcId: String(loadBalancer.VpcId ?? ""),
          vSwitchId: String(loadBalancer.VSwitchId ?? ""),
        },
      };
    },
  },
  {
    service: "rds",
    action: "DescribeDBInstances",
    version: "2014-08-15",
    pageSize: 100,
    collection: (json) => nestedList(json, "Items", "DBInstance"),
    map: (database, region) => {
      const currentStatus = String(database.DBInstanceStatus ?? "");
      return {
        id: String(database.DBInstanceId ?? ""),
        type: "RDS",
        name: String(
          database.DBInstanceDescription || database.DBInstanceId || "",
        ),
        status: status(
          currentStatus,
          ["Running"],
          ["Creating", "Changing", "BackingUp"],
        ),
        region,
        attributes: {
          engine: String(database.Engine ?? ""),
          engineVersion: String(database.EngineVersion ?? ""),
          instanceClass: String(database.DBInstanceClass ?? ""),
          dbInstanceStatus: currentStatus,
          zone: String(database.ZoneId ?? ""),
          connectionMode: String(database.ConnectionMode ?? ""),
        },
      };
    },
  },
];

async function runPool<T>(
  tasks: Array<{ label: string; run: () => Promise<T> }>,
  concurrency: number,
): Promise<{ values: T[]; warnings: string[]; succeeded: number }> {
  const values: T[] = [];
  const warnings: string[] = [];
  let succeeded = 0;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        if (!task) continue;
        try {
          values.push(await task.run());
          succeeded += 1;
        } catch (error) {
          warnings.push(
            `${task.label}：${
              error instanceof Error ? error.message : "查询失败"
            }`,
          );
        }
      }
    },
  );
  await Promise.all(workers);
  return { values, warnings, succeeded };
}

function dedupeWarnings(warnings: string[]): string[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = warning.replace(/（[^）]+）/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseAliyunMetricValues(value: unknown): Map<string, number> {
  let payload = value;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return new Map();
    }
  }
  const points = Array.isArray(payload) ? payload : [];
  const latest = new Map<string, { timestamp: number; value: number }>();
  for (const point of points) {
    const item = asRecord(point);
    const instanceId = String(
      item.instanceId ?? item.InstanceId ?? item.instanceID ?? "",
    );
    if (!instanceId) continue;
    const rawValue = item.Average ?? item.Value ?? item.average ?? item.value;
    const valueNumber =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string" && rawValue.trim()
          ? Number(rawValue)
          : Number.NaN;
    if (!Number.isFinite(valueNumber)) continue;
    const rawTimestamp = Number(item.timestamp ?? item.Timestamp);
    const timestamp = Number.isFinite(rawTimestamp) ? rawTimestamp : 0;
    const previous = latest.get(instanceId);
    if (!previous || timestamp >= previous.timestamp) {
      latest.set(instanceId, { timestamp, value: valueNumber });
    }
  }
  return new Map(
    Array.from(latest, ([instanceId, point]) => [instanceId, point.value]),
  );
}

interface AliyunMetricQueryResult {
  values: Map<string, number>;
  requestId: string;
  error?: string;
}

async function queryAliyunMetric(
  credentials: AliyunCredentials,
  region: string,
  metricName: string,
  instanceIds: string[],
): Promise<AliyunMetricQueryResult> {
  const values = new Map<string, number>();
  const requestIds = new Set<string>();
  const errors: string[] = [];
  for (let index = 0; index < instanceIds.length; index += 50) {
    const batch = instanceIds.slice(index, index + 50);
    try {
      const { json, requestId } = await callAliyunApi({
        ...credentials,
        service: "cms",
        host: `metrics.${region}.aliyuncs.com`,
        action: "DescribeMetricLast",
        version: "2019-01-01",
        params: {
          Namespace: "acs_ecs_dashboard",
          MetricName: metricName,
          Dimensions: JSON.stringify(
            batch.map((instanceId) => ({ instanceId })),
          ),
          Period: 60,
        },
      });
      if (requestId) requestIds.add(requestId);
      for (const [instanceId, value] of parseAliyunMetricValues(
        json.Datapoints,
      )) {
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

async function attachAliyunMetrics(
  credentials: AliyunCredentials,
  resources: CloudResourceResult[],
): Promise<CloudResourceResult[]> {
  const tasks: Array<{
    label: string;
    run: () => Promise<CloudResourceResult[]>;
  }> = [];
  const byRegion = new Map<string, CloudResourceResult[]>();
  for (const resource of resources) {
    if (resource.type !== "ECS" || !resource.id) continue;
    const list = byRegion.get(resource.region) ?? [];
    list.push(resource);
    byRegion.set(resource.region, list);
  }
  for (const [region, regionResources] of byRegion) {
    tasks.push({
      label: `ECS 监控（${region}）`,
      run: async () => {
        const instanceIds = regionResources.map((resource) => resource.id);
        const [cpu, memory] = await Promise.all([
          queryAliyunMetric(
            credentials,
            region,
            "cpu_total",
            instanceIds,
          ),
          queryAliyunMetric(
            credentials,
            region,
            "memory_usedutilization",
            instanceIds,
          ),
        ]);
        const updatedAt = new Date().toISOString();
        return regionResources.map((resource) => {
          const cpuPercent = cpu.values.get(resource.id);
          const memoryPercent = memory.values.get(resource.id);
          const errors = [cpu.error, memory.error].filter(Boolean) as string[];
          if (cpuPercent === undefined) errors.push("cpu_total 暂无数据");
          if (memoryPercent === undefined) {
            errors.push("memory_usedutilization 暂无数据");
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
              cpuMetric: "cpu_total",
              memoryMetric: "memory_usedutilization",
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
  const result = await runPool(tasks, 4);
  const withMetrics = new Map(
    result.values
      .flat()
      .map(
        (resource) =>
          [`${resource.type}:${resource.region}:${resource.id}`, resource] as const,
      ),
  );
  return resources.map(
    (resource) =>
      withMetrics.get(`${resource.type}:${resource.region}:${resource.id}`) ??
      resource,
  );
}

export async function scanAllAliyunResources(
  credentials: AliyunCredentials,
  configuredRegion: string,
): Promise<CloudScanResult> {
  const safeConfiguredRegion = assertAliyunRegion(configuredRegion);
  const discoveredRegions = await listAliyunRegions(credentials).catch(
    () => [] as string[],
  );
  const regions = Array.from(
    new Set([
      safeConfiguredRegion,
      ...discoveredRegions,
      ...FALLBACK_REGIONS,
    ]),
  ).filter((region) => /^[a-z]{2,}(?:-[a-z0-9]+)+$/.test(region));

  const tasks = regions.flatMap((region) =>
    SCAN_SPECS.map((spec) => ({
      label: `${spec.service.toUpperCase()}（${region}）`,
      run: async () => {
        const records = await listPaged(credentials, spec, region);
        return records
          .filter((item) => item)
          .map((item) => spec.map(item, region))
          .filter((resource) => resource.id);
      },
    })),
  );
  const result = await runPool(tasks, 8);
  const warnings = dedupeWarnings(result.warnings);
  if (result.succeeded === 0) {
    throw new Error(
      `阿里云资源查询全部失败。${warnings[0] ? ` ${warnings[0]}` : ""}`,
    );
  }
  const resources = result.values.flat();
  return {
    resources: await attachAliyunMetrics(credentials, resources),
    warnings,
    complete: warnings.length === 0,
  };
}

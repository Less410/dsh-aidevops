import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import {
  listDnsPodRecords,
  type DnsPodRecord,
  type TencentCredentials,
} from "./tencent.js";

export interface DnsBindingInput {
  domain: string;
  subdomain: string;
  targetIp: string;
  httpPort: number;
  ttl: number;
  finalUrl: string;
}

export interface DnsProbeResult {
  ok: boolean;
  statusCode: number | null;
  durationMs: number;
  url: string;
  hostHeader: string;
  detail: string;
}

export interface DnsPreflightResult {
  ok: boolean;
  checkedAt: string;
  domain: string;
  subdomain: string;
  recordType: "A";
  targetValue: string;
  ttl: number;
  finalUrl: string;
  checks: Array<{
    key: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  existingRecords: Array<{
    recordId: string;
    subdomain: string;
    recordType: string;
    value: string;
    ttl: number;
  }>;
  conflictRecordIds: string[];
}

export interface DnsVerificationResult {
  ok: boolean;
  checkedAt: string;
  checks: Array<{
    key: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  resolvedIps: string[];
  http: DnsProbeResult | null;
}

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBDOMAIN_PATTERN =
  /^(?:@|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/;

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_PATTERN.test(normalized)) {
    throw new Error("域名格式不正确，请填写不含协议和端口的完整域名。");
  }
  if (normalized.length > 253) {
    throw new Error("域名过长。");
  }
  return normalized;
}

function normalizeSubdomain(value: string): string {
  const normalized = value.trim().toLowerCase() || "@";
  if (
    !SUBDOMAIN_PATTERN.test(normalized) ||
    normalized === "*" ||
    normalized.includes("*")
  ) {
    throw new Error("主机记录格式不正确；根域名请填写 @。");
  }
  return normalized;
}

function isPublicIpv4(value: string): boolean {
  if (net.isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  const [a = 0, b = 0] = octets;
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  ) {
    return false;
  }
  return true;
}

function normalizeTargetIp(value: string): string {
  const normalized = value.trim();
  if (!isPublicIpv4(normalized)) {
    throw new Error("目标必须是可公网访问的 IPv4 地址。");
  }
  return normalized;
}

function normalizeHttpPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("HTTP 端口必须是 1-65535 之间的整数。");
  }
  return value;
}

function normalizeTtl(value: number): number {
  if (!Number.isInteger(value) || value < 60 || value > 86_400) {
    throw new Error("TTL 必须是 60-86400 之间的整数秒。");
  }
  return value;
}

export function normalizeDnsBindingInput(input: {
  domain: unknown;
  subdomain?: unknown;
  targetIp: unknown;
  httpPort: unknown;
  ttl?: unknown;
}): DnsBindingInput {
  if (typeof input.domain !== "string") {
    throw new Error("域名不能为空。");
  }
  if (typeof input.targetIp !== "string") {
    throw new Error("目标 IP 不能为空。");
  }
  const domain = normalizeDomain(input.domain);
  const subdomain = normalizeSubdomain(
    typeof input.subdomain === "string" ? input.subdomain : "@",
  );
  const targetIp = normalizeTargetIp(input.targetIp);
  const httpPort = normalizeHttpPort(Number(input.httpPort));
  const ttl = normalizeTtl(input.ttl === undefined ? 600 : Number(input.ttl));
  return {
    domain,
    subdomain,
    targetIp,
    httpPort,
    ttl,
    finalUrl: `http://${domain}:${httpPort}`,
  };
}

function normalizeRecordHost(value: string, domain: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized === "@" || normalized === domain) return "@";
  const suffix = `.${domain}`;
  return normalized.endsWith(suffix)
    ? normalized.slice(0, -suffix.length) || "@"
    : normalized;
}

function recordsForHost(records: DnsPodRecord[], input: DnsBindingInput) {
  return records.filter(
    (record) =>
      normalizeRecordHost(record.subdomain, input.domain) === input.subdomain,
  );
}

function matchingRecords(records: DnsPodRecord[], input: DnsBindingInput) {
  return recordsForHost(records, input).filter(
    (record) =>
      record.recordType.toUpperCase() === "A" &&
      record.value.trim() === input.targetIp,
  );
}

function probeHttp(
  connectionUrl: string,
  hostHeader: string,
  displayUrl = connectionUrl,
): Promise<DnsProbeResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const parsed = new URL(connectionUrl);
    const finish = (result: Omit<DnsProbeResult, "durationMs" | "url" | "hostHeader">) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
        url: displayUrl,
        hostHeader,
      });
    };
    const request = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 80,
        path: `${parsed.pathname || "/"}${parsed.search || ""}`,
        method: "GET",
        headers: {
          Host: hostHeader,
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "AI-DevOps-DNS-Healthcheck/1.0",
          "Cache-Control": "no-cache",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        response.resume();
        finish({
          ok: statusCode >= 200 && statusCode < 300,
          statusCode,
          detail:
            statusCode >= 200 && statusCode < 300
              ? `HTTP ${statusCode}`
              : `站点返回 HTTP ${statusCode || "未知"}，要求 2xx。`,
        });
      },
    );
    request.setTimeout(12_000, () => {
      request.destroy(new Error("请求超时（12 秒）。"));
    });
    request.on("error", (error) => {
      finish({
        ok: false,
        statusCode: null,
        detail: `无法连接：${error.message}`,
      });
    });
    request.end();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

export async function runDnsChangePreflight(
  credentials: TencentCredentials,
  input: DnsBindingInput,
): Promise<DnsPreflightResult> {
  const checks: DnsPreflightResult["checks"] = [];
  let records: DnsPodRecord[] = [];

  try {
    records = await listDnsPodRecords(credentials, input.domain, input.subdomain);
    checks.push({
      key: "dns_read",
      label: "腾讯云 DNSPod 读取权限",
      ok: true,
      detail: `已读取 ${records.length} 条 ${input.subdomain} 主机记录。`,
    });
    checks.push({
      key: "domain_visible",
      label: "域名归属与可见性",
      ok: true,
      detail: `${input.domain} 在当前腾讯云子账号的 DNSPod 中可见。`,
    });
  } catch (error) {
    checks.push({
      key: "dns_read",
      label: "腾讯云 DNSPod 读取权限",
      ok: false,
      detail: errorMessage(error),
    });
    checks.push({
      key: "domain_visible",
      label: "域名归属与可见性",
      ok: false,
      detail: "读取 DNS 记录失败，无法确认域名归属。",
    });
  }

  const hostRecords = recordsForHost(records, input);
  const conflicts = hostRecords.filter((record) =>
    ["A", "CNAME"].includes(record.recordType.toUpperCase()),
  );
  checks.push({
    key: "record_conflict",
    label: "根记录冲突检查",
    ok: checks[0]?.ok === true && conflicts.length === 0,
    detail:
      checks[0]?.ok !== true
        ? "因 DNS 读取失败，未执行冲突检查。"
        : conflicts.length === 0
          ? `${input.subdomain === "@" ? "根域名" : input.subdomain} 当前没有 A/CNAME 冲突。`
          : `发现 ${conflicts.length} 条 A/CNAME 记录，已阻止覆盖。`,
  });

  const ipProbe = await probeHttp(
    `http://${input.targetIp}:${input.httpPort}/`,
    input.targetIp,
  );
  checks.push({
    key: "target_health",
    label: "目标 IP 与端口健康检查",
    ok: ipProbe.ok,
    detail: `${ipProbe.detail} · ${ipProbe.durationMs}ms`,
  });

  const hostProbe = await probeHttp(
    `http://${input.targetIp}:${input.httpPort}/`,
    input.domain,
  );
  checks.push({
    key: "host_header_health",
    label: "目标站点接受绑定域名",
    ok: hostProbe.ok,
    detail: `${hostProbe.detail} · Host: ${input.domain}`,
  });

  return {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    domain: input.domain,
    subdomain: input.subdomain,
    recordType: "A",
    targetValue: input.targetIp,
    ttl: input.ttl,
    finalUrl: input.finalUrl,
    checks,
    existingRecords: hostRecords.map((record) => ({
      recordId: record.recordId,
      subdomain: record.subdomain,
      recordType: record.recordType,
      value: record.value,
      ttl: record.ttl,
    })),
    conflictRecordIds: conflicts.map((record) => record.recordId),
  };
}

async function waitForDns(
  domain: string,
  targetIp: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; ips: string[]; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastIps: string[] = [];
  let lastError = "";
  do {
    try {
      lastIps = await dns.resolve4(domain);
      if (lastIps.includes(targetIp)) {
        return {
          ok: true,
          ips: lastIps,
          detail: `${domain} 已解析到 ${targetIp}。`,
        };
      }
    } catch (error) {
      lastError = errorMessage(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } while (Date.now() < deadline);
  return {
    ok: false,
    ips: lastIps,
    detail:
      lastIps.length > 0
        ? `当前解析为 ${lastIps.join(", ")}，尚未包含 ${targetIp}。`
        : `DNS 解析尚未生效${lastError ? `：${lastError}` : "。"}`,
  };
}

export async function verifyDnsChange(
  credentials: TencentCredentials,
  input: DnsBindingInput,
  recordId: string,
): Promise<DnsVerificationResult> {
  const checks: DnsVerificationResult["checks"] = [];
  let recordOk = false;
  try {
    const records = matchingRecords(
      await listDnsPodRecords(credentials, input.domain, input.subdomain),
      input,
    );
    recordOk = records.some((record) => record.recordId === recordId);
    checks.push({
      key: "record_persisted",
      label: "腾讯云记录已落盘",
      ok: recordOk,
      detail: recordOk
        ? `RecordId ${recordId} 的 A 记录值与主机记录完全匹配。`
        : `未找到 RecordId ${recordId} 对应的 A ${input.targetIp} 记录。`,
    });
  } catch (error) {
    checks.push({
      key: "record_persisted",
      label: "腾讯云记录已落盘",
      ok: false,
      detail: errorMessage(error),
    });
  }

  const resolved = recordOk
    ? await waitForDns(input.domain, input.targetIp)
    : {
        ok: false,
        ips: [] as string[],
        detail: "记录未确认落盘，跳过 DNS 解析复验。",
      };
  checks.push({
    key: "dns_resolution",
    label: "公网 DNS 解析",
    ok: resolved.ok,
    detail: resolved.detail,
  });

  let httpResult: DnsProbeResult | null = null;
  if (resolved.ok) {
    // DNS 已单独验证解析到目标 IP。HTTP 检查直接连接该 IP，并保留域名
    // Host 头，避免控制机本地 resolver 缓存导致对已生效域名的误判。
    httpResult = await probeHttp(
      `http://${input.targetIp}:${input.httpPort}/`,
      input.domain,
      input.finalUrl,
    );
    checks.push({
      key: "public_http",
      label: "最终 URL 健康检查",
      ok: httpResult.ok,
      detail: `${httpResult.detail} · ${input.finalUrl}`,
    });
  } else {
    checks.push({
      key: "public_http",
      label: "最终 URL 健康检查",
      ok: false,
      detail: "DNS 尚未解析到目标 IP，未执行域名健康检查。",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
    resolvedIps: resolved.ips,
    http: httpResult,
  };
}

export async function findMatchingDnsRecord(
  credentials: TencentCredentials,
  input: DnsBindingInput,
): Promise<DnsPodRecord | undefined> {
  const records = matchingRecords(
    await listDnsPodRecords(credentials, input.domain, input.subdomain),
    input,
  );
  return records.length === 1 ? records[0] : undefined;
}

export async function verifyRollbackRecord(
  credentials: TencentCredentials,
  input: DnsBindingInput,
  recordId: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const records = await listDnsPodRecords(
      credentials,
      input.domain,
      input.subdomain,
    );
    const record = records.find((item) => item.recordId === recordId);
    if (!record) {
      return { ok: false, detail: `DNSPod 中未找到 RecordId ${recordId}。` };
    }
    const exact =
      normalizeRecordHost(record.subdomain, input.domain) === input.subdomain &&
      record.recordType.toUpperCase() === "A" &&
      record.value.trim() === input.targetIp;
    return {
      ok: exact,
      detail: exact
        ? `RecordId ${recordId} 的主机记录、类型和目标 IP 完全匹配，允许精确删除。`
        : `RecordId ${recordId} 当前内容与变更单不一致，已阻止删除。`,
    };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

export async function confirmRollbackRecordRemoved(
  credentials: TencentCredentials,
  domain: string,
  recordId: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const records = await listDnsPodRecords(credentials, domain);
    const remains = records.some((record) => record.recordId === recordId);
    return {
      ok: !remains,
      detail: remains
        ? `RecordId ${recordId} 仍存在。`
        : `RecordId ${recordId} 已不存在，回滚复核通过。`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `删除后复核失败：${errorMessage(error)}`,
    };
  }
}

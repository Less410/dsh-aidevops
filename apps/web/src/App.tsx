import {
  Activity,
  AppWindow,
  ArrowUpRight,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Bug,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Copy,
  Clock3,
  Cloud,
  Code2,
  Database,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  HardDrive,
  Folder,
  LayoutDashboard,
  Layers,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MousePointerClick,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  Trash2,
  Workflow,
  Zap,
  X,
  XCircle,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, ApiError, clearToken, getToken, setToken } from "./api";
import { DatabasePage } from "./DatabasePage";
import { CloudServersPage } from "./CloudServersPage";
import { ErrorDiagnosticsPage } from "./ErrorDiagnosticsPage";
import { PonytailPage } from "./PonytailPage";
import type {
  AiResponse,
  AppTypeDefinition,
  Application,
  AuditEvent,
  CloudAccount,
  CloudResource,
  CloudServer,
  DbConnection,
  Deployment,
  DnsChangeRequest,
  DnsChangeStatus,
  DnsCheck,
  HealthCheck,
  LoginResponse,
  Overview,
  PageId,
  Pipeline,
  PipelineRun,
  PonytailStatus,
  Repository,
  RunAnalysis,
  SessionUser,
  SettingsStatus,
} from "./types";

const NAV_ITEMS: Array<{
  id: PageId;
  label: string;
  hint: string;
  icon: typeof LayoutDashboard;
  children?: Array<{ id: PageId; label: string; hint: string }>;
}> = [
  { id: "overview", label: "总览", hint: "实时态势", icon: LayoutDashboard },
  { id: "guide", label: "使用指南", hint: "从零开始", icon: BookOpen },
  { id: "repositories", label: "代码仓库", hint: "版本与同步", icon: GitBranch },
  { id: "apps", label: "应用管理", hint: "类型与字段", icon: Layers },
  {
    id: "pipelines",
    label: "发布与版本",
    hint: "发布与版本",
    icon: Workflow,
    children: [
      { id: "pipelines", label: "项目发布", hint: "构建与审批" },
      { id: "versions", label: "版本中心", hint: "版本与回滚" },
    ],
  },
  {
    id: "cloud",
    label: "多云资源",
    hint: "资产与服务器",
    icon: Cloud,
    children: [
      { id: "cloud", label: "云资源视图", hint: "资产与健康" },
      { id: "servers", label: "云服务器", hint: "连接与控制" },
    ],
  },
  { id: "databases", label: "数据库管理", hint: "连接与备份", icon: Database },
  { id: "copilot", label: "AI Copilot", hint: "分析与建议", icon: Sparkles },
  { id: "ponytail", label: "Ponytail", hint: "精简开发控制", icon: Zap },
  { id: "errors", label: "故障诊断", hint: "错误与日志", icon: Bug },
  { id: "audit", label: "审计中心", hint: "可追溯记录", icon: ShieldCheck },
  { id: "settings", label: "平台设置", hint: "连接与安全", icon: Settings },
];

type NavItem = (typeof NAV_ITEMS)[number];

const NAV_ORDER_KEY = "ai-devops-nav-order";
const DEFAULT_NAV_ORDER: PageId[] = NAV_ITEMS.map((item) => item.id);

function readNavOrder(): PageId[] {
  try {
    const raw = window.localStorage.getItem(NAV_ORDER_KEY);
    if (!raw) return DEFAULT_NAV_ORDER;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_NAV_ORDER;
    const ids = parsed.filter(
      (id): id is PageId =>
        typeof id === "string" &&
        NAV_ITEMS.some((item) => item.id === id),
    );
    if (ids.length !== DEFAULT_NAV_ORDER.length) return DEFAULT_NAV_ORDER;
    return ids;
  } catch {
    return DEFAULT_NAV_ORDER;
  }
}

const PAGE_TITLES: Record<PageId, { title: string; subtitle: string }> = {
  overview: { title: "研发运维总览", subtitle: "从代码提交到生产健康的统一视图" },
  guide: { title: "新手使用指南", subtitle: "你只需要表达目标、查看结果和确认上线" },
  repositories: { title: "代码仓库", subtitle: "固定版本、记录同步结果并保持来源可追溯" },
  apps: { title: "应用管理", subtitle: "按类型复用字段模板，统一管理网站、小程序和 API" },
  pipelines: { title: "项目发布", subtitle: "按项目查看真实部署、健康状态与审批" },
  versions: { title: "版本中心", subtitle: "统一查看 commit、镜像、审批与可回滚版本" },
  cloud: { title: "多云资源", subtitle: "腾讯云、阿里云与华为云资产视图" },
  servers: {
    title: "云服务器",
    subtitle: "可视化连接 Ubuntu / Linux / Windows，浏览器内命令行操作",
  },
  databases: {
    title: "数据库管理",
    subtitle: "连接云数据库与自装 MySQL，查询、备份与恢复",
  },
  copilot: { title: "AI Copilot", subtitle: "基于平台证据的分析与受控行动提案" },
  ponytail: {
    title: "Ponytail 精简开发",
    subtitle: "固定档位、生成 Skill 命令并查看平台内使用概况",
  },
  errors: {
    title: "故障诊断",
    subtitle: "每次报错都有编号和位置，可直接复制给智能体排查",
  },
  audit: { title: "审计中心", subtitle: "只追加的变更与操作记录" },
  settings: { title: "平台设置", subtitle: "连接状态、执行模式与安全边界" },
};

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  gitee: "Gitee",
  tencent: "腾讯云",
  aliyun: "阿里云",
  huawei: "华为云",
};

const PROVIDER_SHORT: Record<string, string> = {
  github: "GH",
  gitlab: "GL",
  gitea: "GT",
  gitee: "GE",
  tencent: "TX",
  aliyun: "AL",
  huawei: "HW",
};

const ALIYUN_MAIN_LOGIN_URL = "https://account.aliyun.com/login/login.htm";

const PONYTAIL_SKILL_LABELS: Record<string, string> = {
  ponytail: "编码",
  "ponytail-review": "变更审查",
  "ponytail-audit": "全仓审计",
  "ponytail-debt": "捷径账本",
  "ponytail-gain": "节省数据",
  "ponytail-help": "帮助",
};

const SUB_ACCOUNT_LABELS: Record<
  "tencent" | "aliyun" | "huawei",
  {
    ownerLabel: string;
    keyLabel: string;
    secretLabel: string;
    ownerHint: string;
  }
> = {
  tencent: {
    ownerLabel: "主账号 UIN（可选）",
    keyLabel: "SecretId",
    secretLabel: "SecretKey",
    ownerHint: "可留空；主账号 UIN 是纯数字，在控制台右上角账号信息中查看",
  },
  aliyun: {
    ownerLabel: "主账号 ID (UID，可选)",
    keyLabel: "AccessKey ID",
    secretLabel: "AccessKey Secret",
    ownerHint: "可留空；主账号 UID 在阿里云账号中心查看。登录密码不能调用 OpenAPI",
  },
  huawei: {
    ownerLabel: "主账号 Domain ID（可选）",
    keyLabel: "AccessKey ID",
    secretLabel: "Secret Access Key",
    ownerHint: "华为云连接器尚未接入；当前只允许登记，扫描会明确显示未接入",
  },
};

const ENVIRONMENT_LABELS: Record<string, string> = {
  development: "开发环境",
  staging: "预发环境",
  production: "生产环境",
};

const DEPLOYMENT_KIND_LABELS: Record<Deployment["kind"], string> = {
  release: "正常发布",
  rollback: "人工回滚",
  auto_rollback: "自动回滚",
};

const STATUS_LABELS: Record<string, string> = {
  succeeded: "已成功",
  failed: "失败",
  waiting_approval: "等待审批",
  approved: "已审批",
  executing: "执行中",
  rolled_back: "已回滚",
  running: "运行中",
  queued: "排队中",
  cancelled: "已取消",
  ready: "已就绪",
  pending: "待同步",
  sync_error: "同步异常",
  healthy: "健康",
  warning: "需关注",
  critical: "异常",
  unknown: "未知",
  demo: "演示数据",
  connected: "已连接",
  awaiting_credentials: "等待凭据",
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  CVM: "云服务器",
  ECS: "云服务器 ECS",
  Lighthouse: "轻量应用服务器",
  VPC: "私有网络",
  EIP: "弹性公网 IP",
  SecurityGroup: "安全组",
  CLB: "负载均衡",
  SLB: "负载均衡 SLB",
  CBS: "云硬盘",
  CDB: "云数据库 MySQL",
  RDS: "云数据库 RDS",
  Redis: "云数据库 Redis",
  TKE: "容器集群",
  CFS: "文件存储",
  CynosDB: "TDSQL-C",
  CDN: "内容分发",
  SSL: "SSL 证书",
  Domain: "注册域名",
  DNSPod: "DNS 域名",
  COS: "对象存储",
};

const RESOURCE_TYPE_ORDER = [
  "CVM",
  "ECS",
  "Lighthouse",
  "TKE",
  "CLB",
  "SLB",
  "VPC",
  "EIP",
  "SecurityGroup",
  "CDB",
  "RDS",
  "CynosDB",
  "Redis",
  "CBS",
  "CFS",
  "CDN",
  "Domain",
  "DNSPod",
  "SSL",
  "COS",
];

function resourceTypeIcon(type: string) {
  switch (type) {
    case "CVM":
    case "ECS":
    case "Lighthouse":
      return Server;
    case "VPC":
      return Network;
    case "EIP":
      return Globe;
    case "SecurityGroup":
      return ShieldCheck;
    case "CLB":
    case "SLB":
      return Layers;
    case "CBS":
    case "CFS":
      return HardDrive;
    case "CDB":
    case "RDS":
    case "Redis":
    case "CynosDB":
      return Database;
    case "TKE":
      return Boxes;
    case "CDN":
      return Zap;
    case "SSL":
      return LockKeyhole;
    case "Domain":
    case "DNSPod":
      return Globe;
    case "COS":
      return Folder;
    default:
      return Cloud;
  }
}

function resourceAttributes(resource: CloudResource): string[] {
  const attributes = resource.attributes;
  const pick = (key: string, label: string) =>
    attributes[key] ? `${label} ${String(attributes[key])}` : "";
  const candidates = [
    pick("expiresAt", "到期"),
    pick("buyStatusText", "购买状态"),
    pick("autoRenewText", "自动续费"),
    pick("domainStatusText", "域名状态"),
    pick("publicIp", "公网 IP"),
    pick("addressIp", "IP"),
    pick("vip", "VIP"),
    pick("instanceState", "状态"),
    pick("status", "状态"),
    pick("osName", "系统"),
    pick("cidr", "网段"),
    pick("domain", "域名"),
    pick("location", "地域"),
    pick("diskSize", "容量"),
    pick("version", "版本"),
  ];
  return candidates.filter(Boolean).slice(0, 3);
}

function DnsCheckList({ checks }: { checks: DnsCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="dns-check-list">
      {checks.map((check, index) => (
        <div
          className={classNames("dns-check", check.ok ? "ok" : "failed")}
          key={`${check.key}-${index}`}
        >
          <span className="dns-check-icon">
            {check.ok ? <Check size={13} /> : <X size={13} />}
          </span>
          <div>
            <strong>{check.label}</strong>
            <small>{check.detail}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function timeAgo(value: string | null): string {
  if (!value) return "尚未发生";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "进行中";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={classNames("status-badge", `status-${status}`)}>
      <span className="status-dot" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function ProviderMark({
  provider,
  size = "medium",
}: {
  provider: string;
  size?: "small" | "medium" | "large";
}) {
  return (
    <span className={classNames("provider-mark", `provider-${provider}`, size)}>
      {PROVIDER_SHORT[provider] ?? provider.slice(0, 2).toUpperCase()}
    </span>
  );
}

function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <span className="inline-loader">
      <LoaderCircle size={16} />
      {label}
    </span>
  );
}

function PanelPagination({
  total,
  page,
  pageCount,
  onPage,
}: {
  total: number;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="panel-pagination">
      <span className="quiet-note">
        共 {total} 条 · 第 {page}/{pageCount} 页
      </span>
      <div className="panel-pagination-actions">
        <button
          type="button"
          className="button ghost compact"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          className="button ghost compact"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function Toast({
  message,
  tone,
  onClose,
}: {
  message: string;
  tone: "success" | "error";
  onClose: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 4_500);
    return () => window.clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={classNames("toast", `toast-${tone}`)} role="status">
      {tone === "success" ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示">
        <X size={15} />
      </button>
    </div>
  );
}

function LoginView({ onLogin }: { onLogin: (session: LoginResponse) => void }) {
  const [email, setEmail] = useState("admin@aidevops.local");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await api<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(response.token);
      onLogin(response);
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "登录失败，请重试。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-visual">
        <div className="login-glow one" />
        <div className="login-glow two" />
        <div className="login-brand">
          <div className="brand-symbol">
            <Sparkles size={22} />
          </div>
          <span>AI DevOps</span>
        </div>
        <div className="login-message">
          <p className="eyebrow light">ENGINEER WITH CONFIDENCE</p>
          <h1>
            让每一次变更
            <br />
            <span>都有证据与边界。</span>
          </h1>
          <p>
            统一代码、交付与多云运维，用智能分析提升效率，
            用策略和审计守住生产安全。
          </p>
        </div>
        <div className="login-flow" aria-hidden="true">
          <div className="flow-node active">
            <Code2 size={18} />
            <span>代码</span>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <Workflow size={18} />
            <span>流水线</span>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <Cloud size={18} />
            <span>多云</span>
          </div>
          <div className="flow-line" />
          <div className="flow-node">
            <ShieldCheck size={18} />
            <span>治理</span>
          </div>
        </div>
        <div className="login-proof">
          <span>
            <ShieldCheck size={15} /> 默认只读分析
          </span>
          <span>
            <LockKeyhole size={15} /> 生产审批门禁
          </span>
          <span>
            <GitCommitHorizontal size={15} /> Commit 可追溯
          </span>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-form-wrap">
          <div className="mobile-login-brand">
            <div className="brand-symbol">
              <Sparkles size={19} />
            </div>
            <span>AI DevOps</span>
          </div>
          <p className="eyebrow">SELF-HOSTED CONTROL PLANE</p>
          <h2>登录控制台</h2>
          <p className="login-subtitle">
            使用管理员账号进入你的智能研发运维工作台。
          </p>
          <form onSubmit={handleSubmit} className="login-form">
            <label>
              邮箱
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@aidevops.local"
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="输入管理员密码"
                required
              />
            </label>
            {error && (
              <div className="form-error">
                <TriangleAlert size={16} />
                {error}
              </div>
            )}
            <button className="button primary login-button" disabled={submitting}>
              {submitting ? <Spinner label="正在验证" /> : "进入工作台"}
              {!submitting && <ArrowUpRight size={17} />}
            </button>
          </form>
          <p className="first-run-hint">
            首次启动密码显示在一键启动窗口，并保存在本机 .env 文件中。
          </p>
        </div>
        <div className="login-footer">
          <span className="live-dot" /> 本地控制面 · v0.1.0
        </div>
      </section>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<SessionUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(Boolean(getToken()));

  useEffect(() => {
    if (!getToken()) {
      setCheckingSession(false);
      return;
    }
    api<{ user: SessionUser }>("/api/auth/me")
      .then((response) => setSession(response.user))
      .catch(() => {
        clearToken();
        setSession(null);
      })
      .finally(() => setCheckingSession(false));
  }, []);

  function logout() {
    clearToken();
    setSession(null);
  }

  if (checkingSession) {
    return (
      <div className="splash-screen">
        <div className="brand-symbol">
          <Sparkles size={22} />
        </div>
        <Spinner label="正在连接控制面" />
      </div>
    );
  }

  if (!session) {
    return (
      <LoginView
        onLogin={(response) => {
          setSession(response.user);
        }}
      />
    );
  }

  return <ConsoleShell session={session} onLogout={logout} />;
}

interface ConsoleData {
  overview: Overview | null;
  repositories: Repository[];
  appTypes: AppTypeDefinition[];
  applications: Application[];
  pipelines: Pipeline[];
  runs: PipelineRun[];
  deployments: Deployment[];
  healthChecks: HealthCheck[];
  cloudAccounts: CloudAccount[];
  cloudResources: CloudResource[];
  dbConnections: DbConnection[];
  auditEvents: AuditEvent[];
  ponytail: PonytailStatus | null;
  settings: SettingsStatus | null;
}

const EMPTY_DATA: ConsoleData = {
  overview: null,
  repositories: [],
  appTypes: [],
  applications: [],
  pipelines: [],
  runs: [],
  deployments: [],
  healthChecks: [],
  cloudAccounts: [],
  cloudResources: [],
  dbConnections: [],
  auditEvents: [],
  ponytail: null,
  settings: null,
};

type DataSliceKey =
  | "overview"
  | "repositories"
  | "apps"
  | "pipelines"
  | "runs"
  | "deployments"
  | "health"
  | "cloud"
  | "databases"
  | "audit"
  | "ponytail"
  | "settings";

type DataSlice = Partial<ConsoleData>;

/** One fetcher per data group, so a refresh can load exactly what it needs. */
const DATA_SLICES: Record<DataSliceKey, () => Promise<DataSlice>> = {
  overview: async () => ({ overview: await api<Overview>("/api/overview") }),
  repositories: async () => {
    const response = await api<{ repositories: Repository[] }>(
      "/api/repositories",
    );
    return { repositories: response.repositories };
  },
  apps: async () => {
    const response = await api<{
      types: AppTypeDefinition[];
      applications: Application[];
    }>("/api/apps");
    return { appTypes: response.types, applications: response.applications };
  },
  pipelines: async () => {
    const response = await api<{ pipelines: Pipeline[] }>("/api/pipelines");
    return { pipelines: response.pipelines };
  },
  runs: async () => {
    const response = await api<{ runs: PipelineRun[] }>("/api/runs?limit=50");
    return { runs: response.runs };
  },
  deployments: async () => {
    const response = await api<{ deployments: Deployment[] }>(
      "/api/deployments?limit=100",
    );
    return { deployments: response.deployments };
  },
  health: async () => {
    const response = await api<{ checks: HealthCheck[] }>(
      "/api/monitoring/health",
    );
    return { healthChecks: response.checks };
  },
  cloud: async () => {
    const [accounts, resources] = await Promise.all([
      api<{ accounts: CloudAccount[] }>("/api/cloud/accounts"),
      api<{ resources: CloudResource[] }>("/api/cloud/resources"),
    ]);
    return {
      cloudAccounts: accounts.accounts,
      cloudResources: resources.resources,
    };
  },
  databases: async () => {
    const response = await api<{ connections: DbConnection[] }>(
      "/api/db/connections",
    );
    return { dbConnections: response.connections };
  },
  audit: async () => {
    const response = await api<{ events: AuditEvent[] }>(
      "/api/audit?limit=80",
    );
    return { auditEvents: response.events };
  },
  ponytail: async () => ({ ponytail: await api<PonytailStatus>("/api/ponytail") }),
  settings: async () => ({
    settings: await api<SettingsStatus>("/api/settings/status"),
  }),
};

const ALL_SLICES = Object.keys(DATA_SLICES) as DataSliceKey[];

/**
 * What the topbar refresh reloads for the current page. Empty means the page
 * loads its own data and is reloaded through the refresh signal instead.
 */
const PAGE_SLICES: Record<PageId, DataSliceKey[]> = {
  overview: ["overview", "repositories", "ponytail"],
  guide: ["settings"],
  repositories: ["repositories"],
  apps: ["apps", "repositories"],
  pipelines: ["apps", "deployments", "health"],
  versions: ["apps", "deployments"],
  cloud: ["cloud"],
  servers: [],
  databases: [],
  copilot: ["settings", "runs"],
  ponytail: ["ponytail"],
  errors: [],
  audit: ["audit"],
  settings: ["settings"],
};

async function loadSlices(keys: DataSliceKey[]): Promise<DataSlice> {
  const parts = await Promise.all(keys.map((key) => DATA_SLICES[key]()));
  return parts.reduce<DataSlice>((merged, part) => ({ ...merged, ...part }), {});
}

function ConsoleShell({
  session,
  onLogout,
}: {
  session: SessionUser;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<PageId>("overview");
  const [data, setData] = useState<ConsoleData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("ai-devops-sidebar") === "collapsed",
  );
  const [navExpanded, setNavExpanded] = useState<Record<string, boolean>>({});
  const [navOrder, setNavOrder] = useState<PageId[]>(() => readNavOrder());
  const [draggingNavId, setDraggingNavId] = useState<PageId | "">("");
  const [dragOverNavId, setDragOverNavId] = useState<PageId | "">("");
  const [search, setSearch] = useState("");
  const [pageRefreshSignal, setPageRefreshSignal] = useState(0);
  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const [selectedRun, setSelectedRun] = useState<PipelineRun | null>(null);
  const [repositoryModalOpen, setRepositoryModalOpen] = useState(false);
  const [cloudModalOpen, setCloudModalOpen] = useState(false);
  const [editingCloudAccount, setEditingCloudAccount] =
    useState<CloudAccount | null>(null);
  const [appModalOpen, setAppModalOpen] = useState(false);
  const [newAppType, setNewAppType] = useState<string>("web");
  const [editingApplication, setEditingApplication] =
    useState<Application | null>(null);

  const notify = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setToast({ message, tone });
    },
    [],
  );

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        onLogout();
        return;
      }
      const base = error instanceof Error ? error.message : "操作失败。";
      const suffix =
        error instanceof ApiError && error.requestId
          ? `（编号 ${error.requestId.slice(0, 8)}，可在“故障诊断”查看详情）`
          : "";
      notify(`${base}${suffix}`, "error");
    },
    [notify, onLogout],
  );

  const refresh = useCallback(
    async (quiet = false) => {
      const startedAt = Date.now();
      if (quiet) setRefreshing(true);
      try {
        const patch = await loadSlices(ALL_SLICES);
        setData((current) => ({ ...current, ...patch }));
      } catch (error) {
        handleError(error);
      } finally {
        if (quiet) {
          const elapsed = Date.now() - startedAt;
          if (elapsed < 700) {
            await new Promise((resolve) => window.setTimeout(resolve, 700 - elapsed));
          }
        }
        setLoading(false);
        setRefreshing(false);
      }
    },
    [handleError],
  );

  // The topbar refresh reloads only the slice of data the current page shows;
  // the slow part of the old behaviour was a full cloud scan on every click.
  const refreshCurrentPage = useCallback(async () => {
    setRefreshing(true);
    try {
      const keys = PAGE_SLICES[page];
      if (keys.length > 0) {
        const patch = await loadSlices(keys);
        setData((current) => ({ ...current, ...patch }));
      }
      setPageRefreshSignal((current) => current + 1);
      notify(`已刷新：${PAGE_TITLES[page].title}`);
    } catch (error) {
      handleError(error);
    } finally {
      setRefreshing(false);
    }
  }, [handleError, notify, page]);

  // Full cloud sync stays available, but as an explicit action on the cloud page.
  const syncAllCloud = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api<{
        totals: {
          accounts: number;
          scannedAccounts: number;
          failedAccounts: number;
          resources: number;
          domains: number;
          warnings: number;
        };
        accounts: Array<{
          accountName: string;
          error?: string;
          warnings: string[];
        }>;
      }>("/api/cloud/scan-all", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh(true);
      const firstIssue = result.accounts
        .flatMap((account) =>
          account.error ? [account.error] : account.warnings,
        )
        .find(Boolean);
      const detail = firstIssue
        ? `；首个告警：${firstIssue.slice(0, 110)}`
        : "";
      notify(
        result.totals.accounts === 0
          ? "数据已刷新；当前没有登记可同步的云账号。"
          : `云资源已同步 · ${result.totals.scannedAccounts}/${result.totals.accounts} 个账号 · ${result.totals.resources} 个资源 · ${result.totals.domains} 个注册域名${
              result.totals.warnings > 0
                ? ` · ${result.totals.warnings} 项告警${detail}`
                : ""
            }`,
        result.totals.failedAccounts > 0 ? "error" : "success",
      );
    } catch (error) {
      setRefreshing(false);
      handleError(error);
    }
  }, [handleError, notify, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function handleHashChange() {
      const next = window.location.hash.slice(1) as PageId;
      if (
        NAV_ITEMS.some(
          (item) =>
            item.id === next || item.children?.some((child) => child.id === next),
        )
      ) {
        setPage(next);
        const parent = NAV_ITEMS.find((item) =>
          item.children?.some((child) => child.id === next),
        );
        if (parent) {
          setNavExpanded((current) => ({ ...current, [parent.id]: true }));
        }
      }
    }
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  function navigate(next: PageId) {
    setPage(next);
    setSearch("");
    setMobileNavOpen(false);
    const parent = NAV_ITEMS.find((item) =>
      item.children?.some((child) => child.id === next),
    );
    if (parent) {
      setNavExpanded((current) => ({ ...current, [parent.id]: true }));
    }
    window.history.replaceState(null, "", `#${next}`);
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(
        "ai-devops-sidebar",
        next ? "collapsed" : "expanded",
      );
      return next;
    });
  }

  function persistNavOrder(order: PageId[]) {
    window.localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
  }

  function moveNavItem(draggedId: PageId, targetId: PageId) {
    setNavOrder((current) => {
      const from = current.indexOf(draggedId);
      const to = current.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, draggedId);
      persistNavOrder(next);
      return next;
    });
    setDraggingNavId("");
    setDragOverNavId("");
  }

  function resetNavOrder() {
    setNavOrder(DEFAULT_NAV_ORDER);
    persistNavOrder(DEFAULT_NAV_ORDER);
    notify("菜单顺序已恢复默认。");
  }

  const orderedNavItems = useMemo(
    () =>
      navOrder
        .map((id) => NAV_ITEMS.find((item) => item.id === id))
        .filter((item): item is NavItem => Boolean(item)),
    [navOrder],
  );

  async function runPipeline(pipeline: Pipeline) {
    try {
      const response = await api<{ run: PipelineRun }>(
        `/api/pipelines/${pipeline.id}/run`,
        { method: "POST" },
      );
      await refresh(true);
      setSelectedRun(response.run);
      notify(
        response.run.status === "waiting_approval"
          ? "流水线已进入生产审批门禁。"
          : "预发流水线已完成（模拟执行）。",
      );
    } catch (error) {
      handleError(error);
    }
  }

  async function approveSelectedRun(run: PipelineRun) {
    try {
      const response = await api<{ run: PipelineRun }>(
        `/api/runs/${run.id}/approve`,
        { method: "POST" },
      );
      setSelectedRun(response.run);
      await refresh(true);
      notify("审批已记录，模拟发布与健康验证已完成。");
    } catch (error) {
      handleError(error);
    }
  }

  async function syncRepository(repository: Repository) {
    try {
      const result = await api<{ commitSha: string }>(
        `/api/repositories/${repository.id}/sync`,
        { method: "POST" },
      );
      await refresh(true);
      notify(`${repository.name} 已同步至 ${result.commitSha}。`);
    } catch (error) {
      await refresh(true);
      handleError(error);
    }
  }

  async function scanAccount(account: CloudAccount) {
    try {
      const response = await api<{
        resources?: number;
        domains?: number;
        warnings?: string[];
        live?: boolean;
        simulated?: boolean;
      }>(`/api/cloud/accounts/${account.id}/scan`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh(true);
      if (response.live) {
        const warningText =
          (response.warnings?.length ?? 0) > 0
            ? `，${response.warnings?.length} 项告警`
            : "";
        notify(
          `${account.name} 已真实同步 ${response.resources ?? 0} 个资源，其中注册域名 ${response.domains ?? 0} 个${warningText}。`,
        );
      } else {
        notify(
          `${account.name} 未保存真实凭据，无法同步；请编辑账号并填写子账号 AccessKey。`,
          "error",
        );
      }
    } catch (error) {
      handleError(error);
    }
  }

  async function verifyCloudAccount(account: CloudAccount) {
    try {
      const response = await api<{ detail: string }>(
        `/api/cloud/accounts/${account.id}/verify`,
        { method: "POST", body: JSON.stringify({}) },
      );
      let scanMessage = "";
      try {
        const scan = await api<{ resources?: number; live?: boolean }>(
          `/api/cloud/accounts/${account.id}/scan`,
          { method: "POST", body: JSON.stringify({}) },
        );
        if (scan.live) {
          const count = scan.resources ?? 0;
          scanMessage =
            count > 0
              ? `已真实同步 ${count} 个云资源。`
              : "已检查可用地域，暂未发现资源；请确认子账号具备对应只读权限。";
        }
      } catch (error) {
        scanMessage =
          `同步失败：${error instanceof Error ? error.message : "未知原因"}`;
      }
      await refresh(true);
      notify(`${response.detail}。${scanMessage}`);
    } catch (error) {
      await refresh(true);
      handleError(error);
    }
  }

  async function publishApplication(
    application: Application,
    environment: "development" | "staging" | "production",
  ) {
    try {
      const response = await api<{ deployment: Deployment }>(
        `/api/apps/${application.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({ environment }),
        },
      );
      await refresh(true);
      const deployment = response.deployment;
      if (deployment.status === "waiting_approval") {
        notify(
          `${application.name} 已完成构建并推送镜像，生产部署等待你的审批。`,
        );
      } else if (deployment.status === "succeeded") {
        notify(
          `${application.name} 部署成功，访问端口 ${deployment.port}${deployment.healthPath}。`,
        );
      } else {
        notify(`${application.name} 发布失败：${deployment.error}`, "error");
      }
    } catch (error) {
      await refresh(true);
      handleError(error);
    }
  }

  async function approveDeployment(deployment: Deployment) {
    try {
      const response = await api<{ deployment: Deployment }>(
        `/api/deployments/${deployment.id}/approve`,
        { method: "POST" },
      );
      await refresh(true);
      const updated = response.deployment;
      if (updated.status === "succeeded") {
        notify(
          updated.kind === "rollback"
            ? `${updated.appName} 已回滚到 ${updated.commitSha}，健康检查通过。`
            : `${updated.appName} 生产部署成功，端口 ${updated.port}${updated.healthPath}。`,
        );
      } else {
        notify(`部署失败：${updated.error}`, "error");
      }
    } catch (error) {
      await refresh(true);
      handleError(error);
    }
  }

  async function requestRollback(deployment: Deployment): Promise<boolean> {
    try {
      const response = await api<{ deployment: Deployment }>(
        `/api/apps/${deployment.appId}/rollbacks`,
        {
          method: "POST",
          body: JSON.stringify({ targetDeploymentId: deployment.id }),
        },
      );
      await refresh(true);
      notify(
        `已为 ${deployment.appName} 创建回滚审批单，目标 commit ${response.deployment.commitSha}；批准后才执行。`,
      );
      return true;
    } catch (error) {
      await refresh(true);
      handleError(error);
      return false;
    }
  }

  async function cancelDeployment(deployment: Deployment) {
    const confirmed = window.confirm(
      `确定取消 ${deployment.appName} 的${deployment.kind === "rollback" ? "回滚" : "部署"}吗？服务器不会发生修改。`,
    );
    if (!confirmed) return;
    try {
      await api<{ deployment: Deployment }>(
        `/api/deployments/${deployment.id}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await refresh(true);
      notify("操作已取消，服务器未被修改。");
    } catch (error) {
      await refresh(true);
      handleError(error);
    }
  }

  async function removeApplication(application: Application) {
    const confirmed = window.confirm(
      `确定删除应用“${application.name}”吗？此操作无法撤销。`,
    );
    if (!confirmed) {
      return;
    }
    try {
      await api(`/api/apps/${application.id}`, { method: "DELETE" });
      await refresh(true);
      notify("应用已删除。");
    } catch (error) {
      handleError(error);
    }
  }

  async function recordPonytailActivity(
    skill: string,
    mode: string | null,
  ) {
    try {
      const ponytail = await api<PonytailStatus>("/api/ponytail/activity", {
        method: "POST",
        body: JSON.stringify({ skill, mode }),
      });
      setData((current) => ({ ...current, ponytail }));
      notify("Ponytail 命令已复制；只记录了 Skill 与档位。");
    } catch (error) {
      handleError(error);
    }
  }

  if (loading) {
    return (
      <div className="splash-screen">
        <div className="brand-symbol">
          <Sparkles size={22} />
        </div>
        <Spinner label="正在装载研发运维数据" />
      </div>
    );
  }

  const pageMeta = PAGE_TITLES[page];
  return (
    <div className={classNames("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
      {mobileNavOpen && (
        <button
          type="button"
          className="mobile-nav-backdrop"
          onClick={() => setMobileNavOpen(false)}
          aria-label="关闭导航"
        />
      )}
      <aside className={classNames("sidebar", mobileNavOpen && "is-open")}>
        <div className="sidebar-brand">
          <div className="brand-symbol">
            <Sparkles size={20} />
          </div>
          <div>
            <strong>AI DevOps</strong>
            <span>智能交付控制面</span>
          </div>
          <button
            type="button"
            className="mobile-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="关闭导航"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <p className="nav-label">工作空间</p>
          {orderedNavItems.map((item) => {
            const Icon = item.icon;
            const hasChildren = Boolean(item.children?.length);
            const childActive = item.children?.some((child) => child.id === page);
            const expanded = hasChildren
              ? (navExpanded[item.id] ?? false)
              : true;
            return (
              <Fragment key={item.id}>
                <button
                  type="button"
                  draggable
                  className={classNames(
                    "nav-item",
                    (page === item.id || childActive) && "active",
                    draggingNavId === item.id && "dragging",
                    dragOverNavId === item.id && "drag-over",
                  )}
                  onClick={() => navigate(item.id)}
                  title={item.label}
                  onDragStart={(event) => {
                    setDraggingNavId(item.id);
                    event.dataTransfer.effectAllowed = "move";
                    try {
                      event.dataTransfer.setData("text/plain", item.id);
                    } catch {
                      // 某些浏览器不允许写 dataTransfer，忽略即可。
                    }
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dragOverNavId !== item.id) {
                      setDragOverNavId(item.id);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverNavId === item.id) setDragOverNavId("");
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingNavId && draggingNavId !== item.id) {
                      moveNavItem(draggingNavId, item.id);
                    }
                  }}
                  onDragEnd={() => {
                    setDraggingNavId("");
                    setDragOverNavId("");
                  }}
                >
                  <Icon size={18} />
                  <span>
                    {item.label}
                    <small>{item.hint}</small>
                  </span>
                  {item.id === "overview" &&
                    (data.overview?.metrics.pendingDeploymentApprovals ?? 0) > 0 && (
                      <em>{data.overview?.metrics.pendingDeploymentApprovals}</em>
                    )}
                  {hasChildren && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="nav-chevron-wrap"
                      aria-label={expanded ? "折叠子菜单" : "展开子菜单"}
                      onClick={(event) => {
                        event.stopPropagation();
                        setNavExpanded((current) => ({
                          ...current,
                          [item.id]: !expanded,
                        }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.stopPropagation();
                          setNavExpanded((current) => ({
                            ...current,
                            [item.id]: !expanded,
                          }));
                        }
                      }}
                    >
                      <ChevronRight
                        size={14}
                        className={classNames("nav-chevron", expanded && "open")}
                      />
                    </span>
                  )}
                </button>
                {hasChildren &&
                  expanded &&
                  item.children?.map((child) => (
                    <button
                      type="button"
                      key={child.id}
                      className={classNames(
                        "nav-item nav-child",
                        page === child.id && "active",
                      )}
                      onClick={() => navigate(child.id)}
                      title={child.label}
                    >
                      <span className="nav-child-spacer" />
                      <span>
                        {child.label}
                        <small>{child.hint}</small>
                      </span>
                    </button>
                  ))}
              </Fragment>
            );
          })}
        </nav>

        <div className="sidebar-collapse-row">
          <button
            type="button"
            className="sidebar-collapse-button"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "展开菜单" : "收起菜单"}
            aria-label={sidebarCollapsed ? "展开菜单" : "收起菜单"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={17} />
            ) : (
              <PanelLeftClose size={17} />
            )}
            <span>{sidebarCollapsed ? "" : "收起菜单"}</span>
          </button>
        </div>

        <div className="sidebar-safety">
          <div className="safety-icon">
            <ShieldCheck size={18} />
          </div>
          <div>
            <span>受控执行模式</span>
            <small>受控 Runner · 写操作需审批</small>
          </div>
        </div>

        <div className="sidebar-user">
          <div className="avatar">{session.name.slice(0, 1)}</div>
          <div>
            <strong>{session.name}</strong>
            <span>{session.email}</span>
          </div>
          <button type="button" onClick={onLogout} title="退出登录">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <button
              type="button"
              className="menu-button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="打开导航"
            >
              <Menu size={20} />
            </button>
            <div>
              <h2>{pageMeta.title}</h2>
              <p>{pageMeta.subtitle}</p>
            </div>
          </div>
          <div className="topbar-actions">
            <label className="global-search">
              <Search size={17} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索当前页面"
              />
              <kbd>⌘ K</kbd>
            </label>
            <span className="control-status">
              <span className="live-dot" />
              控制面正常
            </span>
            <button type="button" className="icon-button" aria-label="通知">
              <Bell size={18} />
              <i />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => void refreshCurrentPage()}
              aria-label="刷新当前页面"
              title={`刷新当前页面：${pageMeta.title}`}
              aria-busy={refreshing}
              disabled={refreshing}
            >
              <RefreshCw size={18} className={refreshing ? "spin" : ""} />
            </button>
          </div>
        </header>

        <main className="page-content">
          {page === "overview" && data.overview && (
            <OverviewPage
              overview={data.overview}
              repositories={data.repositories}
              ponytail={data.ponytail}
              onNavigate={navigate}
              onNewRelease={() => navigate("pipelines")}
              refreshing={refreshing}
            />
          )}
          {page === "guide" && (
            <GuidePage
              settings={data.settings}
              onNavigate={navigate}
            />
          )}
          {page === "repositories" && (
            <RepositoriesPage
              repositories={data.repositories}
              search={search}
              onAdd={() => setRepositoryModalOpen(true)}
              onSync={(repository) => void syncRepository(repository)}
            />
          )}
          {page === "apps" && (
            <AppsPage
              types={data.appTypes}
              applications={data.applications}
              repositories={data.repositories}
              search={search}
              onAdd={(typeId) => {
                setNewAppType(typeId ?? "web");
                setEditingApplication(null);
                setAppModalOpen(true);
              }}
              onEdit={(application) => {
                setEditingApplication(application);
                setAppModalOpen(true);
              }}
              onDelete={(application) => void removeApplication(application)}
              onPublish={(application, environment) =>
                void publishApplication(application, environment)
              }
              onNavigate={navigate}
            />
          )}
          {page === "pipelines" && (
            <ProjectReleasesPage
              applications={data.applications}
              deployments={data.deployments}
              healthChecks={data.healthChecks}
              search={search}
              onPublish={(application, environment) =>
                void publishApplication(application, environment)
              }
              onApprove={(deployment) => void approveDeployment(deployment)}
              onRollback={requestRollback}
              onCancel={(deployment) => void cancelDeployment(deployment)}
              onNavigate={navigate}
            />
          )}
          {page === "versions" && (
            <VersionCenterPage
              applications={data.applications}
              deployments={data.deployments}
              search={search}
              onApprove={(deployment) => void approveDeployment(deployment)}
              onRollback={requestRollback}
              onCancel={(deployment) => void cancelDeployment(deployment)}
              onNavigate={navigate}
            />
          )}
          {page === "cloud" && (
            <CloudPage
              accounts={data.cloudAccounts}
              resources={data.cloudResources}
              search={search}
              onScan={(account) => scanAccount(account)}
              onVerify={(account) => verifyCloudAccount(account)}
              onSyncAll={syncAllCloud}
              onConnect={() => {
                setEditingCloudAccount(null);
                setCloudModalOpen(true);
              }}
              onEdit={(account) => {
                setEditingCloudAccount(account);
                setCloudModalOpen(true);
              }}
            />
          )}
          {page === "servers" && (
            <CloudServersPage
              onError={handleError}
              notify={notify}
              refreshSignal={pageRefreshSignal}
            />
          )}
          {page === "databases" && (
            <DatabasePage
              onError={handleError}
              notify={notify}
              refreshSignal={pageRefreshSignal}
            />
          )}
          {page === "copilot" && (
            <CopilotPage
              settings={data.settings}
              recentRuns={data.runs}
              onSelectRun={setSelectedRun}
              onError={handleError}
            />
          )}
          {page === "ponytail" && (
            <PonytailPage
              status={data.ponytail}
              onRecord={recordPonytailActivity}
            />
          )}
          {page === "errors" && (
            <ErrorDiagnosticsPage
              onError={handleError}
              notify={notify}
              refreshSignal={pageRefreshSignal}
            />
          )}
          {page === "audit" && (
            <AuditPage events={data.auditEvents} search={search} />
          )}
          {page === "settings" && (
            <SettingsPage
              settings={data.settings}
              session={session}
              onResetNavOrder={resetNavOrder}
            />
          )}
        </main>
      </div>

      {selectedRun && (
        <RunDrawer
          run={selectedRun}
          onClose={() => setSelectedRun(null)}
          onApprove={(run) => void approveSelectedRun(run)}
          onError={handleError}
        />
      )}

      {repositoryModalOpen && (
        <AddRepositoryModal
          onClose={() => setRepositoryModalOpen(false)}
          onCreated={async (message) => {
            setRepositoryModalOpen(false);
            await refresh(true);
            notify(message);
          }}
          onError={handleError}
        />
      )}

      {appModalOpen && (
        <AppFormModal
          types={data.appTypes}
          repositories={data.repositories}
          application={editingApplication}
          initialType={newAppType}
          onClose={() => setAppModalOpen(false)}
          onSaved={async (message) => {
            setAppModalOpen(false);
            setEditingApplication(null);
            await refresh(true);
            notify(message);
          }}
          onError={handleError}
        />
      )}

      {cloudModalOpen && (
        <AddCloudModal
          account={editingCloudAccount}
          onClose={() => setCloudModalOpen(false)}
          onCreated={async () => {
            setCloudModalOpen(false);
            await refresh(true);
            notify(
              editingCloudAccount
                ? "云账号已更新。"
                : "云账号已登记，尚未启用真实连接器。",
            );
          }}
          onError={handleError}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          tone={toast.tone}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  note: string;
  icon: ReactNode;
  tone: "indigo" | "green" | "amber" | "blue";
  onClick?: () => void;
}) {
  return (
    <article
      className={classNames("metric-card", onClick && "clickable")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(event) => {
        if (onClick && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <div className={classNames("metric-icon", tone)}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </article>
  );
}

function OverviewPage({
  overview,
  repositories,
  ponytail,
  onNavigate,
  onNewRelease,
  refreshing,
}: {
  overview: Overview;
  repositories: Repository[];
  ponytail: PonytailStatus | null;
  onNavigate: (page: PageId) => void;
  onNewRelease: () => void;
  refreshing: boolean;
}) {
  const { metrics, cloudAccounts } = overview;
  const recentDeployments = overview.recentDeployments ?? [];
  const pendingDeployments = overview.pendingDeployments ?? [];
  const pendingDeployment =
    pendingDeployments[0] ??
    recentDeployments.find(
      (deployment) => deployment.status === "waiting_approval",
    );
  const deliveryRows = recentDeployments.slice(0, 5);
  const failedDeployment = recentDeployments.find(
    (deployment) => deployment.status === "failed",
  );
  const maxCost = Math.max(...cloudAccounts.map((account) => account.monthlyCost), 1);
  const latestPonytailUse = ponytail?.recent[0] ?? null;

  return (
    <div className="overview-page">
      <section className="release-banner">
        <div>
          <div className="banner-kicker">
            <span className="pulse-dot" />
            DELIVERY PULSE
            {refreshing && <Spinner label="刷新中" />}
          </div>
          <h1>
            {pendingDeployment
              ? pendingDeployment.kind === "rollback"
                ? "有回滚等待你的审批。"
                : "有部署等待你的审批。"
              : "当前没有待审批的生产部署。"}
          </h1>
          <p>
            {pendingDeployment
              ? pendingDeployment.kind === "rollback"
                ? `${pendingDeployment.appName} 请求回滚到 commit ${pendingDeployment.commitSha}，批准后才会替换服务器容器。`
                : `${pendingDeployment.appName} 已完成构建并推送镜像，等待批准部署到${ENVIRONMENT_LABELS[pendingDeployment.environment]}。`
              : "真实部署记录是发布状态的唯一事实源；生产发布会在写入服务器前等待你批准。"}
          </p>
          <div className="banner-actions">
            {pendingDeployment ? (
              <button
                type="button"
                className="button primary"
                onClick={() => onNavigate("pipelines")}
              >
                {pendingDeployment.kind === "rollback" ? "审批回滚" : "审批部署"}{" "}
                <ChevronRight size={16} />
              </button>
            ) : (
              <button type="button" className="button primary" onClick={onNewRelease}>
                <Play size={16} /> 发起发布
              </button>
            )}
            <button
              type="button"
              className="button secondary-on-dark"
              onClick={() => onNavigate("pipelines")}
            >
              查看流水线
            </button>
          </div>
        </div>
        <div className="release-radar" aria-hidden="true">
          <div className="radar-ring ring-one" />
          <div className="radar-ring ring-two" />
          <div className="radar-ring ring-three" />
          <div className="radar-core">
            <ShieldCheck size={28} />
            <strong>
              {pendingDeployment ? metrics.pendingDeploymentApprovals : "OK"}
            </strong>
            <span>
              {pendingDeployment
                ? `${metrics.pendingDeploymentApprovals} 待审批`
                : "健康"}
            </span>
          </div>
          <span className="radar-chip chip-one">仓库 {metrics.repositoryCount}</span>
          <span className="radar-chip chip-two">资源 {metrics.cloudResourceCount}</span>
          <span className="radar-chip chip-three">部署 {metrics.deploymentCount}</span>
          <span className="radar-chip chip-four">云账号 {cloudAccounts.length}</span>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard
          label="发布成功率"
          value={`${metrics.deploymentSuccessRate}%`}
          note={`${metrics.deploymentCount} 次真实部署 · ${metrics.failedDeployments} 次失败`}
          icon={<Activity size={20} />}
          tone="green"
          onClick={() => onNavigate("pipelines")}
        />
        <MetricCard
          label="生产待审批"
          value={String(metrics.pendingDeploymentApprovals)}
          note={
            metrics.pendingDeploymentApprovals > 0
              ? `${pendingDeployments.length} 个真实生产部署等待处理`
              : "当前无待审批 · 生产发布后在此显示"
          }
          icon={<ShieldCheck size={20} />}
          tone="amber"
          onClick={() => onNavigate("pipelines")}
        />
        <MetricCard
          label="受管云资源"
          value={String(metrics.cloudResourceCount)}
          note="来自已连接云账号的真实同步"
          icon={<Server size={20} />}
          tone="blue"
          onClick={() => onNavigate("cloud")}
        />
        <MetricCard
          label="本月消费"
          value={`¥${metrics.monthlyCost.toLocaleString("zh-CN")}`}
          note="腾讯云账单 · 本月消费"
          icon={<CircleDollarSign size={20} />}
          tone="indigo"
          onClick={() => onNavigate("cloud")}
        />
      </section>

      <section className="panel pending-approval-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">APPROVAL QUEUE</p>
            <h3>待审批事项</h3>
          </div>
          <span className="quiet-note">
            {metrics.pendingDeploymentApprovals > 0
              ? `${metrics.pendingDeploymentApprovals} 项等待你的决定`
              : "当前没有待审批事项"}
          </span>
        </div>
        {metrics.pendingDeploymentApprovals === 0 ? (
          <p className="empty-inline">
            当前没有等待审批的真实生产部署。到“应用管理”发起生产发布后，
            构建完成会先停在这里等你批准，不会自动上线。
          </p>
        ) : (
          <div className="deployment-mini-list">
            {pendingDeployments.map((deployment) => (
              <button
                type="button"
                className="deployment-mini-row"
                key={deployment.id}
                onClick={() => onNavigate("pipelines")}
              >
                <div>
                  <strong>{deployment.appName}</strong>
                  <small>
                    {ENVIRONMENT_LABELS[deployment.environment]} ·{" "}
                    {DEPLOYMENT_KIND_LABELS[deployment.kind]} · commit{" "}
                    {deployment.commitSha || "—"}
                  </small>
                </div>
                <span className="deployment-state waiting_approval">
                  待审批
                </span>
                <small>{timeAgo(deployment.startedAt)}</small>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel ponytail-overview-card">
        <div className="ponytail-overview-heading">
          <div className="ponytail-overview-title">
            <span>
              <Zap size={19} />
            </span>
            <div>
              <p className="eyebrow">PONYTAIL CONTROL</p>
              <h3>精简开发 Skill</h3>
              <p>用更少代码完成需求，并在 AI DevOps 内统一生成与追踪命令。</p>
            </div>
          </div>
          <button
            type="button"
            className="button secondary-on-light"
            onClick={() => onNavigate("ponytail")}
          >
            打开控制台 <ChevronRight size={15} />
          </button>
        </div>
        <div className="ponytail-overview-body">
          <div
            className={`ponytail-overview-status ${ponytail?.complete ? "ready" : "warning"}`}
          >
            <span>
              {ponytail?.complete ? (
                <ShieldCheck size={18} />
              ) : (
                <Clock3 size={18} />
              )}
            </span>
            <div>
              <small>安装状态</small>
              <strong>
                {ponytail?.complete
                  ? `v${ponytail.version ?? "—"} 完整可用`
                  : ponytail?.installed
                    ? "Skill 不完整"
                    : "未检测到"}
              </strong>
              <em>
                {ponytail?.skills.length ?? 0} /{" "}
                {ponytail?.expectedSkills.length ?? 6} 个 Skill
              </em>
            </div>
          </div>
          <div className="ponytail-overview-skills">
            <small>当前可用的六个 Skill</small>
            <div>
              {(ponytail?.expectedSkills ?? []).map((skill) => {
                const available = ponytail?.skills.includes(skill) ?? false;
                return (
                  <span
                    key={skill}
                    className={available ? "available" : "missing"}
                  >
                    {PONYTAIL_SKILL_LABELS[skill] ?? skill}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="ponytail-overview-signal">
            <div>
              <small>近 30 天复制</small>
              <strong>{ponytail?.generatedCommands["30d"] ?? 0}</strong>
              <em>次命令</em>
            </div>
            <p>
              {latestPonytailUse
                ? `最近：${PONYTAIL_SKILL_LABELS[latestPonytailUse.skill] ?? latestPonytailUse.skill} · ${timeAgo(latestPonytailUse.createdAt)}`
                : "还没有平台内复制记录"}
            </p>
          </div>
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">DEPLOYMENT ACTIVITY</p>
              <h3>最近发布（真实部署）</h3>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => onNavigate("pipelines")}
            >
              查看发布历史 <ChevronRight size={15} />
            </button>
          </div>
          <div className="run-list">
            {deliveryRows.length === 0 && (
              <p className="empty-inline">
                还没有真实部署记录。到“发布流水线”发起发布后会显示在这里。
              </p>
            )}
            {deliveryRows.map((deployment) => (
              <button
                type="button"
                className="run-row"
                key={deployment.id}
                onClick={() => onNavigate("pipelines")}
              >
                <span
                  className={classNames(
                    "run-state-icon",
                    `state-${deployment.status}`,
                  )}
                >
                  {deployment.status === "succeeded" ? (
                    <Check size={16} />
                  ) : deployment.status === "failed" ? (
                    <X size={16} />
                  ) : (
                    <Clock3 size={16} />
                  )}
                </span>
                <span className="run-main">
                  <strong>{deployment.appName}</strong>
                  <small>
                    {ENVIRONMENT_LABELS[deployment.environment]} ·{" "}
                    {deployment.serverName || "—"} ·{" "}
                    {deployment.commitSha || "—"}
                  </small>
                </span>
                <span
                  className={classNames(
                    "deployment-state",
                    deployment.status,
                  )}
                >
                  {deployment.status === "succeeded"
                    ? "部署成功"
                    : deployment.status === "failed"
                      ? "部署失败"
                      : deployment.status === "waiting_approval"
                        ? "待审批"
                        : deployment.status === "cancelled"
                          ? "已取消"
                          : "部署中"}
                </span>
                <span className="run-meta">
                  <small>{timeAgo(deployment.startedAt)}</small>
                  <small>{DEPLOYMENT_KIND_LABELS[deployment.kind]}</small>
                </span>
                <ChevronRight size={16} className="row-arrow" />
              </button>
            ))}
          </div>
        </article>

        <article className="panel copilot-card">
          <div className="copilot-heading">
            <div className="ai-orb">
              <Sparkles size={19} />
            </div>
            <div>
              <p className="eyebrow light">CODEX SIGNAL</p>
              <h3>AI 运维洞察</h3>
            </div>
            <span className="local-model-badge">本地分析</span>
          </div>
          {failedDeployment ? (
            <>
              <div className="insight-alert">
                <TriangleAlert size={17} />
                <span>检测到 1 个真实部署失败</span>
              </div>
              <p className="insight-copy">
                “{failedDeployment.appName}”最近一次发布未通过。请打开部署详情，
                检查失败步骤、执行日志和健康检查证据，再决定重试或回滚。
              </p>
              <div className="evidence-strip">
                <span>证据</span>
                <strong>{ENVIRONMENT_LABELS[failedDeployment.environment]}</strong>
                <strong>{failedDeployment.commitSha || "未固定版本"}</strong>
              </div>
              <button
                type="button"
                className="button copilot-button"
                onClick={() => onNavigate("pipelines")}
              >
                查看部署证据 <ArrowUpRight size={16} />
              </button>
            </>
          ) : (
            <>
              <p className="insight-copy">
                当前没有失败的真实部署。Copilot 会持续关联发布、日志和资源健康，
                只生成带证据的建议。
              </p>
              <button
                type="button"
                className="button copilot-button"
                onClick={() => onNavigate("copilot")}
              >
                询问 Copilot <ArrowUpRight size={16} />
              </button>
            </>
          )}
        </article>
      </section>

      <section className="dashboard-grid lower-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CLOUD FOOTPRINT</p>
              <h3>多云成本分布（真实账单）</h3>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => onNavigate("cloud")}
            >
              资源详情 <ChevronRight size={15} />
            </button>
          </div>
          <div className="provider-cost-list">
            {cloudAccounts.map((account) => (
              <div
                className="provider-cost clickable"
                key={account.id}
                role="button"
                tabIndex={0}
                onClick={() => onNavigate("cloud")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    onNavigate("cloud");
                  }
                }}
              >
                <ProviderMark provider={account.provider} />
                <div className="cost-main">
                  <div>
                    <strong>{PROVIDER_LABELS[account.provider]}</strong>
                    <span>¥{account.monthlyCost.toLocaleString("zh-CN")}</span>
                  </div>
                  <div className="cost-track">
                    <i
                      style={{
                        width: `${Math.max(8, (account.monthlyCost / maxCost) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <small>{account.resourceCount} 资源</small>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">REPOSITORY HEALTH</p>
              <h3>仓库版本状态</h3>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => onNavigate("repositories")}
            >
              管理仓库 <ChevronRight size={15} />
            </button>
          </div>
          <div className="repo-health-list">
            {repositories.slice(0, 3).map((repository) => (
              <div
                key={repository.id}
                className="repo-health-row clickable"
                role="button"
                tabIndex={0}
                onClick={() => onNavigate("repositories")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    onNavigate("repositories");
                  }
                }}
              >
                <ProviderMark provider={repository.provider} size="small" />
                <div>
                  <strong>{repository.name}</strong>
                  <small>
                    <GitCommitHorizontal size={13} />
                    {repository.lastCommit ?? "尚未同步"} · {repository.branch}
                  </small>
                </div>
                <StatusBadge status={repository.status} />
              </div>
            ))}
          </div>
        </article>
      </section>

    </div>
  );
}

function RepositoriesPage({
  repositories,
  search,
  onAdd,
  onSync,
}: {
  repositories: Repository[];
  search: string;
  onAdd: () => void;
  onSync: (repository: Repository) => void;
}) {
  const [syncing, setSyncing] = useState("");
  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return repositories.filter(
      (repo) =>
        !term ||
        repo.name.toLowerCase().includes(term) ||
        repo.provider.includes(term) ||
        repo.url.toLowerCase().includes(term),
    );
  }, [repositories, search]);

  async function handleSync(repository: Repository) {
    setSyncing(repository.id);
    onSync(repository);
    window.setTimeout(() => setSyncing(""), 900);
  }

  return (
    <div className="content-page">
      <section className="page-toolbar">
        <div>
          <span className="count-label">{filtered.length} 个受管仓库</span>
          <p>版本必须由 commit 固定，分支只作为同步入口。</p>
        </div>
        <button type="button" className="button primary" onClick={onAdd}>
          <Plus size={16} /> 接入仓库
        </button>
      </section>

      <div className="repository-grid">
        {filtered.map((repository) => (
          <article className="repository-card" key={repository.id}>
            <div className="repo-card-top">
              <ProviderMark provider={repository.provider} size="large" />
              <div className="repo-card-title">
                <div>
                  <h3>{repository.name}</h3>
                  <span>
                    {PROVIDER_LABELS[repository.provider]}
                    {repository.isDemo && <em>演示</em>}
                  </span>
                </div>
                <StatusBadge status={repository.status} />
              </div>
            </div>
            <div className="repo-url">
              <GitBranch size={14} />
              <span>{repository.url}</span>
            </div>
            <p className="repo-server-line">
              同步服务器：
              {repository.serverName ??
                (repository.serverId ? "已指定" : "未指定（将自动选择已连接服务器）")}
              {repository.hasToken ? " · 私有仓库令牌已配置" : ""}
            </p>
            <div className="repo-stat-row">
              <div>
                <small>当前分支</small>
                <strong>{repository.branch}</strong>
              </div>
              <div>
                <small>最新 commit</small>
                <strong className="mono">{repository.lastCommit ?? "—"}</strong>
              </div>
              <div>
                <small>最近同步</small>
                <strong>{timeAgo(repository.lastSyncedAt)}</strong>
              </div>
            </div>
            <div className="version-list">
              <span className="version-label">最近版本</span>
              {repository.versions.slice(0, 2).map((version) => (
                <div key={version.id} className="version-row">
                  <span className="mono">{version.commitSha}</span>
                  <span>{version.message}</span>
                  <small>{timeAgo(version.syncedAt)}</small>
                </div>
              ))}
              {repository.versions.length === 0 && (
                <p className="empty-inline">接入后执行一次同步以记录版本。</p>
              )}
            </div>
            <button
              type="button"
              className="button full-width"
              onClick={() => void handleSync(repository)}
              disabled={syncing === repository.id}
            >
              {syncing === repository.id ? (
                <Spinner label="正在同步" />
              ) : (
                <>
                  <RefreshCw size={15} /> 同步远程版本
                </>
              )}
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

function defaultFieldValue(
  field: AppTypeDefinition["fields"][number],
): string | number | boolean {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.kind === "number") return "";
  if (field.kind === "boolean") return false;
  return "";
}

function AppsPage({
  types,
  applications,
  repositories,
  search,
  onAdd,
  onEdit,
  onDelete,
  onPublish,
  onNavigate,
}: {
  types: AppTypeDefinition[];
  applications: Application[];
  repositories: Repository[];
  search: string;
  onAdd: (typeId?: string) => void;
  onEdit: (application: Application) => void;
  onDelete: (application: Application) => void;
  onPublish: (
    application: Application,
    environment: "development" | "staging" | "production",
  ) => void;
  onNavigate: (page: PageId) => void;
}) {
  const [publishTarget, setPublishTarget] = useState<Application | null>(null);
  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return applications.filter(
      (application) =>
        !term ||
        application.name.toLowerCase().includes(term) ||
        application.appTypeLabel.toLowerCase().includes(term) ||
        (application.repositoryName ?? "").toLowerCase().includes(term),
    );
  }, [applications, search]);

  return (
    <div className="content-page apps-page">
      <section className="page-toolbar">
        <div>
          <span className="count-label">{applications.length} 个受管应用</span>
          <p>
            同一个类型的字段模板只定义一次，新建应用时自动展开对应字段。
          </p>
        </div>
        <div className="page-toolbar-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => onNavigate("repositories")}
          >
            <GitBranch size={15} /> 管理代码仓库
          </button>
          <button type="button" className="button primary" onClick={() => onAdd()}>
            <Plus size={16} /> 新建应用
          </button>
        </div>
      </section>

      <section className="app-type-section">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">REUSABLE TYPE TEMPLATES</p>
            <h3>应用类型字段模板</h3>
          </div>
          <span className="quiet-note">
            选择类型即可复用模板，无需为每个新应用重复配置结构
          </span>
        </div>
        <div className="app-type-grid">
          {types.map((type) => {
            const requiredCount = type.fields.filter(
              (field) => field.required,
            ).length;
            return (
              <article className="app-type-card" key={type.id}>
                <div className="app-type-head">
                  <span className="app-type-short">{type.short}</span>
                  <div>
                    <h4>{type.label}</h4>
                    <p>{type.description}</p>
                  </div>
                </div>
                <div className="app-type-fields">
                  {type.fields.map((field) => (
                    <span className="app-field-chip" key={field.key}>
                      {field.label}
                      {field.required && <em>*</em>}
                    </span>
                  ))}
                </div>
                <div className="app-type-foot">
                  <span>
                    {type.fields.length} 个字段 · {requiredCount} 个必填
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onAdd(type.id)}
                  >
                    <Plus size={13} /> 新建
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel apps-table-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">APPLICATION REGISTRY</p>
            <h3>应用列表</h3>
          </div>
          <span className="quiet-note">
            {filtered.length}/{applications.length} 个应用
          </span>
        </div>
        {filtered.length > 0 ? (
          <div className="data-table-wrap">
            <table className="data-table apps-table">
              <thead>
                <tr>
                  <th>应用</th>
                  <th>类型</th>
                  <th>代码仓库</th>
                  <th>目标云 / 环境</th>
                  <th>关键配置</th>
                  <th>状态</th>
                  <th className="actions-column">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((application) => {
                  const type = types.find(
                    (item) => item.id === application.appType,
                  );
                  return (
                    <tr key={application.id}>
                      <td>
                        <strong>
                          {application.name}
                          {application.isDemo && (
                            <em className="app-demo-badge">演示</em>
                          )}
                        </strong>
                        <small className="mono">{application.id}</small>
                      </td>
                      <td>
                        <span className="app-type-tag">
                          <span className="app-type-short small">
                            {type?.short ?? "?"}
                          </span>
                          {application.appTypeLabel}
                        </span>
                      </td>
                      <td>
                        <strong>{application.repositoryName ?? "未关联"}</strong>
                        <small>
                          {application.repositoryId ?? "可稍后绑定仓库"}
                        </small>
                      </td>
                      <td>
                        <strong>
                          {application.targetProvider
                            ? PROVIDER_LABELS[application.targetProvider]
                            : "未选择云"}
                        </strong>
                        <small>
                          {ENVIRONMENT_LABELS[application.environment]}
                        </small>
                      </td>
                      <td className="app-values-cell">
                        {type?.fields.slice(0, 3).map((field) => {
                          const value = application.fields[field.key];
                          return (
                            <span key={field.key}>
                              <small>{field.label}</small>
                              {value === "" || value === undefined || value === null
                                ? "—"
                                : String(value)}
                            </span>
                          );
                        })}
                      </td>
                      <td>
                        <StatusBadge status={application.status} />
                      </td>
                      <td className="row-actions">
                        <button
                          type="button"
                          className="row-action-button"
                          onClick={() => setPublishTarget(application)}
                          title="发布到服务器"
                        >
                          <Play size={14} />
                        </button>
                        <button
                          type="button"
                          className="row-action-button"
                          onClick={() => onEdit(application)}
                          title="编辑应用"
                        >
                          <Pencil size={14} />
                        </button>
                        {!application.isDemo && (
                          <button
                            type="button"
                            className="row-action-button danger"
                            onClick={() => onDelete(application)}
                            title="删除应用"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="apps-empty">
            <AppWindow size={26} />
            <p>还没有应用。从上方类型模板中选择一种来新建。</p>
          </div>
        )}
      </section>

      {publishTarget && (
        <PublishAppModal
          application={publishTarget}
          onClose={() => setPublishTarget(null)}
          onPublish={(environment) => {
            setPublishTarget(null);
            onPublish(publishTarget, environment);
          }}
        />
      )}
    </div>
  );
}

function AppFormModal({
  types,
  repositories,
  application,
  initialType,
  onClose,
  onSaved,
  onError,
}: {
  types: AppTypeDefinition[];
  repositories: Repository[];
  application: Application | null;
  initialType?: string;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const firstType = types[0]?.id ?? "web";
  const [selectedType, setSelectedType] = useState(
    application?.appType ?? initialType ?? firstType,
  );
  const activeType = types.find((type) => type.id === selectedType) ?? types[0];
  const [name, setName] = useState(application?.name ?? "");
  const [repositoryId, setRepositoryId] = useState(
    application?.repositoryId ?? "",
  );
  const [targetProvider, setTargetProvider] = useState(
    application?.targetProvider ?? "",
  );
  const [environment, setEnvironment] = useState(
    application?.environment ?? "staging",
  );
  const [fields, setFields] = useState<
    Record<string, string | number | boolean>
  >(() => {
    const selected = types.find(
      (type) =>
        type.id === (application?.appType ?? initialType ?? firstType),
    );
    const result: Record<string, string | number | boolean> = {};
    for (const field of selected?.fields ?? []) {
      const existing = application?.fields[field.key];
      result[field.key] =
        existing !== undefined ? existing : defaultFieldValue(field);
    }
    return result;
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [envContent, setEnvContent] = useState("");
  const [envStatus, setEnvStatus] = useState<{
    configured: boolean;
    variableCount: number;
    updatedAt: string | null;
  } | null>(null);

  useEffect(() => {
    if (!application) {
      setEnvStatus(null);
      return;
    }
    let cancelled = false;
    api<{
      status: { configured: boolean; variableCount: number; updatedAt: string | null };
    }>(`/api/apps/${application.id}/env`)
      .then((result) => {
        if (!cancelled) setEnvStatus(result.status);
      })
      .catch(() => {
        if (!cancelled) setEnvStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [application?.id]);

  function changeType(nextType: string) {
    setSelectedType(nextType);
    const next = types.find((type) => type.id === nextType);
    const result: Record<string, string | number | boolean> = {};
    for (const field of next?.fields ?? []) {
      result[field.key] = defaultFieldValue(field);
    }
    setFields(result);
  }

  function updateField(key: string, value: string | number | boolean) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!activeType) {
      setFormError("请选择应用类型。");
      return;
    }
    for (const field of activeType.fields) {
      const value = fields[field.key];
      if (
        field.required &&
        (value === "" || value === undefined || value === null)
      ) {
        setFormError(`请填写“${field.label}”。`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const path = application
        ? `/api/apps/${application.id}`
        : "/api/apps";
      const method = application ? "PATCH" : "POST";
      const saved = await api<{ application: Application }>(path, {
        method,
        body: JSON.stringify({
          name,
          appType: selectedType,
          repositoryId: repositoryId || null,
          targetProvider: targetProvider || null,
          environment,
          fields,
        }),
      });
      if (envContent.trim()) {
        await api(`/api/apps/${saved.application.id}/env`, {
          method: "PUT",
          body: JSON.stringify({ content: envContent }),
        });
      }
      await onSaved(
        application ? "应用配置已更新。" : "应用已创建，字段值已按类型保存。",
      );
    } catch (error) {
      onError(error);
      setFormError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={application ? "编辑应用配置" : "新建应用"}
      subtitle="选择应用类型后，表单会自动切换为该类型需要的字段。"
      onClose={onClose}
    >
      <form className="modal-form app-form" onSubmit={submit}>
        <label>
          应用名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 客户官网 / 订单小程序"
            required
          />
        </label>

        <fieldset className="app-type-fieldset">
          <legend>应用类型</legend>
          <div className="app-type-picker">
            {types.map((type) => (
              <button
                type="button"
                key={type.id}
                className={classNames(selectedType === type.id && "active")}
                onClick={() => changeType(type.id)}
              >
                <span className="app-type-short small">{type.short}</span>
                <span>{type.label}</span>
              </button>
            ))}
          </div>
          <small className="field-hint">
            {activeType?.description} · 同类型应用共用一套字段模板
          </small>
        </fieldset>

        <div className="app-field-grid">
          {activeType?.fields.map((field) => (
            <label
              className={classNames(
                "app-field-input",
                field.kind === "textarea" && "span-two",
              )}
              key={field.key}
            >
              <span>
                {field.label}
                {field.required && <em>*</em>}
              </span>
              {field.kind === "select" && (
                <select
                  value={String(fields[field.key] ?? "")}
                  onChange={(event) =>
                    updateField(field.key, event.target.value)
                  }
                >
                  {field.options?.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              {field.kind === "textarea" && (
                <textarea
                  value={String(fields[field.key] ?? "")}
                  onChange={(event) =>
                    updateField(field.key, event.target.value)
                  }
                  placeholder={field.placeholder}
                  rows={2}
                />
              )}
              {field.kind === "boolean" && (
                <select
                  value={fields[field.key] ? "true" : "false"}
                  onChange={(event) =>
                    updateField(field.key, event.target.value === "true")
                  }
                >
                  <option value="false">关闭</option>
                  <option value="true">开启</option>
                </select>
              )}
              {(field.kind === "text" ||
                field.kind === "number" ||
                field.kind === "url") && (
                <input
                  type={
                    field.kind === "number"
                      ? "number"
                      : field.kind === "url"
                        ? "url"
                        : "text"
                  }
                  value={String(fields[field.key] ?? "")}
                  onChange={(event) =>
                    updateField(
                      field.key,
                      field.kind === "number"
                        ? event.target.value
                        : event.target.value,
                    )
                  }
                  placeholder={field.placeholder}
                  min={field.kind === "number" ? 0 : undefined}
                />
              )}
              {field.help && <small className="field-hint">{field.help}</small>}
            </label>
          ))}
        </div>

        <div className="app-relation-grid">
          <label>
            关联代码仓库
            <select
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
            >
              <option value="">暂不关联</option>
              {repositories.map((repository) => (
                <option value={repository.id} key={repository.id}>
                  {repository.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            目标云厂商
            <select
              value={targetProvider}
              onChange={(event) => setTargetProvider(event.target.value)}
            >
              <option value="">暂不选择</option>
              {(["tencent", "aliyun", "huawei"] as const).map((provider) => (
                <option value={provider} key={provider}>
                  {PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
          </label>
          <label>
            目标环境
            <select
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            >
              <option value="development">开发环境</option>
              <option value="staging">预发环境</option>
              <option value="production">生产环境</option>
            </select>
          </label>
        </div>

        <fieldset className="app-type-fieldset">
          <legend>环境变量（加密保存，发布时写入服务器）</legend>
          <small className="field-hint">
            {envStatus?.configured
              ? `已配置 ${envStatus.variableCount} 个变量。为避免泄露，不回显明文；如需修改，请粘贴完整内容覆盖。`
              : "尚未配置。每行一个 KEY=VALUE，发布时会写入上方“环境变量文件”路径。"}
          </small>
          <label>
            完整环境变量内容
            <textarea
              value={envContent}
              onChange={(event) => setEnvContent(event.target.value)}
              placeholder={"DB_HOST=127.0.0.1\nDB_PORT=3306\nJWT_SECRET=..."}
              rows={6}
            />
          </label>
          <small className="field-hint">
            留空表示不修改已保存内容。明文只在提交时传输，服务端加密存储，发布日志不会记录变量值。
          </small>
        </fieldset>

        {formError && (
          <div className="form-error">
            <TriangleAlert size={16} />
            {formError}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? (
              <Spinner label="正在保存" />
            ) : application ? (
              "保存修改"
            ) : (
              "创建应用"
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PublishAppModal({
  application,
  onClose,
  onPublish,
}: {
  application: Application;
  onClose: () => void;
  onPublish: (
    environment: "development" | "staging" | "production",
  ) => void;
}) {
  const [environment, setEnvironment] =
    useState<"development" | "staging" | "production">("staging");
  return (
    <Modal
      title={`发布应用：${application.name}`}
      subtitle="选择发布环境。开发/预发自动部署，生产环境构建完成后需要你审批。"
      onClose={onClose}
    >
      <div className="modal-form">
        <div className="provider-choice">
          {(["development", "staging", "production"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={classNames(environment === item && "active")}
              onClick={() => setEnvironment(item)}
            >
              {ENVIRONMENT_LABELS[item]}
            </button>
          ))}
        </div>
        <p className="field-hint">
          {environment === "production"
            ? "生产发布：先同步代码、构建并推送镜像，然后等待你在“部署记录”里点“批准生产部署”，才会真正部署到服务器。"
            : "将自动执行：同步 Gitee 代码 → 构建镜像 → 推送 TCR → 部署容器 → 健康检查，全程几分钟，请稍候。"}
        </p>
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => onPublish(environment)}
          >
            <Play size={15} /> 开始发布
          </button>
        </div>
      </div>
    </Modal>
  );
}

const DEPLOYMENT_PAGE_SIZE = 10;

function DeploymentsPanel({
  deployments,
  search,
  onApprove,
  onRollback,
  onCancel,
  title = "发布历史（真实部署）",
  description = "服务器实际发布的唯一事实源；旧门禁运行不计入这里",
  allDeployments,
}: {
  deployments: Deployment[];
  search: string;
  onApprove: (deployment: Deployment) => void;
  onRollback?: (deployment: Deployment) => Promise<boolean>;
  onCancel?: (deployment: Deployment) => void;
  title?: string;
  description?: string;
  allDeployments?: Deployment[];
}) {
  const [selected, setSelected] = useState<Deployment | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState("");
  const [pageIndex, setPageIndex] = useState(1);
  const term = search.trim().toLowerCase();
  const filtered = deployments.filter(
    (deployment) =>
      !term ||
      [
        deployment.appName,
        deployment.repositoryName,
        deployment.serverName,
        deployment.domain,
        deployment.imageTag,
        deployment.commitSha,
      ].some((value) => String(value ?? "").toLowerCase().includes(term)),
  );
  const pageCount = Math.max(
    1,
    Math.ceil(filtered.length / DEPLOYMENT_PAGE_SIZE),
  );
  const safePage = Math.min(pageIndex, pageCount);
  const pageRows = filtered.slice(
    (safePage - 1) * DEPLOYMENT_PAGE_SIZE,
    safePage * DEPLOYMENT_PAGE_SIZE,
  );

  useEffect(() => {
    setPageIndex(1);
  }, [term, deployments.length]);

  const pending = deployments.filter(
    (deployment) => deployment.status === "waiting_approval",
  ).length;
  const currentByEnvironment = new Map<string, Deployment>();
  for (const deployment of [...(allDeployments ?? deployments)].sort(
    (left, right) =>
      new Date(right.startedAt).getTime() -
      new Date(left.startedAt).getTime(),
  )) {
    if (deployment.status !== "succeeded") continue;
    const key = `${deployment.appId}:${deployment.environment}`;
    if (!currentByEnvironment.has(key)) {
      currentByEnvironment.set(key, deployment);
    }
  }
  const selectedCurrent = selected
    ? currentByEnvironment.get(`${selected.appId}:${selected.environment}`)
    : undefined;
  const rollbackTarget = selected
    ? (allDeployments ?? deployments).find(
        (deployment) => deployment.id === selected.targetDeploymentId,
      )
    : undefined;

  function openDeployment(deployment: Deployment, startRollback = false) {
    setSelected(deployment);
    setConfirmRollback(startRollback);
    setRollbackError("");
  }

  async function submitRollback() {
    if (!selected || !onRollback) return;
    setRollbackBusy(true);
    setRollbackError("");
    try {
      const created = await onRollback(selected);
      if (created) setSelected(null);
    } catch (error) {
      setRollbackError(
        error instanceof Error ? error.message : "创建回滚审批单失败。",
      );
    } finally {
      setRollbackBusy(false);
    }
  }

  async function refreshDetail() {
    if (!selected) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      const response = await api<{ deployment: Deployment }>(
        `/api/deployments/${selected.id}`,
      );
      setSelected(response.deployment);
      setLastRefreshed(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch (error) {
      setRefreshError(
        error instanceof Error ? error.message : "刷新失败，请重试。",
      );
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!selected || selected.status !== "running") return;
    const deploymentId = selected.id;
    const timer = window.setInterval(async () => {
      try {
        const response = await api<{ deployment: Deployment }>(
          `/api/deployments/${deploymentId}`,
        );
        setSelected((current) =>
          current && current.id === deploymentId ? response.deployment : current,
        );
        setLastRefreshed(
          new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        );
      } catch {
        // 自动刷新失败时保留当前内容。
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.status]);

  return (
    <>
      <section className="panel deployments-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">DEPLOYMENT HISTORY</p>
            <h3>
              {title}
              {pending > 0 && (
                <span className="protected-badge">
                  <LockKeyhole size={12} /> 待审批 {pending}
                </span>
              )}
            </h3>
          </div>
          <span className="quiet-note">{description}</span>
        </div>
        {filtered.length === 0 ? (
          <p className="empty-inline">
            还没有匹配的部署记录。请到“应用管理”发起发布。
          </p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>应用</th>
                  <th>类型</th>
                  <th>环境</th>
                  <th>版本</th>
                  <th>服务器</th>
                  <th>域名 / 端口</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((deployment) => (
                  <tr key={deployment.id}>
                    <td>
                      <strong>{deployment.appName}</strong>
                      <small>
                        {deployment.repositoryName} ·{" "}
                        {deployment.imageTag.split("/").pop() || "—"}
                      </small>
                    </td>
                    <td>
                      <span className={`deployment-kind ${deployment.kind}`}>
                        {DEPLOYMENT_KIND_LABELS[deployment.kind]}
                      </span>
                    </td>
                    <td>{ENVIRONMENT_LABELS[deployment.environment]}</td>
                    <td className="mono">{deployment.commitSha || "—"}</td>
                    <td>{deployment.serverName || "—"}</td>
                    <td>
                      {deployment.domain ? (
                        <span>
                          {deployment.domain}
                          <small>127.0.0.1:{deployment.port}</small>
                        </span>
                      ) : deployment.serverHost ? (
                        <span className="mono">
                          http://{deployment.serverHost}:{deployment.port}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="status-with-current">
                        <StatusBadge status={deployment.status} />
                        {currentByEnvironment.get(
                          `${deployment.appId}:${deployment.environment}`,
                        )?.id === deployment.id && (
                          <small className="current-version-badge">当前</small>
                        )}
                      </span>
                    </td>
                    <td>{formatDate(deployment.startedAt)}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="button ghost compact"
                        onClick={() => openDeployment(deployment)}
                      >
                        详情
                      </button>
                      {deployment.status === "succeeded" &&
                        onRollback &&
                        currentByEnvironment.get(
                          `${deployment.appId}:${deployment.environment}`,
                        )?.id !== deployment.id && (
                          <button
                            type="button"
                            className="button ghost compact danger-text"
                            onClick={() => openDeployment(deployment, true)}
                          >
                            回滚
                          </button>
                        )}
                      {deployment.status === "waiting_approval" && (
                        <>
                          <button
                            type="button"
                            className="button primary compact"
                            onClick={() => onApprove(deployment)}
                          >
                            {deployment.kind === "rollback"
                              ? "批准并回滚"
                              : "批准生产部署"}
                          </button>
                          {onCancel && (
                            <button
                              type="button"
                              className="button ghost compact danger-text"
                              onClick={() => onCancel(deployment)}
                            >
                              取消
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > DEPLOYMENT_PAGE_SIZE && (
          <PanelPagination
            total={filtered.length}
            page={safePage}
            pageCount={pageCount}
            onPage={setPageIndex}
          />
        )}
      </section>

      {selected && (
        <Modal
          title={`部署详情：${selected.appName}`}
          subtitle={`${ENVIRONMENT_LABELS[selected.environment]} · ${
            selected.commitSha || "—"
          } · ${STATUS_LABELS[selected.status] ?? selected.status}`}
          eyebrow="DEPLOYMENT EVIDENCE"
          onClose={() => setSelected(null)}
        >
          <div className="deployment-detail">
            <div className="deployment-detail-actions">
              <span>
                {lastRefreshed
                  ? `最后更新 ${lastRefreshed}`
                  : "点击刷新获取最新状态"}
                {selected.status === "running" && " · 运行中每 5 秒自动刷新"}
              </span>
              <button
                type="button"
                className="button secondary compact"
                onClick={() => void refreshDetail()}
                disabled={refreshing}
              >
                <RefreshCw size={14} className={refreshing ? "spin" : ""} />
                {refreshing ? "刷新中" : "刷新"}
              </button>
            </div>
            {refreshError && <p className="form-error">{refreshError}</p>}
            <div className="deployment-meta-grid">
              <div>
                <small>发布类型</small>
                <strong>{DEPLOYMENT_KIND_LABELS[selected.kind]}</strong>
              </div>
              <div>
                <small>触发人</small>
                <strong>{selected.triggeredBy || "历史记录未记录"}</strong>
              </div>
              <div>
                <small>审批人 / 时间</small>
                <strong>
                  {selected.approvedBy
                    ? `${selected.approvedBy} · ${formatDate(selected.approvedAt)}`
                    : selected.status === "cancelled"
                      ? "已取消 · 未执行"
                    : selected.kind === "auto_rollback"
                      ? "系统自动恢复"
                      : selected.environment === "production"
                        ? "待审批"
                        : "开发/预发自动执行"}
                </strong>
              </div>
              <div>
                <small>开始 / 完成</small>
                <strong>
                  {formatDate(selected.startedAt)} /{" "}
                  {selected.finishedAt ? formatDate(selected.finishedAt) : "进行中"}
                </strong>
              </div>
              <div>
                <small>镜像</small>
                <strong className="mono">{selected.imageTag || "—"}</strong>
              </div>
              <div>
                <small>上一个运行版本</small>
                <strong className="mono">
                  {selected.previousImageTag || "无历史版本"}
                </strong>
              </div>
              {(selected.kind === "rollback" ||
                selected.kind === "auto_rollback") && (
                <div>
                  <small>回滚目标</small>
                  <strong className="mono">
                    {rollbackTarget?.commitSha || selected.commitSha || "—"}
                    {rollbackTarget?.imageTag
                      ? ` · ${rollbackTarget.imageTag.split("/").pop()}`
                      : ""}
                  </strong>
                </div>
              )}
              <div>
                <small>服务器</small>
                <strong>{selected.serverName || "—"}</strong>
              </div>
              <div>
                <small>访问地址</small>
                <strong className="mono">
                  {selected.domain
                    ? `https://${selected.domain}`
                    : selected.serverHost
                      ? `http://${selected.serverHost}:${selected.port}`
                      : "—"}
                </strong>
              </div>
              <div>
                <small>域名</small>
                <strong>{selected.domain || "—"}</strong>
              </div>
              <div>
                <small>端口</small>
                <strong>
                  {selected.port}
                  {selected.containerPort
                    ? ` → 容器 ${selected.containerPort}`
                    : ""}
                </strong>
              </div>
              <div>
                <small>网络模式</small>
                <strong>{selected.networkMode || "bridge"}</strong>
              </div>
              <div>
                <small>健康检查</small>
                <strong className="mono">{selected.healthPath || "/"}</strong>
              </div>
              <div>
                <small>环境变量文件</small>
                <strong className="mono">{selected.envFile || "—"}</strong>
              </div>
              <div>
                <small>数据卷</small>
                <strong className="mono">{selected.volumes || "—"}</strong>
              </div>
            </div>
            <h4>执行步骤</h4>
            <div className="deployment-step-list">
              {selected.steps.map((step, index) => (
                <div
                  className={classNames(
                    "deployment-step-card",
                    `step-${step.status}`,
                  )}
                  key={step.key ?? `${step.name}-${index}`}
                >
                  <div className="deployment-step-head">
                    <StatusBadge status={step.status} />
                    <strong>{step.name}</strong>
                    <small>
                      {step.durationMs !== undefined
                        ? formatDuration(step.durationMs)
                        : step.status === "running"
                          ? "执行中"
                          : "—"}
                    </small>
                  </div>
                  <p>{step.description || "未记录步骤说明"}</p>
                  {(step.startedAt || step.finishedAt) && (
                    <div className="deployment-step-time">
                      <span>
                        开始 {step.startedAt ? formatDate(step.startedAt) : "—"}
                      </span>
                      <span>
                        完成 {step.finishedAt ? formatDate(step.finishedAt) : "—"}
                      </span>
                    </div>
                  )}
                  {step.result && (
                    <div className="deployment-step-result">
                      <span>结果</span>
                      <strong>{step.result}</strong>
                    </div>
                  )}
                  {step.command && (
                    <code className="deployment-step-command">
                      {step.command}
                    </code>
                  )}
                  {step.exitCode !== undefined && step.exitCode !== null && (
                    <span
                      className={classNames(
                        "exit-code",
                        step.exitCode === 0 ? "success" : "failed",
                      )}
                    >
                      退出码 {step.exitCode}
                    </span>
                  )}
                  {step.evidence && step.evidence.length > 0 && (
                    <ul className="deployment-step-evidence">
                      {step.evidence.map((item, evidenceIndex) => (
                        <li key={`${step.key ?? step.name}-${evidenceIndex}`}>
                          {item}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <h4>发布日志</h4>
            <div className="deployment-log-list">
              {selected.logs.map((log, index) => (
                <div key={`${log.time}-${index}`} className={`log-${log.level}`}>
                  <span className="mono">{formatDate(log.time)}</span>
                  <p>{log.message}</p>
                </div>
              ))}
            </div>
            {selected.error && <p className="form-error">{selected.error}</p>}
            {rollbackError && <p className="form-error">{rollbackError}</p>}
            {selected.status === "waiting_approval" && (
              <div className="modal-actions">
                {onCancel && (
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => {
                      onCancel(selected);
                      setSelected(null);
                    }}
                  >
                    取消操作
                  </button>
                )}
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    onApprove(selected);
                    setSelected(null);
                  }}
                >
                  {selected.kind === "rollback"
                    ? "批准并执行回滚"
                    : "批准生产部署"}
                </button>
              </div>
            )}
            {selected.status === "succeeded" &&
              onRollback &&
              selectedCurrent?.id !== selected.id && (
                <div className="rollback-action">
                  {!confirmRollback ? (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        setConfirmRollback(true);
                        setRollbackError("");
                      }}
                    >
                      <RotateCcw size={15} /> 回滚到此版本
                    </button>
                  ) : (
                    <div className="rollback-confirm">
                      <div className="rollback-confirm-head">
                        <TriangleAlert size={18} />
                        <div>
                          <strong>确认创建回滚审批单</strong>
                          <p>
                            将把 {selected.appName} 从当前版本{" "}
                            {selectedCurrent?.commitSha || "未知"} 回滚到{" "}
                            {selected.commitSha}。只切换 commit/镜像，沿用当前服务器、
                            端口、环境变量和数据卷配置。
                          </p>
                        </div>
                      </div>
                      <div className="rollback-version-compare">
                        <span>
                          当前
                          <strong className="mono">
                            {selectedCurrent?.commitSha || "未知"}
                          </strong>
                        </span>
                        <ChevronRight size={16} />
                        <span>
                          目标
                          <strong className="mono">{selected.commitSha}</strong>
                        </span>
                      </div>
                      <p className="field-hint">
                        此操作不会立即修改服务器。审批单创建后，还需要在发布记录中点击
                        “批准并执行回滚”，并通过回滚健康检查后才算完成。
                      </p>
                      <div className="modal-actions">
                        <button
                          type="button"
                          className="button ghost"
                          onClick={() => setConfirmRollback(false)}
                          disabled={rollbackBusy}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="button primary"
                          onClick={() => void submitRollback()}
                          disabled={rollbackBusy}
                        >
                          {rollbackBusy ? (
                            <Spinner label="创建中" />
                          ) : (
                            <>
                              <RotateCcw size={15} /> 创建回滚审批单
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
          </div>
        </Modal>
      )}
    </>
  );
}

function VersionCenterPage({
  applications,
  deployments,
  search,
  onApprove,
  onRollback,
  onCancel,
  onNavigate,
}: {
  applications: Application[];
  deployments: Deployment[];
  search: string;
  onApprove: (deployment: Deployment) => void;
  onRollback: (deployment: Deployment) => Promise<boolean>;
  onCancel: (deployment: Deployment) => void;
  onNavigate: (page: PageId) => void;
}) {
  const [applicationId, setApplicationId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [status, setStatus] = useState("");
  const visibleDeployments = useMemo(() => {
    const term = search.trim().toLowerCase();
    return deployments.filter(
      (deployment) =>
        (!applicationId || deployment.appId === applicationId) &&
        (!environment || deployment.environment === environment) &&
        (!status || deployment.status === status) &&
        (!term ||
          [
            deployment.appName,
            deployment.repositoryName,
            deployment.commitSha,
            deployment.imageTag,
            deployment.serverName,
          ].some((value) =>
            String(value ?? "").toLowerCase().includes(term),
          )),
    );
  }, [applicationId, deployments, environment, search, status]);
  const succeeded = deployments.filter(
    (deployment) => deployment.status === "succeeded",
  );
  const rollbacks = deployments.filter(
    (deployment) =>
      deployment.kind === "rollback" ||
      deployment.kind === "auto_rollback",
  );
  const pendingRollbacks = deployments.filter(
    (deployment) =>
      deployment.kind === "rollback" &&
      deployment.status === "waiting_approval",
  );
  const appVersionCounts = new Map<string, Set<string>>();
  for (const deployment of succeeded) {
    const versions = appVersionCounts.get(deployment.appId) ?? new Set<string>();
    versions.add(deployment.commitSha || deployment.imageTag);
    appVersionCounts.set(deployment.appId, versions);
  }
  const rollbackReadyApps = [...appVersionCounts.values()].filter(
    (versions) => versions.size > 1,
  ).length;

  return (
    <div className="content-page version-center-page">
      <section className="page-toolbar">
        <div>
          <span className="count-label">{deployments.length} 条真实版本记录</span>
          <p>
            版本中心直接读取真实部署记录，不另存版本副本；成功版本可创建人工回滚审批。
          </p>
        </div>
        <div className="page-toolbar-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => onNavigate("pipelines")}
          >
            <Workflow size={15} /> 按项目查看
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => onNavigate("apps")}
          >
            <Layers size={15} /> 管理应用
          </button>
        </div>
      </section>

      <section className="metrics-grid project-metrics">
        <MetricCard
          label="成功版本"
          value={String(succeeded.length)}
          note="来自真实部署记录"
          icon={<GitCommitHorizontal size={20} />}
          tone="indigo"
        />
        <MetricCard
          label="可回滚应用"
          value={String(rollbackReadyApps)}
          note="至少有一个历史成功版本"
          icon={<RotateCcw size={20} />}
          tone="green"
        />
        <MetricCard
          label="回滚记录"
          value={String(rollbacks.length)}
          note="人工回滚与自动回滚"
          icon={<Activity size={20} />}
          tone="blue"
        />
        <MetricCard
          label="待执行回滚"
          value={String(pendingRollbacks.length)}
          note="批准后才会修改服务器"
          icon={<ShieldCheck size={20} />}
          tone="amber"
        />
      </section>

      <section className="panel version-filter-panel">
        <div className="version-filter-head">
          <div className="version-filter-title">
            <span className="version-filter-icon">
              <ListChecks size={17} />
            </span>
            <div>
              <strong>筛选版本</strong>
              <small>按应用、环境和发布状态定位版本记录</small>
            </div>
          </div>
          <div className="version-filter-summary">
            <span className="version-filter-count">
              显示 <strong>{visibleDeployments.length}</strong> /{" "}
              {deployments.length} 条
            </span>
            {(applicationId || environment || status) && (
              <button
                type="button"
                className="version-filter-reset"
                onClick={() => {
                  setApplicationId("");
                  setEnvironment("");
                  setStatus("");
                }}
              >
                <X size={13} /> 清除筛选
              </button>
            )}
          </div>
        </div>
        <div className="version-filters">
          <label
            className={classNames(
              "version-filter-field",
              applicationId && "has-value",
            )}
          >
            <span>应用</span>
            <div className="version-select-shell">
              <select
                value={applicationId}
                onChange={(event) => setApplicationId(event.target.value)}
              >
                <option value="">全部应用</option>
                {applications.map((application) => (
                  <option key={application.id} value={application.id}>
                    {application.name}
                  </option>
                ))}
              </select>
              <ChevronRight size={14} />
            </div>
          </label>
          <label
            className={classNames(
              "version-filter-field",
              environment && "has-value",
            )}
          >
            <span>环境</span>
            <div className="version-select-shell">
              <select
                value={environment}
                onChange={(event) => setEnvironment(event.target.value)}
              >
                <option value="">全部环境</option>
                <option value="development">开发环境</option>
                <option value="staging">预发环境</option>
                <option value="production">生产环境</option>
              </select>
              <ChevronRight size={14} />
            </div>
          </label>
          <label
            className={classNames(
              "version-filter-field",
              status && "has-value",
            )}
          >
            <span>状态</span>
            <div className="version-select-shell">
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">全部状态</option>
                <option value="succeeded">已成功</option>
                <option value="waiting_approval">待审批</option>
                <option value="running">执行中</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
              </select>
              <ChevronRight size={14} />
            </div>
          </label>
        </div>
      </section>

      <DeploymentsPanel
        deployments={visibleDeployments}
        allDeployments={deployments}
        search=""
        title="版本中心（真实部署）"
        description="一个版本只存一份事实；当前版本、历史版本和回滚记录均来自同一部署数据源"
        onApprove={onApprove}
        onRollback={onRollback}
        onCancel={onCancel}
      />
    </div>
  );
}

function ProjectReleasesPage({
  applications,
  deployments,
  healthChecks,
  search,
  onPublish,
  onApprove,
  onRollback,
  onCancel,
  onNavigate,
}: {
  applications: Application[];
  deployments: Deployment[];
  healthChecks: HealthCheck[];
  search: string;
  onPublish: (
    application: Application,
    environment: "development" | "staging" | "production",
  ) => void;
  onApprove: (deployment: Deployment) => void;
  onRollback: (deployment: Deployment) => Promise<boolean>;
  onCancel: (deployment: Deployment) => void;
  onNavigate: (page: PageId) => void;
}) {
  const [selectedAppId, setSelectedAppId] = useState("");
  const [publishTarget, setPublishTarget] = useState<Application | null>(null);
  const term = search.trim().toLowerCase();
  const projects = applications.filter(
    (application) =>
      !term ||
      application.name.toLowerCase().includes(term) ||
      (application.repositoryName ?? "").toLowerCase().includes(term),
  );
  const selected =
    applications.find((application) => application.id === selectedAppId) ?? null;

  function appDeployments(app: Application) {
    return deployments
      .filter((deployment) => deployment.appId === app.id)
      .sort(
        (left, right) =>
          new Date(right.startedAt).getTime() -
          new Date(left.startedAt).getTime(),
      );
  }

  function appHealth(app: Application) {
    return healthChecks.find((check) => check.appId === app.id);
  }

  const pending = deployments.filter(
    (deployment) => deployment.status === "waiting_approval",
  ).length;
  const unhealthy = healthChecks.filter(
    (check) => check.status === "unhealthy",
  ).length;

  if (selected) {
    const deploymentsForApp = appDeployments(selected);
    const health = appHealth(selected);
    const succeeded = deploymentsForApp.filter(
      (deployment) => deployment.status === "succeeded",
    ).length;
    const completed = deploymentsForApp.filter(
      (deployment) =>
        deployment.status === "succeeded" ||
        deployment.status === "failed",
    ).length;
    const successRate =
      completed > 0
        ? Math.round((succeeded / completed) * 100)
        : 0;
    return (
      <div className="content-page">
        <section className="page-toolbar">
          <div>
            <button
              type="button"
              className="button ghost compact"
              onClick={() => setSelectedAppId("")}
            >
              ← 返回项目列表
            </button>
            <span className="count-label" style={{ marginLeft: 10 }}>
              {selected.name}
            </span>
            <p>
              {selected.appTypeLabel} · {selected.repositoryName ?? "未关联仓库"} ·{" "}
              {ENVIRONMENT_LABELS[selected.environment]}
            </p>
          </div>
          <div className="page-toolbar-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => onNavigate("apps")}
            >
              <Layers size={15} /> 管理应用
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => setPublishTarget(selected)}
            >
              <Play size={15} /> 发起发布
            </button>
          </div>
        </section>

        <section className="metrics-grid project-metrics">
          <MetricCard
            label="部署次数"
            value={String(deploymentsForApp.length)}
            note="真实部署记录"
            icon={<Workflow size={20} />}
            tone="indigo"
          />
          <MetricCard
            label="部署成功率"
            value={`${successRate}%`}
            note={`${succeeded} 次成功 / ${completed} 次已完成`}
            icon={<Activity size={20} />}
            tone="green"
          />
          <MetricCard
            label="最近部署"
            value={
              deploymentsForApp[0]
                ? timeAgo(deploymentsForApp[0].startedAt)
                : "尚未部署"
            }
            note={deploymentsForApp[0]?.commitSha ?? "—"}
            icon={<Clock3 size={20} />}
            tone="amber"
          />
          <MetricCard
            label="持续健康"
            value={
              health
                ? health.status === "healthy"
                  ? "健康"
                  : "异常"
                : "待巡检"
            }
            note={
              health
                ? `${health.message} · ${timeAgo(health.checkedAt)}`
                : "每 60 秒自动巡检一次"
            }
            icon={<ShieldCheck size={20} />}
            tone={health?.status === "unhealthy" ? "amber" : "green"}
          />
        </section>

        <section className="panel health-monitor-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">CONTINUOUS HEALTH</p>
              <h3>持续健康监控与自动恢复</h3>
            </div>
            <span
              className={classNames(
                "deployment-state",
                health?.status === "healthy"
                  ? "succeeded"
                  : health?.status === "unhealthy"
                    ? "failed"
                    : "",
              )}
            >
              {health?.status === "healthy"
                ? "健康"
                : health?.status === "unhealthy"
                  ? "异常"
                  : "待巡检"}
            </span>
          </div>
          {health ? (
            <div className="health-detail-grid">
              <div>
                <small>最近检查</small>
                <strong>{timeAgo(health.checkedAt)}</strong>
              </div>
              <div>
                <small>检查地址</small>
                <strong className="mono">
                  {health.port}
                  {health.healthPath}
                </strong>
              </div>
              <div>
                <small>HTTP 状态</small>
                <strong>{health.httpStatus || "—"}</strong>
              </div>
              <div>
                <small>响应时间</small>
                <strong>{health.responseMs} ms</strong>
              </div>
              <div>
                <small>连续失败</small>
                <strong>{health.consecutiveFailures} 次</strong>
              </div>
              <div>
                <small>最近消息</small>
                <strong>{health.message}</strong>
              </div>
            </div>
          ) : (
            <p className="empty-inline">
              该项目还没有巡检记录。监控启动后每 60 秒检查一次，部署后约 15 秒开始首次巡检。
            </p>
          )}
          <p className="field-hint">
            连续失败 3 次会自动重启容器；重启后仍异常，会回滚到上一成功镜像版本，
            所有恢复动作记录在审计中心。
          </p>
        </section>

        <DeploymentsPanel
          deployments={deploymentsForApp}
          search=""
          onApprove={onApprove}
          onRollback={onRollback}
          onCancel={onCancel}
        />

        {publishTarget && (
          <PublishAppModal
            application={publishTarget}
            onClose={() => setPublishTarget(null)}
            onPublish={(environment) => {
              setPublishTarget(null);
              onPublish(selected, environment);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="content-page">
      <section className="page-toolbar">
        <div>
          <span className="count-label">{applications.length} 个项目</span>
          <p>
            这里是跨项目汇总；点项目卡片可查看该项目的真实部署明细、健康状态与审批记录。
          </p>
        </div>
        <div className="page-toolbar-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => onNavigate("repositories")}
          >
            <GitBranch size={15} /> 管理代码源
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => onNavigate("apps")}
          >
            <Layers size={15} /> 管理项目
          </button>
        </div>
      </section>

      <section className="metrics-grid project-metrics">
        <MetricCard
          label="项目总数"
          value={String(applications.length)}
          note="每个项目独立查看发布历史"
          icon={<Layers size={20} />}
          tone="indigo"
        />
        <MetricCard
          label="真实部署"
          value={String(deployments.length)}
          note="全部项目的部署记录"
          icon={<Workflow size={20} />}
          tone="green"
        />
        <MetricCard
          label="待审批"
          value={String(pending)}
          note="生产发布需人工批准"
          icon={<ShieldCheck size={20} />}
          tone="amber"
        />
        <MetricCard
          label="健康异常"
          value={String(unhealthy)}
          note="持续巡检发现异常的项目"
          icon={<Activity size={20} />}
          tone="blue"
        />
      </section>

      {projects.length === 0 ? (
        <section className="panel">
          <div className="apps-empty">
            <Layers size={26} />
            <p>还没有项目。到“应用管理”新建项目后，这里会按项目展示发布历史。</p>
          </div>
        </section>
      ) : (
        <section className="project-release-grid">
          {projects.map((application) => {
            const list = appDeployments(application);
            const latest = list[0];
            const health = appHealth(application);
            const appPending = list.filter(
              (deployment) => deployment.status === "waiting_approval",
            ).length;
            return (
              <article
                className="project-release-card"
                key={application.id}
                onClick={() => setSelectedAppId(application.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    setSelectedAppId(application.id);
                  }
                }}
              >
                <div className="project-card-head">
                  <div className="project-icon">
                    <AppWindow size={19} />
                  </div>
                  <div>
                    <strong>{application.name}</strong>
                    <small>
                      {application.appTypeLabel} ·{" "}
                      {application.repositoryName ?? "未关联仓库"}
                    </small>
                  </div>
                  <span
                    className={classNames(
                      "deployment-state",
                      health?.status === "healthy"
                        ? "succeeded"
                        : health?.status === "unhealthy"
                          ? "failed"
                          : "",
                    )}
                  >
                    {health?.status === "healthy"
                      ? "健康"
                      : health?.status === "unhealthy"
                        ? "异常"
                        : "待巡检"}
                  </span>
                </div>
                <div className="project-card-stats">
                  <div>
                    <small>部署次数</small>
                    <strong>{list.length}</strong>
                  </div>
                  <div>
                    <small>最近状态</small>
                    <strong>
                      {latest
                        ? latest.status === "succeeded"
                          ? "成功"
                          : latest.status === "failed"
                            ? "失败"
                            : latest.status === "waiting_approval"
                              ? "待审批"
                              : latest.status === "cancelled"
                                ? "已取消"
                                : "运行中"
                        : "尚未部署"}
                    </strong>
                  </div>
                  <div>
                    <small>最近部署</small>
                    <strong>
                      {latest ? timeAgo(latest.startedAt) : "—"}
                    </strong>
                  </div>
                </div>
                <div className="project-card-footer">
                  <span>{ENVIRONMENT_LABELS[application.environment]}</span>
                  {appPending > 0 && (
                    <span className="project-pending-badge">
                      待审批 {appPending}
                    </span>
                  )}
                  <button
                    type="button"
                    className="button ghost compact"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedAppId(application.id);
                    }}
                  >
                    查看发布历史 <ChevronRight size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}

    </div>
  );
}

function PipelinesPage({
  pipelines,
  runs,
  deployments,
  search,
  onRun,
  onSelectRun,
  onApprove,
  onNavigate,
}: {
  pipelines: Pipeline[];
  runs: PipelineRun[];
  deployments: Deployment[];
  search: string;
  onRun: (pipeline: Pipeline) => void;
  onSelectRun: (run: PipelineRun) => void;
  onApprove: (deployment: Deployment) => void;
  onNavigate: (page: PageId) => void;
}) {
  const [running, setRunning] = useState("");
  const filteredPipelines = pipelines.filter(
    (pipeline) =>
      !search ||
      pipeline.name.toLowerCase().includes(search.toLowerCase()) ||
      pipeline.repositoryName.toLowerCase().includes(search.toLowerCase()),
  );

  function trigger(pipeline: Pipeline) {
    setRunning(pipeline.id);
    onRun(pipeline);
    window.setTimeout(() => setRunning(""), 1_200);
  }

  const historyRows = [
    ...runs.map((run) => ({
      key: `run-${run.id}`,
      kind: "run" as const,
      name: run.pipelineName,
      subtitle: run.repositoryName,
      status: run.status,
      environment: run.environment,
      commitSha: run.commitSha,
      actor: run.triggeredBy,
      durationMs: run.durationMs,
      startedAt: run.startedAt,
      run,
      deployment: null,
    })),
    ...deployments.map((deployment) => ({
      key: `deployment-${deployment.id}`,
      kind: "deployment" as const,
      name: deployment.appName,
      subtitle: deployment.repositoryName,
      status: deployment.status,
      environment: deployment.environment,
      commitSha: deployment.commitSha,
      actor: "真实部署",
      durationMs: deployment.finishedAt
        ? new Date(deployment.finishedAt).getTime() -
          new Date(deployment.startedAt).getTime()
        : null,
      startedAt: deployment.startedAt,
      run: null,
      deployment,
    })),
  ]
    .filter(
      (item) =>
        !search ||
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.subtitle.toLowerCase().includes(search.toLowerCase()),
    )
    .sort(
      (left, right) =>
        new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
    )
    .slice(0, 12);

  return (
    <div className="content-page">
      <section className="page-toolbar">
        <div>
          <span className="count-label">
            {pipelines.length} 条流水线 · {deployments.length} 次真实部署
          </span>
          <p>
            流水线卡片为门禁演示；真实构建与部署在下方“真实部署记录”和“运行历史”中。
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() => onNavigate("repositories")}
        >
          <GitBranch size={16} /> 管理代码源
        </button>
      </section>

      <DeploymentsPanel
        deployments={deployments}
        search={search}
        onApprove={onApprove}
      />

      <div className="pipeline-grid">
        {filteredPipelines.map((pipeline) => {
          const pipelineRuns = runs.filter(
            (run) => run.pipelineId === pipeline.id,
          );
          const lastRun = pipelineRuns[0];
          return (
            <article className="pipeline-card" key={pipeline.id}>
              <div className="pipeline-card-header">
                <div>
                  <div className="pipeline-title-line">
                    <h3>{pipeline.name}</h3>
                    {pipeline.environment === "production" && (
                      <span className="protected-badge">
                        <LockKeyhole size={12} /> 生产门禁
                      </span>
                    )}
                  </div>
                  <p>
                    {pipeline.repositoryName} ·{" "}
                    {ENVIRONMENT_LABELS[pipeline.environment]}
                  </p>
                </div>
                <span className={classNames("trigger-chip", pipeline.triggerType)}>
                  {pipeline.triggerType === "webhook" ? "Webhook" : "手动触发"}
                </span>
              </div>
              <div className="pipeline-flow">
                {pipeline.steps.map((step, index) => (
                  <div className="pipeline-flow-step" key={`${step.name}-${index}`}>
                    <span className={classNames("flow-index", step.status)}>
                      {step.status === "succeeded" ? <Check size={12} /> : index + 1}
                    </span>
                    <small>{step.name}</small>
                    {index < pipeline.steps.length - 1 && (
                      <i className="flow-connector" />
                    )}
                  </div>
                ))}
              </div>
              <div className="pipeline-meta-grid">
                <div>
                  <small>最近运行</small>
                  <strong>{lastRun ? timeAgo(lastRun.startedAt) : "尚未运行"}</strong>
                </div>
                <div>
                  <small>固定版本</small>
                  <strong className="mono">{pipeline.lastCommit ?? "—"}</strong>
                </div>
                <div>
                  <small>最终状态</small>
                  {lastRun ? (
                    <StatusBadge status={lastRun.status} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </div>
              <div className="pipeline-actions">
                <button
                  type="button"
                  className="button primary compact"
                  onClick={() => trigger(pipeline)}
                  disabled={running === pipeline.id}
                >
                  {running === pipeline.id ? (
                    <Spinner label="启动中" />
                  ) : (
                    <>
                      <Play size={15} /> 运行流水线
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="button ghost compact"
                  onClick={() => lastRun && onSelectRun(lastRun)}
                  disabled={!lastRun}
                >
                  查看最近日志
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <section className="panel runs-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">RUN HISTORY</p>
            <h3>运行历史</h3>
          </div>
          <span className="quiet-note">
            点击流水线记录查看步骤与证据；点击真实部署记录进入应用管理查看部署详情与审批
          </span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>交付对象</th>
                <th>状态</th>
                <th>环境</th>
                <th>版本</th>
                <th>类型 / 触发人</th>
                <th>耗时</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {historyRows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    还没有运行记录。运行流水线或在应用管理发起真实部署后，
                    记录会显示在这里。
                  </td>
                </tr>
              )}
              {historyRows.map((item) => (
                <tr
                  key={item.key}
                  onClick={() => {
                    if (item.run) onSelectRun(item.run);
                    else onNavigate("apps");
                  }}
                  className="clickable-row"
                >
                  <td>
                    <strong>
                      {item.name}
                      {item.kind === "deployment" && (
                        <em className="delivery-kind-tag">真实部署</em>
                      )}
                    </strong>
                    <small>{item.subtitle}</small>
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{ENVIRONMENT_LABELS[item.environment]}</td>
                  <td className="mono">{item.commitSha || "—"}</td>
                  <td>{item.actor}</td>
                  <td>{formatDuration(item.durationMs)}</td>
                  <td>{formatDate(item.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CloudPage({
  accounts,
  resources,
  search,
  onScan,
  onVerify,
  onSyncAll,
  onConnect,
  onEdit,
}: {
  accounts: CloudAccount[];
  resources: CloudResource[];
  search: string;
  onScan: (account: CloudAccount) => Promise<void>;
  onVerify: (account: CloudAccount) => Promise<void>;
  onSyncAll: () => Promise<void>;
  onConnect: () => void;
  onEdit: (account: CloudAccount) => void;
}) {
  const [scanning, setScanning] = useState("");
  const [syncingAll, setSyncingAll] = useState(false);
  const [verifying, setVerifying] = useState("");
  const [dnsChanges, setDnsChanges] = useState<DnsChangeRequest[]>([]);
  const [dnsLoading, setDnsLoading] = useState(true);
  const [dnsSubmitting, setDnsSubmitting] = useState(false);
  const [dnsBusy, setDnsBusy] = useState("");
  const [dnsError, setDnsError] = useState("");
  const [dnsNotice, setDnsNotice] = useState("");
  const [dnsForm, setDnsForm] = useState({
    accountId: "",
    domain: "example.com",
    targetIp: "203.0.113.10",
    httpPort: "8098",
    ttl: "600",
  });
  const [firewallTarget, setFirewallTarget] = useState<CloudResource | null>(null);
  const [firewallRules, setFirewallRules] = useState<
    Array<{
      protocol: string;
      port: string;
      cidrBlock: string;
      action: string;
      description: string;
    }>
  >([]);
  const [firewallPort, setFirewallPort] = useState("");
  const [firewallBusy, setFirewallBusy] = useState(false);
  const [firewallError, setFirewallError] = useState("");
  const [firewallNotice, setFirewallNotice] = useState("");
  const filteredResources = resources.filter(
    (resource) =>
      !search ||
      resource.name.toLowerCase().includes(search.toLowerCase()) ||
      resource.resourceType.toLowerCase().includes(search.toLowerCase()) ||
      resource.accountName.toLowerCase().includes(search.toLowerCase()),
  );
  const dnsAccounts = accounts.filter(
    (account) =>
      account.provider === "tencent" &&
      account.hasSecret,
  );
  const selectedDnsAccount = dnsAccounts.find(
    (account) => account.id === dnsForm.accountId,
  );
  const dnsPreview =
    dnsForm.domain.trim() && dnsForm.httpPort.trim()
      ? `http://${dnsForm.domain
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")}:${dnsForm.httpPort.trim()}`
      : "填写域名和端口后显示最终地址";

  useEffect(() => {
    void loadDnsChanges();
  }, []);

  useEffect(() => {
    if (dnsForm.accountId || dnsAccounts.length === 0) return;
    setDnsForm((current) => ({
      ...current,
      accountId: dnsAccounts[0]?.id ?? "",
    }));
  }, [accounts, dnsForm.accountId]);

  async function loadDnsChanges(quiet = false) {
    if (!quiet) setDnsLoading(true);
    try {
      const result = await api<{ changes: DnsChangeRequest[] }>(
        "/api/cloud/dns/changes?limit=50",
      );
      setDnsChanges(result.changes);
    } catch (error) {
      setDnsError(
        error instanceof Error ? error.message : "读取 DNS 变更记录失败。",
      );
    } finally {
      if (!quiet) setDnsLoading(false);
    }
  }

  async function createDnsChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDnsError("");
    setDnsNotice("");
    setDnsSubmitting(true);
    try {
      const result = await api<{ change: DnsChangeRequest }>(
        "/api/cloud/dns/changes",
        {
          method: "POST",
          body: JSON.stringify({
            accountId: dnsForm.accountId,
            domain: dnsForm.domain,
            subdomain: "@",
            targetIp: dnsForm.targetIp,
            httpPort: Number(dnsForm.httpPort),
            ttl: Number(dnsForm.ttl),
          }),
        },
      );
      setDnsChanges((current) => [
        result.change,
        ...current.filter((item) => item.id !== result.change.id),
      ]);
      setDnsNotice(
        result.change.preflight.ok
          ? "预检通过，变更单已创建并进入人工审批。尚未修改 DNS。"
          : "变更单已保存预检证据，但预检未通过，不允许审批或执行。",
      );
    } catch (error) {
      setDnsError(
        error instanceof Error ? error.message : "创建 DNS 变更单失败。",
      );
      await loadDnsChanges(true);
    } finally {
      setDnsSubmitting(false);
    }
  }

  async function runDnsAction(
    change: DnsChangeRequest,
    action: "approve" | "execute" | "reverify" | "cancel" | "rollback",
  ) {
    const prompts: Record<typeof action, string> = {
      approve: `确认批准 ${change.finalUrl} 的 DNS A 记录创建？`,
      execute: `即将向腾讯云 DNSPod 创建 A 记录：\n${change.domain} @ -> ${change.targetValue}\n\n最终地址：${change.finalUrl}\n\n确认执行？`,
      reverify: `将复核 RecordId ${change.recordId} 是否仍精确对应 ${change.domain} → ${change.targetValue}，并检查公网 DNS 与 ${change.finalUrl}。\n\n不会新建或修改 DNS 记录。继续？`,
      cancel: `确认取消变更单 ${change.id}？`,
      rollback:
        change.recordId
          ? `确认精确删除 RecordId ${change.recordId}？\n只会删除这一条完全匹配的记录。`
          : "当前变更单没有可安全回滚的 RecordId。",
    };
    if (action === "rollback" && !change.recordId) {
      setDnsError("当前变更单没有 RecordId，无法执行精确回滚。");
      return;
    }
    if (!window.confirm(prompts[action])) return;
    setDnsBusy(`${change.id}:${action}`);
    setDnsError("");
    setDnsNotice("");
    try {
      const body =
        action === "approve"
          ? { confirmation: "APPROVE", note: "在 AI DevOps 中人工审批" }
          : action === "execute"
            ? { confirmation: change.finalUrl }
            : action === "reverify"
              ? { confirmation: `REVERIFY ${change.recordId}` }
              : action === "rollback"
                ? { confirmation: `ROLLBACK ${change.recordId}` }
                : {};
      const result = await api<{ change: DnsChangeRequest }>(
        `/api/cloud/dns/changes/${encodeURIComponent(change.id)}/${action}`,
        { method: "POST", body: JSON.stringify(body) },
      );
      setDnsChanges((current) =>
        current.map((item) =>
          item.id === result.change.id ? result.change : item,
        ),
      );
      setDnsNotice(
        action === "approve"
          ? "审批完成。仍需再次人工点击“执行变更”。"
          : action === "execute"
            ? `执行与健康检查完成：${result.change.finalUrl}`
            : action === "reverify"
              ? `安全复核通过：RecordId ${result.change.recordId}，${result.change.finalUrl} 健康检查正常。`
              : action === "rollback"
                ? `已按 RecordId ${result.change.recordId} 精确回滚。`
                : "变更单已取消。",
      );
    } catch (error) {
      setDnsError(
        error instanceof Error ? error.message : "DNS 操作失败，请查看记录。",
      );
      await loadDnsChanges(true);
    } finally {
      setDnsBusy("");
    }
  }

  async function scan(account: CloudAccount) {
    setScanning(account.id);
    try {
      await onScan(account);
    } finally {
      setScanning("");
    }
  }

  async function verify(account: CloudAccount) {
    setVerifying(account.id);
    try {
      await onVerify(account);
    } finally {
      setVerifying("");
    }
  }

  async function openFirewall(resource: CloudResource) {
    setFirewallTarget(resource);
    setFirewallRules([]);
    setFirewallPort("");
    setFirewallError("");
    setFirewallNotice("");
    try {
      const result = await api<{ rules: typeof firewallRules }>(
        `/api/cloud/lighthouse/${encodeURIComponent(resource.id)}/firewall?accountId=${encodeURIComponent(resource.accountId)}&region=${encodeURIComponent(resource.region)}&publicIp=${encodeURIComponent(String(resource.attributes.publicIp ?? ""))}`,
      );
      setFirewallRules(result.rules);
    } catch (error) {
      setFirewallError(error instanceof Error ? error.message : "读取防火墙规则失败。");
    }
  }

  async function submitFirewall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!firewallTarget) return;
    const port = Number(firewallPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setFirewallError("请输入 1-65535 之间的端口号。");
      return;
    }
    setFirewallBusy(true);
    setFirewallError("");
    try {
      const result = await api<{ added: boolean; rules: typeof firewallRules }>(
        `/api/cloud/lighthouse/${encodeURIComponent(firewallTarget.id)}/firewall/open`,
        {
          method: "POST",
          body: JSON.stringify({
            accountId: firewallTarget.accountId,
            region: firewallTarget.region,
            publicIp: String(firewallTarget.attributes.publicIp ?? ""),
            port,
            description: `AI DevOps 开放 TCP ${port}`,
          }),
        },
      );
      setFirewallRules(result.rules);
      setFirewallPort("");
      setFirewallNotice(
        result.added ? `已开放 TCP ${port}` : `TCP ${port} 已在防火墙规则中`,
      );
    } catch (error) {
      setFirewallError(error instanceof Error ? error.message : "开放端口失败。");
    } finally {
      setFirewallBusy(false);
    }
  }

  async function syncAll() {
    setSyncingAll(true);
    try {
      await onSyncAll();
    } finally {
      setSyncingAll(false);
    }
  }

  return (
    <div className="content-page">
      <section className="demo-notice">
        <Database size={18} />
        <div>
          <strong>腾讯云、阿里云支持主账号或子账号 API 密钥登记</strong>
          <span>
            登录密码不能调用云 OpenAPI；请填写 AccessKey/SecretKey。登记后验证凭据并刷新资源。
          </span>
        </div>
        <button type="button" className="button secondary compact" onClick={onConnect}>
          <Plus size={15} /> 登记云账号
        </button>
      </section>

      <div className="cloud-account-grid">
        {accounts.map((account) => (
          <article className="cloud-account-card" key={account.id}>
            <div className="cloud-card-head">
              <ProviderMark provider={account.provider} size="large" />
              <div>
                <h3>{account.name}</h3>
                <span>
                  {account.region}
                  {account.accountType === "sub" && account.ownerId
                    ? ` · ${
                        (
                          SUB_ACCOUNT_LABELS[account.provider] ??
                          SUB_ACCOUNT_LABELS.tencent
                        ).ownerLabel
                      } ${account.ownerId}`
                    : ""}
                </span>
              </div>
              <span
                className={classNames(
                  "account-type-badge",
                  account.accountType === "sub" && "sub",
                )}
              >
                {account.accountType === "sub" ? "子账号" : "主账号"}
              </span>
              <StatusBadge status={account.status} />
            </div>
            {account.statusMessage && (
              <p className="cloud-account-status-line">
                {account.statusMessage}
              </p>
            )}
            <div className="cloud-card-metrics">
              <div>
                <small>资源</small>
                <strong>{account.resourceCount}</strong>
              </div>
              <div>
                <small>本月消费</small>
                <strong>¥{account.monthlyCost.toLocaleString("zh-CN")}</strong>
              </div>
              <div>
                <small>最近扫描</small>
                <strong>{timeAgo(account.lastScannedAt)}</strong>
              </div>
            </div>
            <div className="cloud-card-footer">
              <span>
                <span className="live-dot" />
                {account.provider === "huawei"
                  ? "连接器未接入"
                  : "只读查询 + 审批写操作"}
              </span>
              <div className="cloud-card-footer-actions">
                {account.hasSecret && account.provider !== "huawei" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void verify(account)}
                    disabled={verifying === account.id || scanning === account.id}
                  >
                    {verifying === account.id ? (
                      <Spinner label="验证中" />
                    ) : (
                      <>
                        <ShieldCheck size={13} /> 验证凭据
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onEdit(account)}
                >
                  <Pencil size={13} /> 编辑
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => scan(account)}
                  disabled={scanning === account.id}
                >
                  {scanning === account.id ? (
                    <Spinner label="扫描中" />
                  ) : (
                    <>
                      <RefreshCw size={14} /> 刷新索引
                    </>
                  )}
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>

      <section className="panel dns-change-panel">
        <div className="panel-heading dns-panel-heading">
          <div>
            <p className="eyebrow">DOMAIN &amp; DNS CHANGE CONTROL</p>
            <h3>域名绑定与 DNS 变更</h3>
            <p className="dns-heading-copy">
              DNS 只保存 IPv4 地址；访问端口保留在最终 URL 中。全流程包含只读预检、人工审批、执行与回滚。
            </p>
          </div>
          <span className="dns-protection-badge">
            <ShieldCheck size={14} /> 精确记录级保护
          </span>
        </div>

        <div className="dns-bind-layout">
          <form className="dns-bind-form" onSubmit={createDnsChange}>
            <div className="dns-form-head">
              <div>
                <strong>新建绑定申请</strong>
                <small>创建时只读取云上和站点状态，不会立即修改 DNS。</small>
              </div>
              <span className="dns-record-type">A 记录</span>
            </div>

            {dnsAccounts.length === 0 ? (
              <div className="dns-account-empty">
                <TriangleAlert size={17} />
                <div>
                  <strong>没有可用的腾讯云子账号</strong>
                  <span>请先登记并验证具备 DNSPod 权限的腾讯云子账号。</span>
                </div>
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={onConnect}
                >
                  登记账号
                </button>
              </div>
            ) : (
              <>
                <div className="dns-form-grid">
                  <label>
                    腾讯云子账号
                    <select
                      value={dnsForm.accountId}
                      onChange={(event) =>
                        setDnsForm((current) => ({
                          ...current,
                          accountId: event.target.value,
                        }))
                      }
                      required
                    >
                      {dnsAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} · {account.region}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    根域名
                    <input
                      type="text"
                      inputMode="url"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={dnsForm.domain}
                      onChange={(event) =>
                        setDnsForm((current) => ({
                          ...current,
                          domain: event.target.value,
                        }))
                      }
                      placeholder="example.com"
                      required
                    />
                    <small>仅填写域名，不包含 http:// 或端口。</small>
                  </label>
                  <label>
                    目标公网 IPv4
                    <input
                      type="text"
                      inputMode="decimal"
                      value={dnsForm.targetIp}
                      onChange={(event) =>
                        setDnsForm((current) => ({
                          ...current,
                          targetIp: event.target.value,
                        }))
                      }
                      placeholder="例如 203.0.113.10"
                      required
                    />
                    <small>支持直接输入服务器公网 IP，并会校验是否为公网地址。</small>
                  </label>
                  <label>
                    HTTP 端口
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={dnsForm.httpPort}
                      onChange={(event) =>
                        setDnsForm((current) => ({
                          ...current,
                          httpPort: event.target.value,
                        }))
                      }
                      required
                    />
                    <small>端口不会写入 DNS A 记录，但会出现在最终访问地址。</small>
                  </label>
                  <label>
                    TTL（秒）
                    <select
                      value={dnsForm.ttl}
                      onChange={(event) =>
                        setDnsForm((current) => ({
                          ...current,
                          ttl: event.target.value,
                        }))
                      }
                    >
                      <option value="600">600 · 10 分钟</option>
                      <option value="3600">3600 · 1 小时</option>
                      <option value="86400">86400 · 24 小时</option>
                    </select>
                  </label>
                </div>

                <div className="dns-url-preview">
                  <Globe size={17} />
                  <div>
                    <small>最终访问地址</small>
                    <strong>{dnsPreview}</strong>
                  </div>
                </div>

                <div className="dns-safety-list">
                  <span>
                    <Check size={13} /> 不覆盖现有 A/CNAME
                  </span>
                  <span>
                    <Check size={13} /> 不自动创建 www
                  </span>
                  <span>
                    <Check size={13} /> 回滚仅删除精确 RecordId
                  </span>
                </div>

                <button
                  type="submit"
                  className="button primary dns-submit"
                  disabled={dnsSubmitting || !selectedDnsAccount}
                >
                  {dnsSubmitting ? (
                    <Spinner label="正在预检" />
                  ) : (
                    <>
                      <ShieldCheck size={15} /> 预检并创建变更单
                    </>
                  )}
                </button>
              </>
            )}
          </form>

          <aside className="dns-process-card">
            <p className="eyebrow">CONTROLLED WORKFLOW</p>
            <h4>变更如何生效</h4>
            <ol className="dns-process-steps">
              <li>
                <span>1</span>
                <div>
                  <strong>申请人与预检</strong>
                  <small>确认域名归属、冲突、源站和 Host 响应。</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>人工审批</strong>
                  <small>审批前自动重新预检，避免状态过期。</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>执行与健康检查</strong>
                  <small>写入 A 记录后验证公网解析和最终 URL。</small>
                </div>
              </li>
              <li>
                <span>4</span>
                <div>
                  <strong>可追溯回滚</strong>
                  <small>保存腾讯云 RequestId 与 RecordId，可精确删除。</small>
                </div>
              </li>
            </ol>
            <p className="dns-process-note">
              当前平台只有一个管理员账号；本次操作会记录自我审批标记，后续应启用双人审批。
            </p>
          </aside>
        </div>

        {dnsError && (
          <div className="form-error dns-feedback">
            <TriangleAlert size={16} />
            {dnsError}
          </div>
        )}
        {dnsNotice && (
          <div className="dns-success dns-feedback">
            <CheckCircle2 size={16} />
            {dnsNotice}
          </div>
        )}

        <div className="dns-history-head">
          <div>
            <strong>变更历史与证据</strong>
            <small>申请、审批、执行、健康检查和回滚记录均保存在平台。</small>
          </div>
          <button
            type="button"
            className="button ghost compact"
            onClick={() => void loadDnsChanges()}
            disabled={dnsLoading}
          >
            <RefreshCw size={14} className={dnsLoading ? "spin" : undefined} />
            刷新记录
          </button>
        </div>

        {dnsLoading && dnsChanges.length === 0 ? (
          <div className="dns-history-empty">
            <Spinner label="正在读取变更记录" />
          </div>
        ) : dnsChanges.length === 0 ? (
          <div className="dns-history-empty">
            <Network size={22} />
            <strong>还没有 DNS 变更记录</strong>
            <span>完成上方申请后，审批与执行证据会显示在这里。</span>
          </div>
        ) : (
          <div className="dns-history-list">
            {dnsChanges.map((change) => {
              const busyPrefix = `${change.id}:`;
              const isBusy = dnsBusy.startsWith(busyPrefix);
              const checks = [
                ...(change.preflight.checks ?? []),
                ...(change.execution.checks ?? []),
                ...(change.verification.checks ?? []),
              ].filter(
                (check, index, all) =>
                  all.findIndex(
                    (candidate) =>
                      candidate.key === check.key &&
                      candidate.detail === check.detail,
                  ) === index,
              );
              return (
                <article className="dns-history-card" key={change.id}>
                  <div className="dns-history-top">
                    <div className="dns-history-title">
                      <span className="dns-domain-mark">
                        <Globe size={16} />
                      </span>
                      <div>
                        <strong>
                          {change.domain}{" "}
                          <span className="dns-host-chip">
                            {change.subdomain}
                          </span>
                        </strong>
                        <small>
                          A → {change.targetValue} · TTL {change.ttl}s
                        </small>
                      </div>
                    </div>
                    <StatusBadge status={change.status} />
                  </div>

                  <a
                    className="dns-final-url"
                    href={change.finalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>{change.finalUrl}</span>
                    <ArrowUpRight size={14} />
                  </a>

                  <div className="dns-meta-grid">
                    <div>
                      <small>申请人</small>
                      <strong>{change.requestedBy}</strong>
                      <span>{formatDate(change.createdAt)}</span>
                    </div>
                    <div>
                      <small>审批人</small>
                      <strong>{change.approvedBy || "等待审批"}</strong>
                      <span>{formatDate(change.approvedAt)}</span>
                    </div>
                    <div>
                      <small>变更单</small>
                      <strong className="mono">{change.id}</strong>
                      <span>云账号 {change.accountName}</span>
                    </div>
                  </div>

                  {(change.recordId ||
                    change.createRequestId ||
                    change.deleteRequestId) && (
                    <dl className="dns-evidence-grid">
                      {change.recordId && (
                        <div>
                          <dt>腾讯云 RecordId</dt>
                          <dd className="mono">{change.recordId}</dd>
                        </div>
                      )}
                      {change.createRequestId && (
                        <div>
                          <dt>创建 RequestId</dt>
                          <dd className="mono">{change.createRequestId}</dd>
                        </div>
                      )}
                      {change.deleteRequestId && (
                        <div>
                          <dt>回滚 RequestId</dt>
                          <dd className="mono">{change.deleteRequestId}</dd>
                        </div>
                      )}
                    </dl>
                  )}

                  {checks.length > 0 && (
                    <details className="dns-evidence-details">
                      <summary>
                        <ListChecks size={14} />
                        预检、DNS 与 HTTP 健康证据（{checks.length}）
                      </summary>
                      <DnsCheckList checks={checks} />
                    </details>
                  )}

                  {change.error && (
                    <div className="dns-inline-error">
                      <TriangleAlert size={14} />
                      <span>{change.error}</span>
                    </div>
                  )}

                  <div className="dns-card-actions">
                    <span>
                      最近更新 {formatDate(change.updatedAt)}
                      {change.verification.resolvedIps?.length
                        ? ` · 解析 ${change.verification.resolvedIps.join(", ")}`
                        : ""}
                    </span>
                    <div>
                      {change.status === "waiting_approval" && (
                        <button
                          type="button"
                          className="button primary compact"
                          disabled={isBusy}
                          onClick={() => void runDnsAction(change, "approve")}
                        >
                          {dnsBusy === `${change.id}:approve` ? (
                            <Spinner label="审批中" />
                          ) : (
                            <>
                              <ShieldCheck size={14} /> 审批
                            </>
                          )}
                        </button>
                      )}
                      {change.status === "approved" && (
                        <button
                          type="button"
                          className="button primary compact"
                          disabled={isBusy}
                          onClick={() => void runDnsAction(change, "execute")}
                        >
                          {dnsBusy === `${change.id}:execute` ? (
                            <Spinner label="执行中" />
                          ) : (
                            <>
                              <Play size={14} /> 执行变更
                            </>
                          )}
                        </button>
                      )}
                      {change.status === "failed" && change.recordId && (
                        <button
                          type="button"
                          className="button primary compact"
                          disabled={isBusy}
                          onClick={() => void runDnsAction(change, "reverify")}
                        >
                          {dnsBusy === `${change.id}:reverify` ? (
                            <Spinner label="复核中" />
                          ) : (
                            <>
                              <RefreshCw size={14} /> 重新验证
                            </>
                          )}
                        </button>
                      )}
                      {["waiting_approval", "approved"].includes(
                        change.status,
                      ) && (
                        <button
                          type="button"
                          className="button ghost compact"
                          disabled={isBusy}
                          onClick={() => void runDnsAction(change, "cancel")}
                        >
                          <X size={14} /> 取消
                        </button>
                      )}
                      {["succeeded", "failed"].includes(change.status) &&
                        change.recordId && (
                          <button
                            type="button"
                            className="button danger compact"
                            disabled={isBusy}
                            onClick={() =>
                              void runDnsAction(change, "rollback")
                            }
                          >
                            {dnsBusy === `${change.id}:rollback` ? (
                              <Spinner label="回滚中" />
                            ) : (
                              <>
                                <RotateCcw size={14} /> 精确回滚
                              </>
                            )}
                          </button>
                        )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel resources-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">UNIFIED INVENTORY</p>
            <h3>统一资源视图</h3>
          </div>
          <div className="panel-heading-actions">
            <button
              type="button"
              className="button secondary compact"
              onClick={() => void syncAll()}
              disabled={syncingAll}
              aria-busy={syncingAll}
              title="扫描全部已登记云账号：网页、域名、DNS、证书与主机资源"
            >
              {syncingAll ? (
                <Spinner label="同步中" />
              ) : (
                <>
                  <RefreshCw size={14} /> 同步云资源
                </>
              )}
            </button>
            <span className="quiet-note">{filteredResources.length} 个资源</span>
          </div>
        </div>
        {filteredResources.length === 0 && (
          <p className="empty-inline">
            还没有同步到资源。请先在云账号卡片上点击“验证凭据”或“刷新索引”。
          </p>
        )}
        <div className="resource-categories">
          {(() => {
            const grouped = new Map<string, CloudResource[]>();
            for (const resource of filteredResources) {
              const list = grouped.get(resource.resourceType) ?? [];
              list.push(resource);
              grouped.set(resource.resourceType, list);
            }
            const entries = Array.from(grouped.entries());
            const orderOf = (type: string) => {
              const index = RESOURCE_TYPE_ORDER.indexOf(type);
              return index >= 0 ? index : RESOURCE_TYPE_ORDER.length;
            };
            entries.sort((left, right) => orderOf(left[0]) - orderOf(right[0]));
            return entries.map(([type, items]) => {
              const Icon = resourceTypeIcon(type);
              const healthy = items.filter(
                (item) => item.status === "healthy",
              ).length;
              return (
                <section className="resource-category" key={type}>
                  <header className="resource-category-head">
                    <span className="resource-type-icon">
                      <Icon size={16} />
                    </span>
                    <div>
                      <strong>
                        {RESOURCE_TYPE_LABELS[type] ?? type}
                      </strong>
                      <small>
                        {items.length} 个 · 健康 {healthy}
                      </small>
                    </div>
                  </header>
                  <div className="resource-card-grid">
                    {items.map((resource) => (
                      <article className="resource-card" key={resource.id}>
                        <div className="resource-card-head">
                          <strong title={resource.name}>{resource.name}</strong>
                          <StatusBadge status={resource.status} />
                        </div>
                        <p className="resource-card-meta">
                          {resource.region || "全局"} · {resource.accountName}
                        </p>
                        <div className="resource-attrs">
                          {resourceAttributes(resource).map((attribute) => (
                            <span key={attribute}>{attribute}</span>
                          ))}
                          {resourceAttributes(resource).length === 0 && (
                            <span>最近发现 {timeAgo(resource.lastSeenAt)}</span>
                          )}
                        </div>
                        {(resource.metrics ||
                          ["CVM", "ECS", "Lighthouse"].includes(
                            resource.resourceType,
                          )) && (
                          <div
                            className={classNames(
                              "resource-metrics",
                              resource.metrics?.status ?? "unavailable",
                            )}
                          >
                            <span>
                              CPU{" "}
                              {typeof resource.metrics?.cpuPercent === "number"
                                ? `${resource.metrics.cpuPercent}%`
                                : "暂无数据"}
                            </span>
                            <span>
                              内存{" "}
                              {typeof resource.metrics?.memoryPercent ===
                              "number"
                                ? `${resource.metrics.memoryPercent}%`
                                : "暂无数据"}
                            </span>
                            <span>
                              指标{" "}
                              {resource.metrics?.status === "ok"
                                ? "正常"
                                : resource.metrics?.status === "partial"
                                  ? "部分可用"
                                  : "不可用"}
                            </span>
                            <small>
                              采集{" "}
                              {timeAgo(
                                resource.metrics?.updatedAt ??
                                  resource.metricsUpdatedAt,
                              )}
                            </small>
                          </div>
                        )}
                        {resource.resourceType === "Lighthouse" && (
                          <div className="row-actions" style={{ marginTop: 10 }}>
                            <button
                              type="button"
                              className="button ghost compact"
                              onClick={() => void openFirewall(resource)}
                            >
                              <LockKeyhole size={13} /> 防火墙
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              );
            });
          })()}
        </div>
      </section>

      {firewallTarget && (
        <Modal
          title={`轻量服务器防火墙：${firewallTarget.name}`}
          subtitle="仅开放业务必需的 TCP 端口；每次操作都会写入审计日志。"
          onClose={() => setFirewallTarget(null)}
        >
          <div className="modal-form">
            {firewallError && (
              <div className="form-error">
                <TriangleAlert size={16} />
                {firewallError}
              </div>
            )}
            {firewallNotice && (
              <p className="field-hint">{firewallNotice}</p>
            )}
            <div className="firewall-rule-list">
              {firewallRules.length === 0 ? (
                <p className="field-hint">正在读取防火墙规则，或暂无规则。</p>
              ) : (
                firewallRules.map((rule, index) => (
                  <div key={`${rule.protocol}-${rule.port}-${index}`}>
                    <strong>
                      {rule.protocol} {rule.port}
                    </strong>
                    <span>
                      {rule.action} · {rule.cidrBlock}
                    </span>
                    {rule.description && <small>{rule.description}</small>}
                  </div>
                ))
              )}
            </div>
            <form className="firewall-open-form" onSubmit={submitFirewall}>
              <label>
                开放 TCP 端口
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={firewallPort}
                  onChange={(event) => setFirewallPort(event.target.value)}
                  placeholder="例如 8098"
                  required
                />
              </label>
              <button type="submit" className="button primary" disabled={firewallBusy}>
                {firewallBusy ? <Spinner label="开放中" /> : "开放端口"}
              </button>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode?: "local-analysis" | "model";
  proposals?: AiResponse["proposals"];
}

function CopilotPage({
  settings,
  recentRuns,
  onSelectRun,
  onError,
}: {
  settings: SettingsStatus | null;
  recentRuns: PipelineRun[];
  onSelectRun: (run: PipelineRun) => void;
  onError: (error: unknown) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "我是 AI DevOps Copilot。我会先读取平台事实，再给出分析与行动提案。任何生产写操作都需要显式审批，我不会自动执行。",
      mode: "local-analysis",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const failedRun = recentRuns.find((run) => run.status === "failed");
  const quickPrompts = [
    "分析最近一次流水线失败",
    "目前有哪些发布等待审批？",
    "检查多云资源与成本风险",
  ];

  async function sendMessage(content: string) {
    const text = content.trim();
    if (!text || sending) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setSending(true);
    try {
      const response = await api<AiResponse>("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.message,
          mode: response.mode,
          proposals: response.proposals,
        },
      ]);
    } catch (error) {
      onError(error);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="copilot-layout">
      <section className="copilot-chat panel">
        <div className="chat-header">
          <div className="ai-avatar">
            <Bot size={22} />
          </div>
          <div>
            <h3>AI DevOps Copilot</h3>
            <span>
              <span className="live-dot" />
              {settings?.llmConfigured ? "模型网关已连接" : "本地证据分析模式"}
            </span>
          </div>
          <span className="safety-pill">
            <ShieldCheck size={13} /> 只读默认
          </span>
        </div>
        <div className="chat-messages">
          {messages.map((message) => (
            <div
              className={classNames("chat-message", message.role)}
              key={message.id}
            >
              {message.role === "assistant" && (
                <span className="message-avatar">
                  <Sparkles size={15} />
                </span>
              )}
              <div className="message-body">
                <div className="message-meta">
                  <strong>
                    {message.role === "assistant" ? "Copilot" : "你"}
                  </strong>
                  {message.mode && (
                    <span>
                      {message.mode === "model" ? "模型分析" : "本地证据分析"}
                    </span>
                  )}
                </div>
                <div className="message-content">
                  {message.content.split("\n").map((line, index) => (
                    <p key={`${message.id}-${index}`}>{line || "\u00a0"}</p>
                  ))}
                </div>
                {message.proposals && message.proposals.length > 0 && (
                  <div className="proposal-list">
                    {message.proposals.map((proposal) => (
                      <div className="proposal-card" key={proposal.id}>
                        <div>
                          <Workflow size={16} />
                          <strong>{proposal.title}</strong>
                        </div>
                        <span className={classNames("risk-chip", proposal.risk)}>
                          {proposal.risk === "high"
                            ? "高风险"
                            : proposal.risk === "medium"
                              ? "中风险"
                              : "低风险"}
                          {proposal.requiresApproval && " · 需审批"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {message.role === "assistant" &&
                  message.id !== "welcome" &&
                  failedRun && (
                    <button
                      type="button"
                      className="evidence-link"
                      onClick={() => onSelectRun(failedRun)}
                    >
                      <Terminal size={14} /> 查看相关运行证据
                    </button>
                  )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="chat-message assistant">
              <span className="message-avatar">
                <Sparkles size={15} />
              </span>
              <div className="typing-indicator">
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
        </div>
        <div className="quick-prompts">
          {quickPrompts.map((prompt) => (
            <button
              type="button"
              key={prompt}
              onClick={() => void sendMessage(prompt)}
              disabled={sending}
            >
              {prompt}
            </button>
          ))}
        </div>
        <form
          className="chat-input"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(input);
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="询问发布状态、故障原因或云资源风险…"
            rows={1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage(input);
              }
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            aria-label="发送消息"
          >
            <Send size={17} />
          </button>
        </form>
        <p className="chat-disclaimer">
          AI 建议可能不完整。生产行动需通过审批并由受控 Runner 执行。
        </p>
      </section>

      <aside className="copilot-context">
        <article className="panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">CONTEXT</p>
              <h3>当前证据源</h3>
            </div>
          </div>
          <div className="context-list">
            <div>
              <GitCommitHorizontal size={16} />
              <span>
                <strong>流水线状态</strong>
                <small>{recentRuns.length} 次近期运行</small>
              </span>
              <CheckCircle2 size={15} />
            </div>
            <div>
              <Cloud size={16} />
              <span>
                <strong>云资源索引</strong>
                <small>真实云同步数据</small>
              </span>
              <CheckCircle2 size={15} />
            </div>
            <div>
              <Activity size={16} />
              <span>
                <strong>监控与日志</strong>
                <small>Phase 2 接入</small>
              </span>
              <Clock3 size={15} />
            </div>
          </div>
        </article>
        <article className="guardrail-card">
          <ShieldCheck size={20} />
          <h3>行动安全边界</h3>
          <ul>
            <li>模型只能调用白名单只读工具</li>
            <li>生产变更必须生成审批单</li>
            <li>执行后自动验证并保留证据</li>
          </ul>
        </article>
      </aside>
    </div>
  );
}

const AUDIT_PAGE_SIZE = 10;

function AuditPage({
  events,
  search,
}: {
  events: AuditEvent[];
  search: string;
}) {
  const [pageIndex, setPageIndex] = useState(1);
  const filtered = events.filter(
    (event) =>
      !search ||
      event.actor.toLowerCase().includes(search.toLowerCase()) ||
      event.action.toLowerCase().includes(search.toLowerCase()) ||
      event.target.toLowerCase().includes(search.toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
  const safePage = Math.min(pageIndex, pageCount);
  const pageRows = filtered.slice(
    (safePage - 1) * AUDIT_PAGE_SIZE,
    safePage * AUDIT_PAGE_SIZE,
  );

  useEffect(() => {
    setPageIndex(1);
  }, [search, events.length]);

  return (
    <div className="content-page">
      <section className="audit-summary">
        <div>
          <ShieldCheck size={20} />
          <span>
            <strong>审计链保持完整</strong>
            <small>登录、仓库同步、流水线与 AI 查询均写入记录</small>
          </span>
        </div>
        <span className="hash-chip mono">append-only · local SQLite</span>
      </section>
      <section className="panel audit-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AUDIT TRAIL</p>
            <h3>操作时间线</h3>
          </div>
          <span className="quiet-note">{filtered.length} 条记录</span>
        </div>
        <div className="audit-list">
          {pageRows.map((event) => (
            <div className="audit-row" key={event.id}>
              <span
                className={classNames(
                  "audit-icon",
                  event.result === "failed" && "failed",
                )}
              >
                {event.result === "failed" ? (
                  <XCircle size={16} />
                ) : (
                  <Check size={16} />
                )}
              </span>
              <div className="audit-main">
                <div>
                  <strong>{event.action}</strong>
                  <span>{event.target}</span>
                </div>
                <small>
                  执行人 {event.actor} · {formatDate(event.createdAt)}
                </small>
              </div>
              <span
                className={classNames(
                  "audit-result",
                  event.result === "failed" && "failed",
                )}
              >
                {event.result === "failed" ? "失败" : "成功"}
              </span>
              <span className="mono audit-id">{event.id.slice(0, 8)}</span>
            </div>
          ))}
        </div>
        {filtered.length > AUDIT_PAGE_SIZE && (
          <PanelPagination
            total={filtered.length}
            page={safePage}
            pageCount={pageCount}
            onPage={setPageIndex}
          />
        )}
      </section>
    </div>
  );
}

const BEGINNER_PROMPTS = [
  {
    id: "discover",
    category: "第一次接入",
    title: "让智能体先认识项目",
    description: "先检查技术栈、运行方式和部署所需条件，不要求你操作终端。",
    prompt:
      "请带我完成这个项目接入 AI DevOps 的第一步。请直接检查当前项目，告诉我它用什么技术、需要哪些发布环境、是否能部署到腾讯云、阿里云或华为云。不要让我执行 Git 或终端命令；凡是需要我操作的地方，请用小白能懂的步骤说明。先只做检查，不要修改生产配置。",
  },
  {
    id: "feature",
    category: "开发功能",
    title: "开发一个新功能",
    description: "智能体负责代码、测试、分支和变更说明，你只确认需求。",
    prompt:
      "请直接在当前项目开发这个功能：【用一句话描述你需要的功能】。请自动创建功能分支、完成代码修改和测试，并告诉我改了什么、有什么风险。不要直接修改受保护的 main 分支，也不要让我手动使用 Git。完成后请准备一个可以在 AI DevOps 中查看和审批的发布版本。",
  },
  {
    id: "deploy",
    category: "云端部署",
    title: "部署到指定云",
    description: "用于真实云连接完成后的发布；缺少授权时必须停下来提示。",
    prompt:
      "请把当前已验证的版本部署到【腾讯云 / 阿里云 / 华为云】的【开发 / 预发 / 生产】环境。请先检查 AI DevOps 的云账号连接、权限、健康阈值和回滚方案；如果缺少授权，请停下来告诉我需要配置哪一项，不要让我在聊天里发送密码、AK 或 SK。生产部署必须等待我在浏览器里批准。",
  },
  {
    id: "incident",
    category: "故障运维",
    title: "检查并修复线上问题",
    description: "智能体先查证据，所有重启、扩容、回滚等写操作都要你批准。",
    prompt:
      "请检查【服务名称】最近一次故障：先关联最新发布、日志、指标和云资源状态，用大白话告诉我发生了什么、证据是什么、你有多确定。只进行只读排查；如果需要重启、扩容、改配置或回滚，请先生成变更提案、风险和回滚步骤，由平台管理员在 AI DevOps 中审批并执行，不要声称你能直接执行云变更。",
  },
  {
    id: "explain",
    category: "随时提问",
    title: "让智能体解释现状",
    description: "不懂页面、报错或下一步时，直接把这句发给智能体。",
    prompt:
      "请用第一次接触 DevOps 的人能听懂的方式解释当前情况。不要使用未解释的专业术语，不要假设我会 Git 或云控制台。请告诉我：现在发生了什么、是否影响用户、我唯一需要做的决定是什么，以及如果不操作会有什么后果。",
  },
] as const;

const AGENT_BRIDGE_PROMPT = `你正在接入 AI DevOps。当前只做只读接入检查，不要调用 ai_devops_deliver，也不要自动修改代码、提交、推送 Git、构建或部署。
1. 调用 ai_devops_health，确认 AI DevOps MCP 工具可用；
2. 只读检查当前项目的技术栈、Git 远程仓库、当前分支和未提交改动；如果用户已经提供仓库或应用名称，再调用 ai_devops_status 查看已有交付记录；需要云资源时调用 ai_devops_resources 查看已同步资源与指标；
3. 用大白话报告连接结果、项目现状和缺失配置。用户没有明确布置开发或交付任务时，到此停止并等待指令；
4. 只有用户明确要求开发并交付，且代码修改和测试都已完成时，才在功能分支提交并推送 Git。没有代码改动、测试未通过、仓库未登记或用户没有明确要求交付时，不得推送，也不要用“推送最新代码”凑一次交付；
5. 用户明确要求交付后才调用 ai_devops_deliver：repositoryUrl 填已登记的仓库 HTTPS 地址（或 repositoryName 填平台登记名称）、appName 填应用名称、environment 填 staging（开发/预发自动部署）或 production（需要管理员在 AI DevOps 里审批）；
6. 用 ai_devops_status 查询当前智能体自己的交付进度，把最终状态、端口和访问地址用大白话告诉用户。

权限边界：你只能提交交付、查询自己的部署、查询已同步资源与指标；不能审批、不能执行云变更、不能读取云密钥、不能修改平台设置。不要向用户索要任何账号密码或云密钥；不要声称已经推送、构建、部署或上线，除非命令或工具返回成功证据。`;

function GuidePage({
  settings,
  onNavigate,
}: {
  settings: SettingsStatus | null;
  onNavigate: (page: PageId) => void;
}) {
  const [copiedId, setCopiedId] = useState("");

  async function copyPrompt(id: string, prompt: string) {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = prompt;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(""), 2_000);
  }

  return (
    <div className="content-page guide-page">
      <section className="guide-hero">
        <div className="guide-hero-copy">
          <p className="eyebrow light">ZERO-CODE START</p>
          <h1>
            你不用学 Git，
            <br />
            也能完成软件开发和上线。
          </h1>
          <p>
            你用中文告诉智能体要做什么，智能体负责写代码和整理版本，
            AI DevOps 负责记录、发布和运维。遇到高风险操作时，
            平台只让你做一次清楚的“批准”或“拒绝”。
          </p>
          <div className="guide-hero-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => onNavigate("overview")}
            >
              回到总览 <ChevronRight size={16} />
            </button>
            <button
              type="button"
              className="button secondary-on-dark"
              onClick={() => onNavigate("copilot")}
            >
              <Bot size={16} /> 打开 AI Copilot
            </button>
          </div>
        </div>
        <div className="guide-role-visual" aria-label="三方协作关系">
          <div className="guide-role-node you">
            <span>你</span>
            <strong>提目标</strong>
          </div>
          <i />
          <div className="guide-role-node agent">
            <Sparkles size={18} />
            <strong>智能体开发</strong>
          </div>
          <i />
          <div className="guide-role-node platform">
            <ShieldCheck size={18} />
            <strong>平台交付</strong>
          </div>
        </div>
      </section>

      <section className="guide-role-grid">
        <article className="guide-role-card">
          <span className="guide-role-number">01</span>
          <div className="guide-role-icon user">
            <MousePointerClick size={19} />
          </div>
          <h3>你负责什么</h3>
          <p>说清楚你想要的结果；在平台上查看进度；批准真正的生产上线。</p>
          <strong>不需要记命令，不需要懂 Git。</strong>
        </article>
        <article className="guide-role-card">
          <span className="guide-role-number">02</span>
          <div className="guide-role-icon agent">
            <Code2 size={19} />
          </div>
          <h3>Codex / WorkBuddy 负责什么</h3>
          <p>理解需求、改代码、运行测试、解释错误，并准备可发布的版本。</p>
          <strong>在功能分支工作，不直接改生产。</strong>
        </article>
        <article className="guide-role-card">
          <span className="guide-role-number">03</span>
          <div className="guide-role-icon platform">
            <Workflow size={19} />
          </div>
          <h3>AI DevOps 负责什么</h3>
          <p>保存版本记录、运行质量检查、执行云端部署和运维，并留下审计证据。</p>
          <strong>高风险动作必须经过门户审批。</strong>
        </article>
      </section>

      <section className="guide-current-state">
        <div className="guide-state-icon">
          <TriangleAlert size={20} />
        </div>
        <div>
          <strong>
            云、代码、镜像、数据库、服务器已全部连通
          </strong>
          <p>
            腾讯云子账号验证与全资源同步、Gitee 私有仓库真实同步、
            镜像构建并推送腾讯云 TCR（已实测）、MySQL 数据库管理与备份、
            云服务器 SSH 终端与环境检测均已可用；凭据统一加密存入本机凭据库。
            真实发布、审批、健康检查、版本中心、人工回滚和自动回滚均已接入同一部署记录。
            平台不会把未实现的能力说成已经上线。
          </p>
        </div>
        <span className={classNames("guide-mode-chip", settings?.demoMode && "demo")}>
          {settings?.demoMode ? "演示模式" : "真实运行模式"}
        </span>
      </section>

      <section className="guide-main-grid">
        <article className="panel guide-steps-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">FIRST TIME</p>
              <h3>第一次使用，只做这五步</h3>
            </div>
            <span className="quiet-note">大约 3 分钟</span>
          </div>
          <div className="beginner-steps">
            <div>
              <span>1</span>
              <div>
                <strong>双击启动文件</strong>
                <p>打开项目文件夹，双击 `start-ai-devops.cmd`，浏览器会自动打开。</p>
              </div>
            </div>
            <div>
              <span>2</span>
              <div>
                <strong>用管理员账号登录</strong>
                <p>邮箱是 admin@aidevops.local，密码在你自己电脑的 `.env` 文件中。</p>
              </div>
            </div>
            <div>
              <span>3</span>
              <div>
                <strong>把需求告诉智能体</strong>
                <p>从下方复制一个指令模板，把方括号里的内容换成你的真实需求。</p>
              </div>
            </div>
            <div>
              <span>4</span>
              <div>
                <strong>回平台看进度</strong>
                <p>
                  智能体完成开发后，在“代码仓库”点“同步远程版本”查看真实
                  版本记录；到“发布与版本”的项目发布或版本中心查看构建、
                  日志、待审批和历史版本。
                </p>
              </div>
            </div>
            <div>
              <span>5</span>
              <div>
                <strong>明白之后再批准</strong>
                <p>页面会说明目标版本和回滚方式；不确定时先不批准或取消操作。</p>
              </div>
            </div>
          </div>
        </article>

        <aside className="guide-decision-card">
          <ShieldCheck size={22} />
          <p className="eyebrow light">YOUR ONLY JOB</p>
          <h3>你永远只需要做两个决定</h3>
          <ul>
            <li>
              <Check size={15} />
              <span>
                <strong>目标对不对</strong>
                <small>“这就是我想要的功能吗？”</small>
              </span>
            </li>
            <li>
              <Check size={15} />
              <span>
                <strong>是否允许上线</strong>
                <small>“我理解影响和回滚方案了吗？”</small>
              </span>
            </li>
          </ul>
          <p className="guide-decision-note">
            智能体不应该要求你打开终端、手敲 Git 命令或把云密码发到聊天里。
          </p>
        </aside>
      </section>

      <section className="guide-agent-section">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AGENT BRIDGE</p>
            <h3>任何智能体都能对接 AI DevOps</h3>
          </div>
          <span className="quiet-note">
            Codex / WorkBuddy / CodeBuddy / QoderCN / VS Code 等通用
          </span>
        </div>
        <div className="guide-role-grid">
          <article className="guide-role-card">
            <span className="guide-role-number">01</span>
            <div className="guide-role-icon agent">
              <LockKeyhole size={19} />
            </div>
            <h3>令牌对接（最通用）</h3>
            <p>
              到“平台设置 → 智能体对接”给每个智能体创建一枚令牌，
              智能体凭令牌可以提交交付、查询自己的发布状态，并只读查询已同步资源与指标。
            </p>
            <strong>令牌只显示一次，请复制保存；泄露可随时撤销。</strong>
          </article>
          <article className="guide-role-card">
            <span className="guide-role-number">02</span>
            <div className="guide-role-icon platform">
              <Bot size={19} />
            </div>
            <h3>MCP 对接（Codex / Cursor 等）</h3>
            <p>
              复制设置页里的 MCP 配置 JSON，粘贴到工具的 MCP 配置即可。
              提供 ai_devops_deliver、ai_devops_status、ai_devops_resources、
              ai_devops_health 四个工具。
            </p>
            <strong>接入后直接说“把这次改动交付到 AI DevOps 发布”。</strong>
          </article>
          <article className="guide-role-card">
            <span className="guide-role-number">03</span>
            <div className="guide-role-icon user">
              <Copy size={19} />
            </div>
            <h3>对接指令（兜底方案）</h3>
            <p>
              复制下方“对接指令”发给任意智能体，它会先做只读接入检查；
              只有你明确要求开发并交付时才进入提交和发布流程。
            </p>
            <strong>先检查、再等任务、最后交付。</strong>
          </article>
        </div>
        <div className="agent-prompt-box">
          <div className="agent-prompt-head">
            <strong>对接指令（复制发给任意智能体）</strong>
            <button
              type="button"
              className="copy-prompt-button"
              onClick={() => void copyPrompt("agent-bridge", AGENT_BRIDGE_PROMPT)}
            >
              {copiedId === "agent-bridge" ? (
                <Check size={14} />
              ) : (
                <Copy size={14} />
              )}
              {copiedId === "agent-bridge" ? "已复制" : "复制指令"}
            </button>
          </div>
          <pre className="agent-prompt-pre">{AGENT_BRIDGE_PROMPT}</pre>
        </div>
        <section className="guide-rule-panel">
          <div>
            <ShieldCheck size={20} />
            <h3>对接注意事项（务必遵守）</h3>
          </div>
          <div className="guide-rule-list">
            <span>
              <strong>令牌就是钥匙，只在平台设置页复制。</strong>
              不要发到公开聊天、截图或代码仓库里；泄露了立刻到设置页撤销并重新创建。
            </span>
            <span>
              <strong>智能体只能提交交付和只读查询。</strong>
              可查自己的部署、已同步资源与指标；不能审批、不能执行云变更、
              不能读取任何密钥、不能改平台设置；
              生产部署永远需要你在浏览器里点“批准”。
            </span>
            <span>
              <strong>交付前必须先把代码推送到仓库，且仓库已在平台登记。</strong>
              仓库未登记会失败；先在“代码仓库”里接入 Gitee 地址。
            </span>
            <span>
              <strong>先 staging 验证，再 production。</strong>
              生产发布会暂停在审批环节，智能体不能替你做上线决定。
            </span>
            <span>
              <strong>永远不要把账号密码或云密钥发给智能体。</strong>
              所有凭据已加密存放在 AI DevOps 凭据库，智能体无需接触。
            </span>
          </div>
        </section>
      </section>

      <section className="panel guide-version-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">VERSION MANAGEMENT</p>
            <h3>版本管理在哪看、怎么命名</h3>
          </div>
          <span className="quiet-note">以 Git commit 为唯一版本依据</span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>查看内容</th>
                <th>入口</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>代码版本历史</strong>
                  <small>分支、commit、提交说明、同步时间</small>
                </td>
                <td>左侧菜单 → 代码仓库 → 仓库卡片「最近版本」</td>
              </tr>
              <tr>
                <td>
                  <strong>全部版本与当前版本</strong>
                  <small>commit、镜像标签、环境、审批、日志、回滚版本</small>
                </td>
                <td>发布与版本 → 版本中心</td>
              </tr>
              <tr>
                <td>
                  <strong>单个项目的发布记录</strong>
                  <small>项目级真实部署、健康与审批</small>
                </td>
                <td>发布与版本 → 项目发布 → 项目 → 发布历史</td>
              </tr>
              <tr>
                <td>
                  <strong>回滚到历史版本</strong>
                  <small>创建审批单、切换历史镜像、回滚健康检查</small>
                </td>
                <td>版本中心 → 历史成功版本 → 回滚到此版本</td>
              </tr>
              <tr>
                <td>
                  <strong>最近发布</strong>
                  <small>真实部署的最近记录</small>
                </td>
                <td>总览 → 最近发布（真实部署）</td>
              </tr>
              <tr>
                <td>
                  <strong>操作追溯</strong>
                  <small>谁在什么时间触发了什么版本</small>
                </td>
                <td>审计中心</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="guide-rule-list" style={{ marginTop: 12 }}>
          <span>
            <strong>代码版本：</strong>
            分支 + 7 位 commit 短 SHA，例如 master + 1a2b3c4。
          </span>
          <span>
            <strong>镜像版本：</strong>
            ccr.ccs.tencentyun.com/examplespace/应用英文名:commit短SHA，
            例如 agent-bridge:1a2b3c4。
          </span>
          <span>
            <strong>部署版本：</strong>
            应用 + 环境 + commit + 镜像 + 时间 + 审批与健康结果；人工回滚先审批，
            自动回滚也会生成独立部署记录。
          </span>
          <span>
            <strong>当前说明：</strong>
            暂未启用 v1.2.3 这类语义化版本号；发布固定具体 commit，不使用 latest。
          </span>
        </div>
      </section>

      <section className="prompt-library">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">COPY &amp; ASK</p>
            <h3>可以直接发给智能体的中文指令</h3>
          </div>
          <span className="quiet-note">方括号内容需要你替换</span>
        </div>
        <div className="prompt-card-grid">
          {BEGINNER_PROMPTS.map((template) => (
            <article className="prompt-template-card" key={template.id}>
              <div className="prompt-card-head">
                <span>{template.category}</span>
                <button
                  type="button"
                  className={classNames(
                    "copy-prompt-button",
                    copiedId === template.id && "copied",
                  )}
                  onClick={() => void copyPrompt(template.id, template.prompt)}
                >
                  {copiedId === template.id ? <Check size={14} /> : <Copy size={14} />}
                  {copiedId === template.id ? "已复制" : "复制指令"}
                </button>
              </div>
              <h4>{template.title}</h4>
              <p>{template.description}</p>
              <div className="prompt-copy">{template.prompt}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="guide-rule-panel">
        <div>
          <LockKeyhole size={20} />
          <h3>三条安全规则，不需要你记技术细节</h3>
        </div>
        <div className="guide-rule-list">
          <span>
            <strong>不要把设备密码、云 AK/SK 发给智能体。</strong>
            正确做法是由智能体引导你完成安全连接。
          </span>
          <span>
            <strong>不要批准你看不懂的发布。</strong>
            先要求它用大白话解释影响、证据和回滚。
          </span>
          <span>
            <strong>不要直接暴露到公网。</strong>
            跨电脑使用先确认防火墙、HTTPS 和访问权限。
          </span>
        </div>
      </section>
    </div>
  );
}

function AgentBridgeCard() {
  const [tokens, setTokens] = useState<Array<{
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    revoked: boolean;
  }>>([]);
  const [name, setName] = useState("");
  const [createdToken, setCreatedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [renameName, setRenameName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deletingId, setDeletingId] = useState("");

  async function load() {
    try {
      const response = await api<{ tokens: typeof tokens }>(
        "/api/agent/tokens",
      );
      setTokens(response.tokens);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "读取令牌失败。",
      );
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createToken() {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ token: string }>("/api/agent/tokens", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setCreatedToken(response.token);
      setName("");
      await load();
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : "创建失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tokenItem: { id: string; name: string }) {
    if (
      !window.confirm(
        `撤销「${tokenItem.name}」后该令牌立即失效且无法恢复，确定撤销？`,
      )
    ) {
      return;
    }
    setError("");
    try {
      await api(`/api/agent/tokens/${tokenItem.id}/revoke`, {
        method: "POST",
      });
      await load();
    } catch (revokeError) {
      setError(
        revokeError instanceof Error ? revokeError.message : "撤销失败。",
      );
    }
  }

  function startRename(tokenItem: { id: string; name: string }) {
    setRenaming(tokenItem);
    setRenameName(tokenItem.name);
    setError("");
  }

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming) return;
    const nextName = renameName.trim();
    if (!nextName) return;
    setRenameBusy(true);
    setError("");
    try {
      await api(`/api/agent/tokens/${renaming.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName }),
      });
      setRenaming(null);
      await load();
    } catch (renameError) {
      setError(
        renameError instanceof Error ? renameError.message : "重命名失败。",
      );
    } finally {
      setRenameBusy(false);
    }
  }

  async function removeToken(tokenItem: { id: string; name: string }) {
    if (
      !window.confirm(
        `删除「${tokenItem.name}」的撤销记录？删除后这条记录会从列表移除。`,
      )
    ) {
      return;
    }
    setDeletingId(tokenItem.id);
    setError("");
    try {
      await api(`/api/agent/tokens/${tokenItem.id}`, { method: "DELETE" });
      await load();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "删除失败。",
      );
    } finally {
      setDeletingId("");
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }

  const platformUrl = window.location.origin.replace(/\/+$/, "");
  const mcpConfig = {
    mcpServers: {
      "ai-devops": {
        type: "stdio",
        command: "D:\\AI-DevOps\\runtime\\node\\node.exe",
        args: ["D:\\AI-DevOps\\bridge\\mcp\\ai-devops-mcp.mjs"],
        env: {
          AI_DEVOPS_URL: platformUrl,
          AI_DEVOPS_AGENT_TOKEN:
            createdToken || "<粘贴新创建的智能体令牌>",
        },
      },
    },
  };

  return (
    <>
      <div className="settings-card-head">
        <div className="settings-icon green">
          <Bot size={20} />
        </div>
        <div>
          <p className="eyebrow">AGENT BRIDGE</p>
          <h3>智能体对接（Agent Bridge + MCP）</h3>
        </div>
      </div>
      <div className="agent-bridge">
        <div className="agent-standard-flow">
          <strong>标准对接流程</strong>
          <ol>
            <li>
              <span>1</span>
              创建一枚只属于该智能体的令牌
            </li>
            <li>
              <span>2</span>
              将下方 MCP 配置写入 WorkBuddy
            </li>
            <li>
              <span>3</span>
              调用 ai_devops_health 确认在线
            </li>
            <li>
              <span>4</span>
              只读识别项目并等待你的明确任务
            </li>
            <li>
              <span>5</span>
              开发测试完成后才推送并提交交付
            </li>
          </ol>
        </div>
        <div className="agent-token-row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="智能体名称，例如 WorkBuddy 研发助手"
          />
          <button
            type="button"
            className="button primary compact"
            disabled={busy || !name.trim()}
            onClick={() => void createToken()}
          >
            {busy ? <Spinner label="创建中" /> : "创建智能体令牌"}
          </button>
        </div>
        {createdToken && (
          <div className="agent-token-reveal">
            <span>
              令牌只显示这一次，请立即保存：<code>{createdToken}</code>
            </span>
            <button
              type="button"
              className="button secondary compact"
              onClick={() => void copyText(createdToken)}
            >
              <Copy size={13} /> 复制令牌
            </button>
          </div>
        )}
        {tokens.length > 0 && (
          <div className="adapter-grid">
            {tokens.map((tokenItem) => (
              <div className="adapter-row" key={tokenItem.id}>
                <Bot size={16} />
                <div>
                  <strong>{tokenItem.name}</strong>
                  <small>
                    创建 {timeAgo(tokenItem.createdAt)} · 最近使用{" "}
                    {timeAgo(tokenItem.lastUsedAt)}
                  </small>
                </div>
                <span
                  className={classNames(
                    "connection-state",
                    !tokenItem.revoked && "connected",
                  )}
                >
                  <span className="live-dot" />
                  {tokenItem.revoked ? "已撤销" : "有效"}
                </span>
                <div className="agent-token-actions">
                  <button
                    type="button"
                    className="agent-token-action"
                    title="重命名（不影响令牌本身）"
                    aria-label={`重命名 ${tokenItem.name}`}
                    onClick={() => startRename(tokenItem)}
                  >
                    <Pencil size={14} />
                  </button>
                  {tokenItem.revoked ? (
                    <button
                      type="button"
                      className="agent-token-action danger"
                      title="删除这条已撤销记录"
                      aria-label={`删除 ${tokenItem.name}`}
                      disabled={deletingId === tokenItem.id}
                      onClick={() => void removeToken(tokenItem)}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="agent-token-action danger"
                      title="撤销令牌"
                      aria-label={`撤销 ${tokenItem.name}`}
                      onClick={() => void revoke(tokenItem)}
                    >
                      <XCircle size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="agent-prompt-box">
          <div className="agent-prompt-head">
            <strong>对接指令（发给任意智能体）</strong>
            <button
              type="button"
              className="button secondary compact"
              onClick={() => void copyText(AGENT_BRIDGE_PROMPT)}
            >
              <Copy size={13} /> 复制对接指令
            </button>
          </div>
          <pre className="agent-prompt-pre">{AGENT_BRIDGE_PROMPT}</pre>
        </div>
        <div className="agent-prompt-box">
          <div className="agent-prompt-head">
            <strong>MCP 配置（WorkBuddy / Codex / Cursor）</strong>
            <button
              type="button"
              className="button secondary compact"
              onClick={() =>
                void copyText(JSON.stringify(mcpConfig, null, 2))
              }
            >
              <Copy size={13} /> 复制配置
            </button>
          </div>
          <pre className="agent-prompt-pre">
            {JSON.stringify(mcpConfig, null, 2)}
          </pre>
          <div className="agent-mcp-note">
            <p>
              <strong>连接方式：</strong>
              本机 stdio。command 使用平台内置 Node 的绝对路径，不依赖
              WorkBuddy 的 PATH；WorkBuddy 必须和 AI DevOps 运行在同一台电脑上。
            </p>
            <p>
              <strong>认证头：</strong>
              <code>
                {"Authorization: Bearer <AI_DEVOPS_AGENT_TOKEN>"}
              </code>
              。令牌通过 env 传入，桥接器会自动添加此请求头，无需重复填写。
            </p>
            <p>
              <strong>URL 接入：</strong>
              当前未开放公网 MCP URL；本机使用 command + args 是最小权限、可审计的接入方式。
            </p>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
      {renaming && (
        <Modal
          title="重命名智能体令牌"
          subtitle={`${renaming.name} · 只改显示名称，令牌本身不变`}
          eyebrow="AGENT TOKEN"
          onClose={() => setRenaming(null)}
        >
          <form className="modal-form" onSubmit={saveRename}>
            <label>
              令牌名称
              <input
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                maxLength={80}
                autoFocus
                required
              />
              <small className="field-hint">
                用来区分是哪台设备或哪个智能体在用，例如「Codex 研发助手」。
              </small>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setRenaming(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={renameBusy || !renameName.trim()}
              >
                {renameBusy ? <Spinner label="保存中" /> : "保存名称"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function FaviconSettingsCard() {
  const [version, setVersion] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  function refreshBrowserIcon() {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = `/api/favicon?v=${Date.now()}`;
  }

  async function upload(file: File) {
    setError("");
    if (file.size > 512 * 1024) {
      setError("图标文件不能超过 512KB。");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("读取图标文件失败。"));
        reader.readAsDataURL(file);
      });
      await api("/api/settings/favicon", {
        method: "POST",
        body: JSON.stringify({ dataUrl }),
      });
      setVersion(Date.now());
      refreshBrowserIcon();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "上传失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError("");
    try {
      await api("/api/settings/favicon", { method: "DELETE" });
      setVersion(Date.now());
      refreshBrowserIcon();
    } catch (resetError) {
      setError(
        resetError instanceof Error ? resetError.message : "恢复失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-card-head">
        <div className="settings-icon indigo">
          <AppWindow size={20} />
        </div>
        <div>
          <p className="eyebrow">BROWSER ICON</p>
          <h3>浏览器标签图标（favicon）</h3>
        </div>
      </div>
      <div className="favicon-editor">
        <div className="favicon-preview">
          <img src={`/api/favicon?v=${version}`} alt="浏览器图标预览" />
        </div>
        <div className="favicon-copy">
          <p>
            默认使用侧栏品牌图标（渐变圆角 + 星芒）。上传后浏览器标签页会立即更新，
            新开页面也会使用新图标。
          </p>
          <div className="favicon-actions">
            <input
              ref={inputRef}
              type="file"
              accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className="button primary compact"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <Spinner label="处理中" /> : "上传图标"}
            </button>
            <button
              type="button"
              className="button secondary compact"
              disabled={busy}
              onClick={() => void reset()}
            >
              <RefreshCw size={14} /> 恢复默认
            </button>
          </div>
          <small className="field-hint">
            支持 SVG / PNG / ICO，最大 512KB，建议 128×128。
            自定义图标保存在 D:\AI-DevOps\data\brand\ 目录。
          </small>
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </>
  );
}

function SettingsPage({
  settings,
  session,
  onResetNavOrder,
}: {
  settings: SettingsStatus | null;
  session: SessionUser;
  onResetNavOrder: () => void;
}) {
  return (
    <div className="content-page">
      <div className="settings-grid">
        <article className="panel settings-card wide">
          <FaviconSettingsCard />
        </article>

        <article className="panel settings-card wide">
          <div className="settings-card-head">
            <div className="settings-icon blue">
              <Menu size={20} />
            </div>
            <div>
              <p className="eyebrow">NAVIGATION</p>
              <h3>导航菜单</h3>
            </div>
          </div>
          <div className="settings-fields">
            <div>
              <span>菜单顺序</span>
              <strong>可拖动左侧菜单调整，子菜单随父级移动</strong>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="button secondary compact"
              onClick={onResetNavOrder}
            >
              <RotateCcw size={14} /> 恢复默认菜单顺序
            </button>
          </div>
        </article>

        <article className="panel settings-card">
          <div className="settings-icon indigo">
            <Sparkles size={20} />
          </div>
          <div className="settings-card-copy">
            <p className="eyebrow">AI GATEWAY</p>
            <h3>模型与 Copilot</h3>
            <p>
              可接入 OpenAI-compatible 模型网关。无论模型如何配置，
              生产写工具都不在默认权限集内。
            </p>
          </div>
          <div className="settings-fields">
            <div>
              <span>运行模式</span>
              <strong>{settings?.modelGateway ?? "未检查"}</strong>
            </div>
            <div>
              <span>工具权限</span>
              <strong>只读证据查询</strong>
            </div>
          </div>
        </article>

        <article className="panel settings-card">
          <div className="settings-icon green">
            <Terminal size={20} />
          </div>
          <div className="settings-card-copy">
            <p className="eyebrow">EXECUTION</p>
            <h3>执行与持久化</h3>
            <p>
              当前控制面不会运行任意用户脚本。接入 Kubernetes 后，
              每次任务都将使用短生命隔离 Runner。
            </p>
          </div>
          <div className="settings-fields">
            <div>
              <span>Runner</span>
              <strong>{settings?.executionMode === "simulated" ? "模拟执行" : settings?.executionMode}</strong>
            </div>
            <div>
              <span>状态存储</span>
              <strong>{settings?.persistence ?? "—"}</strong>
            </div>
          </div>
        </article>

        <article className="panel settings-card wide">
          <AgentBridgeCard />
        </article>

        <article className="panel settings-card wide">
          <div className="settings-card-head">
            <div className="settings-icon indigo">
              <LockKeyhole size={20} />
            </div>
            <div>
              <p className="eyebrow">SECRET VAULT</p>
              <h3>凭据库（加密存储）</h3>
            </div>
          </div>
          <div className="adapter-grid">
            {settings?.registryCredentials.map((credential) => (
              <div className="adapter-row" key={credential.id}>
                <Cloud size={16} />
                <div>
                  <strong>{credential.name}</strong>
                  <small>
                    {credential.registry} · 用户 {credential.username}
                  </small>
                </div>
                <span className="connection-state connected">
                  <span className="live-dot" />
                  {credential.hasPassword ? "已保存" : "未配置"}
                </span>
              </div>
            ))}
            {settings?.gitCredentials.map((credential) => (
              <div className="adapter-row" key={credential.id}>
                <GitBranch size={16} />
                <div>
                  <strong>{credential.provider} 代码托管</strong>
                  <small>账号 {credential.username}</small>
                </div>
                <span className="connection-state connected">
                  <span className="live-dot" />
                  {credential.hasPassword ? "已保存" : "未配置"}
                </span>
              </div>
            ))}
            {!settings?.registryCredentials.length &&
              !settings?.gitCredentials.length && (
                <p className="field-hint">尚未保存任何凭据。</p>
              )}
          </div>
        </article>

        <article className="panel settings-card wide">
          <div className="settings-card-head">
            <div className="settings-icon blue">
              <Cloud size={20} />
            </div>
            <div>
              <p className="eyebrow">CLOUD ADAPTERS</p>
              <h3>多云连接器</h3>
            </div>
          </div>
          <div className="adapter-grid">
            {settings?.cloudAdapters.map((adapter) => (
              <div className="adapter-row" key={adapter.provider}>
                <ProviderMark provider={adapter.provider} />
                <div>
                  <strong>{adapter.label}</strong>
                  <small>
                    {adapter.connected
                      ? "只读资源同步已启用"
                      : "适配接口已预留 · 等待真实凭据"}
                  </small>
                </div>
                <span
                  className={classNames(
                    "connection-state",
                    adapter.connected && "connected",
                  )}
                >
                  <span className="live-dot" />
                  {adapter.connected ? "已连接" : "未激活"}
                </span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel settings-card wide">
          <div className="settings-card-head">
            <div className="settings-icon amber">
              <ShieldCheck size={20} />
            </div>
            <div>
              <p className="eyebrow">SECURITY POSTURE</p>
              <h3>当前安全基线</h3>
            </div>
          </div>
          <div className="security-checklist">
            <div>
              <CheckCircle2 size={17} />
              <span>
                <strong>生产发布审批门禁</strong>
                <small>等待中的生产运行不会自动推进</small>
              </span>
            </div>
            <div>
              <CheckCircle2 size={17} />
              <span>
                <strong>云凭据本机加密</strong>
                <small>子账号 Secret 不回显，也不会写入浏览器存储</small>
              </span>
            </div>
            <div>
              <CheckCircle2 size={17} />
              <span>
                <strong>操作审计</strong>
                <small>管理员：{session.email}</small>
              </span>
            </div>
            <div className="needs-action">
              <TriangleAlert size={17} />
              <span>
                <strong>共享部署前必须更新默认密钥</strong>
                <small>更新 .env 中的 JWT_SECRET 与 ADMIN_PASSWORD</small>
              </span>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}

function RunDrawer({
  run,
  onClose,
  onApprove,
  onError,
}: {
  run: PipelineRun;
  onClose: () => void;
  onApprove: (run: PipelineRun) => void;
  onError: (error: unknown) => void;
}) {
  const [analysis, setAnalysis] = useState<RunAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function analyze() {
    setAnalyzing(true);
    try {
      const response = await api<{ analysis: RunAnalysis }>(
        `/api/runs/${run.id}/analyze`,
        { method: "POST" },
      );
      setAnalysis(response.analysis);
    } catch (error) {
      onError(error);
    } finally {
      setAnalyzing(false);
    }
  }

  function approve() {
    setApproving(true);
    onApprove(run);
    window.setTimeout(() => setApproving(false), 1_000);
  }

  return (
    <div className="drawer-layer" role="presentation">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="关闭详情"
        onClick={onClose}
      />
      <aside className="run-drawer" role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div>
            <p className="eyebrow">PIPELINE RUN</p>
            <h2>{run.pipelineName}</h2>
            <span>
              {run.repositoryName} · {ENVIRONMENT_LABELS[run.environment]} ·{" "}
              <span className="mono">{run.commitSha}</span>
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </div>

        <div className="drawer-summary">
          <StatusBadge status={run.status} />
          <span>
            <Clock3 size={14} /> {formatDuration(run.durationMs)}
          </span>
          <span>
            <GitCommitHorizontal size={14} /> {run.triggeredBy}
          </span>
          <span className={classNames("risk-chip", run.riskLevel)}>
            {run.riskLevel === "high"
              ? "高风险"
              : run.riskLevel === "medium"
                ? "中风险"
                : "低风险"}
          </span>
        </div>

        {run.status === "waiting_approval" && (
          <div className="approval-gate">
            <div className="approval-gate-icon">
              <LockKeyhole size={20} />
            </div>
            <div>
              <strong>生产写入已被门禁暂停</strong>
              <p>
                质量门禁和制品构建已通过。审批动作会写入审计并完成模拟发布。
              </p>
            </div>
            <button
              type="button"
              className="button primary compact"
              onClick={approve}
              disabled={approving}
            >
              {approving ? <Spinner label="审批中" /> : "批准发布"}
            </button>
          </div>
        )}

        <div className="drawer-section">
          <div className="drawer-section-title">
            <h3>执行步骤</h3>
            <span>{run.steps.filter((step) => step.status === "succeeded").length}/{run.steps.length} 完成</span>
          </div>
          <div className="run-steps">
            {run.steps.map((step, index) => (
              <div className="run-step" key={`${step.name}-${index}`}>
                <span className={classNames("run-step-number", step.status)}>
                  {step.status === "succeeded" ? (
                    <Check size={14} />
                  ) : step.status === "failed" ? (
                    <X size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <strong>{step.name}</strong>
                  <small>{step.description ?? "受控执行步骤"}</small>
                </div>
                <span className={classNames("step-state", step.status)}>
                  {STATUS_LABELS[step.status] ?? step.status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">
            <h3>运行证据</h3>
            <button
              type="button"
              className="text-button"
              onClick={() => void analyze()}
              disabled={analyzing}
            >
              {analyzing ? (
                <Spinner label="分析中" />
              ) : (
                <>
                  <Sparkles size={14} /> AI 分析
                </>
              )}
            </button>
          </div>
          {analysis && (
            <div className="run-analysis">
              <div>
                <span className={classNames("risk-chip", analysis.severity)}>
                  {analysis.severity === "high"
                    ? "高风险"
                    : analysis.severity === "medium"
                      ? "中风险"
                      : "低风险"}
                </span>
                <strong>{analysis.summary}</strong>
              </div>
              <ul>
                {analysis.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {analysis.recommendations.map((recommendation) => (
                <div className="analysis-action" key={recommendation.title}>
                  <ChevronRight size={14} />
                  <span>{recommendation.title}</span>
                  {recommendation.requiresApproval && <em>需审批</em>}
                </div>
              ))}
            </div>
          )}
          <div className="terminal-log">
            <div className="terminal-bar">
              <Terminal size={15} />
              <span>runner://{run.id}</span>
              <i className={run.status === "failed" ? "error" : ""} />
            </div>
            <div className="terminal-body">
              {run.logs.map((line, index) => (
                <div className={classNames("log-line", line.level)} key={`${line.time}-${index}`}>
                  <time>{new Date(line.time).toLocaleTimeString("zh-CN", { hour12: false })}</time>
                  <span>{line.level.toUpperCase()}</span>
                  <p>{line.message}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  eyebrow = "PLATFORM ONBOARDING",
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  eyebrow?: string;
}) {
  return (
    <div className="modal-layer">
      <button
        type="button"
        className="modal-backdrop"
        onClick={onClose}
        aria-label="关闭弹窗"
      />
      <section className="modal-card" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function AddRepositoryModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [provider, setProvider] = useState("gitee");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [servers, setServers] = useState<CloudServer[]>([]);
  const [serverId, setServerId] = useState("");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ servers: CloudServer[] }>("/api/servers")
      .then((response) => {
        setServers(response.servers);
        setServerId(
          (current) =>
            current ||
            response.servers.find((server) => server.status === "connected")
              ?.id ||
            response.servers[0]?.id ||
            "",
        );
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api("/api/repositories", {
        method: "POST",
        body: JSON.stringify({
          provider,
          name,
          url,
          branch,
          serverId: serverId || null,
          token,
        }),
      });
      await onCreated("仓库已登记，请点击“同步远程版本”完成首次拉取。");
    } catch (error) {
      onError(error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="接入代码仓库"
      subtitle="推荐 Gitee（码云）：免费、国内快、中文界面；私有仓库填写私人令牌即可。"
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="provider-choice">
          {(["github", "gitlab", "gitea", "gitee"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={classNames(provider === item && "active")}
              onClick={() => setProvider(item)}
            >
              <ProviderMark provider={item} size="small" />
              {PROVIDER_LABELS[item]}
            </button>
          ))}
        </div>
        <label>
          仓库名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 checkout-service"
            required
          />
        </label>
        <label>
          HTTPS 仓库地址
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://gitee.com/你的用户名/仓库名.git"
            required
          />
        </label>
        <label>
          默认分支
          <input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            required
          />
        </label>
        <label>
          同步服务器
          <select
            value={serverId}
            onChange={(event) => setServerId(event.target.value)}
          >
            {servers.length === 0 && <option value="">暂无服务器连接</option>}
            {servers.map((server) => (
              <option value={server.id} key={server.id}>
                {server.name}（{server.host}）
              </option>
            ))}
          </select>
          <small className="field-hint">
            代码由该服务器上的 git 拉取并缓存，后续构建也在这台服务器上进行。
          </small>
        </label>
        <label>
          私有仓库令牌（可选）
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="公开仓库留空；Gitee 在“设置→私人令牌”生成"
          />
          <small className="field-hint">
            令牌加密保存在本机，不会回显。私有仓库建议只勾选“projects”读权限。
          </small>
        </label>
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? <Spinner label="正在登记" /> : "登记仓库"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddCloudModal({
  account,
  onClose,
  onCreated,
  onError,
}: {
  account: CloudAccount | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [provider, setProvider] = useState(account?.provider ?? "tencent");
  const [name, setName] = useState(account?.name ?? "");
  const [region, setRegion] = useState(account?.region ?? "ap-shanghai");
  const [accountType, setAccountType] = useState<"main" | "sub">(
    account?.accountType ?? "main",
  );
  const [ownerId, setOwnerId] = useState(account?.ownerId ?? "");
  const [accessKeyId, setAccessKeyId] = useState(account?.accessKeyId ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [note, setNote] = useState(account?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const subFields =
    SUB_ACCOUNT_LABELS[provider] ?? SUB_ACCOUNT_LABELS.tencent;
  const hasSavedSecret =
    account?.provider === provider && account.hasSecret;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!hasSavedSecret && !secretKey) {
      setFormError(`请填写${subFields.secretLabel}。`);
      return;
    }
    setSubmitting(true);
    try {
      const path = account
        ? `/api/cloud/accounts/${account.id}`
        : "/api/cloud/accounts";
      const method = account ? "PATCH" : "POST";
      await api(path, {
        method,
        body: JSON.stringify({
          provider,
          name,
          region,
          accountType,
          ownerId,
          accessKeyId,
          secretKey,
          note,
        }),
      });
      await onCreated();
    } catch (error) {
      onError(error);
      setFormError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={account ? "编辑云账号" : "登记云账号"}
      subtitle={
        provider === "aliyun"
          ? "主账号或 RAM 子账号均可使用 AccessKey 登录 OpenAPI；网页登录密码不交给 AIDevOps。"
          : "使用云厂商 API 密钥；主账号和子账号均可，密钥加密保存在本机。"
      }
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="provider-choice cloud-provider-choice">
          {(["tencent", "aliyun", "huawei"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={classNames(provider === item && "active")}
              onClick={() => {
                if (item !== provider) {
                  setOwnerId("");
                  setAccessKeyId("");
                  setSecretKey("");
                }
                setProvider(item);
                setAccountType("main");
                setRegion(
                  item === "tencent"
                    ? "ap-shanghai"
                    : item === "aliyun"
                      ? "cn-hangzhou"
                      : "cn-east-3",
                );
              }}
            >
              <ProviderMark provider={item} size="small" />
              {PROVIDER_LABELS[item]}
            </button>
          ))}
        </div>
        <label>
          账号显示名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 腾讯云 · 研发环境"
            required
          />
        </label>
        <label>
          默认地域
          <input
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            required
          />
        </label>

        {provider === "aliyun" && (
          <div className="cloud-login-guide">
            <div className="cloud-login-intro">
              <strong>阿里云主账号或 RAM 子账号 AccessKey 获取位置</strong>
              <small className="field-hint">
                控制台账号密码只用于你本人登录，AIDevOps
                不接收也不保存，因为网页登录密码不能调用 OpenAPI。主账号
                AccessKey 权限最大，仅用于本机单账号应急；生产建议创建最小权限
                RAM 子账号。
              </small>
              <a
                className="button secondary compact"
                href={ALIYUN_MAIN_LOGIN_URL}
                target="_blank"
                rel="noreferrer"
              >
                先登录阿里云官方控制台 <ArrowUpRight size={14} />
              </a>
            </div>
            <ol className="cloud-login-steps">
              <li>
                <div>
                  <strong>1. 复制主账号 UID（可选）</strong>
                  <span>
                    打开账号中心，在“账号信息”中复制“账号 ID（UID）”。不要填登录邮箱或手机号。
                  </span>
                </div>
                <a
                  href="https://account.console.aliyun.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开账号中心 <ArrowUpRight size={12} />
                </a>
              </li>
              <li>
                <div>
                  <strong>2. 创建 AccessKey</strong>
                  <span>
                    主账号：阿里云控制台右上角头像 → AccessKey
                    管理 → 创建 AccessKey。也可以进入 RAM 控制台创建 RAM
                    用户并勾选“使用永久 AccessKey 访问”。Secret 只显示一次。
                  </span>
                </div>
                <a
                  href="https://usercenter.console.aliyun.com/#/manage/ak"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开 AccessKey 管理 <ArrowUpRight size={12} />
                </a>
              </li>
              <li>
                <div>
                  <strong>3. 按操作需要授予权限</strong>
                  <span>
                    只查看资源时授予只读权限；启停、安全组、快照、扩盘、创建和释放均需对应
                    ECS/VPC 操作权限。建议限定地域和资源标签，避免整账号宽权限。
                  </span>
                </div>
                <a
                  href="https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair"
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 AccessKey 创建文档 <ArrowUpRight size={12} />
                </a>
              </li>
            </ol>
          </div>
        )}

        <fieldset className="app-type-fieldset">
          <legend>账号类型</legend>
          <div className="provider-choice account-type-choice">
            <button
              type="button"
              className={classNames(accountType === "main" && "active")}
              onClick={() => setAccountType("main")}
            >
              主账号
            </button>
            <button
              type="button"
              className={classNames(accountType === "sub" && "active")}
              onClick={() => setAccountType("sub")}
            >
              子账号
            </button>
          </div>
          <small className="field-hint">
            {accountType === "main"
              ? "主账号 API 密钥权限通常最大，请只在确有需要时使用，并开启 MFA、定期轮换。"
              : "子账号使用独立 API 密钥，建议只授予所需地域、资源标签和操作权限。"}
          </small>
        </fieldset>

        <label>
          {subFields.ownerLabel}
          <input
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
            placeholder={subFields.ownerLabel}
          />
          <small className="field-hint">{subFields.ownerHint}</small>
        </label>
        <label>
          {subFields.keyLabel}
          <input
            value={accessKeyId}
            onChange={(event) => setAccessKeyId(event.target.value)}
            placeholder={subFields.keyLabel}
            required
          />
        </label>
        <label>
          {subFields.secretLabel}
          <input
            type="password"
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
            placeholder={
              hasSavedSecret
                ? "留空表示不修改已保存的密钥"
                : `输入${subFields.secretLabel}（不是控制台登录密码）`
            }
            required={!hasSavedSecret}
          />
          <small className="field-hint">
            Secret 只在本机 AI DevOps 数据目录中加密保存，不会回显或写入浏览器存储。
          </small>
        </label>
        <label>
          备注（可选）
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="例如 生产子账号 · 张家口地域 · 仅标签 env=prod"
          />
        </label>

        {formError && <p className="form-error">{formError}</p>}

        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? <Spinner label="正在保存" /> : account ? "保存修改" : "完成登记"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default App;

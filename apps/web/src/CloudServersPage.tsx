import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronLeft,
  Cloud,
  LoaderCircle,
  Monitor,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, getToken } from "./api";
import type {
  CloudServer,
  ServerEnvironmentProbe,
  ServerExecResult,
} from "./types";

const OS_LABELS: Record<CloudServer["osType"], string> = {
  ubuntu: "Ubuntu",
  linux: "Linux",
  windows: "Windows",
};

const PROVIDER_LABELS: Record<CloudServer["provider"], string> = {
  tencent: "腾讯云",
  aliyun: "阿里云",
  huawei: "华为云",
  other: "其他 / 自建",
};

function timeAgo(value: string | null): string {
  if (!value) return "尚未测试";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function CloudServersPage({
  onError,
  notify,
  refreshSignal,
}: {
  onError: (error: unknown) => void;
  notify: (message: string, tone?: "success" | "error") => void;
  refreshSignal: number;
}) {
  const [servers, setServers] = useState<CloudServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CloudServer | null>(null);
  const [active, setActive] = useState<CloudServer | null>(null);
  const [testingId, setTestingId] = useState("");

  async function load() {
    try {
      const response = await api<{ servers: CloudServer[] }>("/api/servers");
      setServers(response.servers);
      setActive((current) =>
        current
          ? (response.servers.find((item) => item.id === current.id) ?? null)
          : null,
      );
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  async function testConnection(server: CloudServer) {
    setTestingId(server.id);
    try {
      const result = await api<{ osInfo: string }>(
        `/api/servers/${server.id}/test`,
        { method: "POST" },
      );
      await load();
      notify(`连接成功：${result.osInfo}。`, "success");
    } catch (error) {
      await load();
      onError(error);
    } finally {
      setTestingId("");
    }
  }

  async function removeServer(server: CloudServer) {
    const confirmed = window.confirm(
      `确定删除服务器连接“${server.name}”吗？服务器本身不受影响，只会移除平台里的连接信息。`,
    );
    if (!confirmed) return;
    try {
      await api(`/api/servers/${server.id}`, { method: "DELETE" });
      setActive(null);
      await load();
      notify("服务器连接已删除。");
    } catch (error) {
      onError(error);
    }
  }

  if (active) {
    return (
      <ServerTerminal
        server={active}
        onBack={() => {
          setActive(null);
          void load();
        }}
        onError={onError}
        notify={notify}
      />
    );
  }

  return (
    <div className="content-page">
      <section className="panel db-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">CLOUD SERVERS</p>
            <h3>云服务器连接</h3>
            <p className="panel-sub">
              可视化连接 Ubuntu / Linux / Windows 服务器，在浏览器里直接操作命令行终端。
            </p>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            <Plus size={16} /> 新建服务器连接
          </button>
        </div>

        {loading && (
          <div className="db-loading">
            <LoaderCircle size={20} className="spin" />
            <span>正在读取服务器列表</span>
          </div>
        )}

        {!loading && servers.length === 0 && (
          <div className="db-empty">
            <div className="db-empty-icon">
              <Server size={26} />
            </div>
            <h4>还没有云服务器连接</h4>
            <p>点“新建服务器连接”，填写服务器公网 IP、登录账号和密码即可开始。</p>
            <div className="db-empty-cards">
              <div>
                <Monitor size={18} />
                <strong>Ubuntu / Linux</strong>
                <small>
                  使用 SSH 协议，默认端口 22。连上后可在浏览器终端里执行任意命令、
                  查看日志、部署应用，和你在服务器上敲命令完全一样。
                </small>
              </div>
              <div>
                <SquareTerminal size={18} />
                <strong>Windows</strong>
                <small>
                  同样通过 SSH 连接，需要先在 Windows 服务器“可选功能”里安装
                  OpenSSH 服务器，默认端口也是 22，终端里就是 PowerShell / CMD。
                </small>
              </div>
            </div>
            <p className="db-secret-note">
              <ShieldCheck size={15} />
              登录密码加密保存在本机 AI DevOps 数据目录，所有连接和命令操作都进入审计中心。
            </p>
          </div>
        )}

        {!loading && servers.length > 0 && (
          <div className="db-connection-grid">
            {servers.map((server) => (
              <article className="db-connection-card" key={server.id}>
                <div className="db-card-head">
                  <div
                    className={`db-kind-icon server ${
                      server.osType === "windows" ? "windows" : ""
                    }`}
                  >
                    <Server size={19} />
                  </div>
                  <div className="db-card-title">
                    <strong>{server.name}</strong>
                    <span>
                      {PROVIDER_LABELS[server.provider]}
                      {server.region ? ` · ${server.region}` : ""} ·{" "}
                      {OS_LABELS[server.osType]}
                    </span>
                  </div>
                  <span
                    className={`db-status ${
                      server.status === "connected"
                        ? "ok"
                        : server.status === "error"
                          ? "bad"
                          : ""
                    }`}
                  >
                    <i />
                    {server.status === "connected"
                      ? "已连通"
                      : server.status === "error"
                        ? "连接异常"
                        : "未测试"}
                  </span>
                </div>

                <dl className="db-card-meta">
                  <div>
                    <dt>地址</dt>
                    <dd>
                      {server.host}:{server.port}
                    </dd>
                  </div>
                  <div>
                    <dt>登录账号</dt>
                    <dd>{server.username}</dd>
                  </div>
                  <div>
                    <dt>连接方式</dt>
                    <dd>SSH · 命令行</dd>
                  </div>
                </dl>

                {server.status === "error" ? (
                  <div className="db-card-error">
                    <TriangleAlert size={15} />
                    <div>
                      <strong>连接失败</strong>
                      <span>
                        {server.statusMessage ||
                          "测试连接失败，服务器没有返回具体原因。"}
                      </span>
                      <small>
                        上次检查 {timeAgo(server.lastCheckedAt)} · 修正登录账号/密码后点“测试连接”重试
                      </small>
                    </div>
                  </div>
                ) : (
                  <p className="db-card-status-line">
                    {server.statusMessage} · 上次检查 {timeAgo(server.lastCheckedAt)}
                  </p>
                )}

                <div className="db-card-actions">
                  <button
                    type="button"
                    className="button primary compact"
                    onClick={() => setActive(server)}
                  >
                    <SquareTerminal size={14} /> 连接终端
                  </button>
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={testingId === server.id}
                    onClick={() => void testConnection(server)}
                  >
                    {testingId === server.id ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    测试连接
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="编辑连接"
                    onClick={() => {
                      setEditing(server);
                      setModalOpen(true);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    title="删除连接"
                    onClick={() => void removeServer(server)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel db-safety-panel">
        <div className="db-safety-copy">
          <ShieldCheck size={20} />
          <div>
            <strong>安全说明</strong>
            <p>
              终端会话只在你打开“连接终端”时建立，关闭页面即断开。Ubuntu / Linux
              走标准 SSH；Windows 需要服务器开启 OpenSSH Server。所有命令执行会记录到审计中心。
            </p>
          </div>
        </div>
      </section>

      {modalOpen && (
        <ServerFormModal
          server={editing}
          onClose={() => setModalOpen(false)}
          onSaved={async (message) => {
            setModalOpen(false);
            await load();
            notify(message);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function ServerFormModal({
  server,
  onClose,
  onSaved,
  onError,
}: {
  server: CloudServer | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [osType, setOsType] = useState<CloudServer["osType"]>(
    server?.osType ?? "ubuntu",
  );
  const [provider, setProvider] = useState<CloudServer["provider"]>(
    server?.provider ?? "tencent",
  );
  const [region, setRegion] = useState(server?.region ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "root");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState(server?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!server && !password) {
      setFormError("请填写登录密码。");
      return;
    }
    setSubmitting(true);
    try {
      const path = server ? `/api/servers/${server.id}` : "/api/servers";
      const method = server ? "PATCH" : "POST";
      await api<{ server: CloudServer }>(path, {
        method,
        body: JSON.stringify({
          name,
          osType,
          provider,
          region,
          host,
          port: Number(port),
          username,
          password,
          note,
        }),
      });
      await onSaved(server ? "服务器连接已更新。" : "服务器连接已创建。");
    } catch (error) {
      onError(error);
      setFormError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-layer">
      <button
        type="button"
        className="modal-backdrop"
        onClick={onClose}
        aria-label="关闭弹窗"
      />
      <section className="modal-card db-modal-card" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <p className="eyebrow">CLOUD SERVER</p>
            <h2>{server ? "编辑服务器连接" : "新建服务器连接"}</h2>
            <p>配置一次，之后在浏览器里直接打开命令行终端。</p>
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

        <form className="modal-form db-form" onSubmit={submit}>
          <label>
            服务器名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 官网生产服务器 / 测试机"
              required
            />
          </label>

          <div className="db-form-row">
            <label>
              系统类型
              <select
                value={osType}
                onChange={(event) =>
                  setOsType(event.target.value as CloudServer["osType"])
                }
              >
                <option value="ubuntu">Ubuntu</option>
                <option value="linux">Linux（CentOS / Debian 等）</option>
                <option value="windows">Windows</option>
              </select>
            </label>
            <label>
              所属云厂商
              <select
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as CloudServer["provider"])
                }
              >
                <option value="tencent">腾讯云</option>
                <option value="aliyun">阿里云</option>
                <option value="huawei">华为云</option>
                <option value="other">其他 / 自建机房</option>
              </select>
            </label>
          </div>

          <label>
            地域（可选）
            <input
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              placeholder="例如 广州 / 上海"
            />
          </label>

          <div className="db-form-row">
            <label>
              服务器公网 IP
              <input
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="例如 119.29.100.20"
                required
              />
            </label>
            <label className="db-port">
              SSH 端口
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                required
              />
            </label>
          </div>

          <div className="db-form-row">
            <label>
              登录用户名
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={osType === "windows" ? "例如 administrator" : "例如 root / ubuntu"}
                required
              />
            </label>
            <label>
              登录密码
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={server ? "留空表示不修改" : "输入服务器登录密码"}
                required={!server}
              />
            </label>
          </div>

          <label>
            备注（可选）
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如 运行官网和订单服务"
            />
          </label>

          {osType === "windows" && (
            <p className="field-hint db-ssh-hint">
              提示：Windows 需要先开启 OpenSSH 服务器（设置 → 应用 → 可选功能 →
              OpenSSH 服务器），并确保安全组放行 22 端口。终端里就是 PowerShell / CMD。
            </p>
          )}
          {osType !== "windows" && (
            <p className="field-hint db-ssh-hint">
              提示：请确保云安全组 / 防火墙已放行 22 端口，允许你当前电脑的 IP 访问。
            </p>
          )}

          {formError && <p className="form-error">{formError}</p>}

          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={submitting}
            >
              {submitting && <LoaderCircle size={15} className="spin" />}
              {server ? "保存修改" : "保存并完成"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ServerTerminal({
  server,
  onBack,
  onError,
  notify,
}: {
  server: CloudServer;
  onBack: () => void;
  onError: (error: unknown) => void;
  notify: (message: string, tone?: "success" | "error") => void;
}) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef(new TextDecoder("utf-8"));
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [quickCommand, setQuickCommand] = useState("");
  const [execRunning, setExecRunning] = useState(false);
  const [execResult, setExecResult] = useState<ServerExecResult | null>(null);
  const [environment, setEnvironment] = useState<ServerEnvironmentProbe | null>(
    null,
  );
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"Cascadia Code", Consolas, "Courier New", monospace',
      theme: {
        background: "#0f1624",
        foreground: "#d8e2f3",
        cursor: "#8b93ff",
      },
      scrollback: 4000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalHostRef.current as HTMLElement);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.writeln("\x1b[90m正在建立 SSH 连接，请稍候……\x1b[0m");

    function connect() {
      setConnecting(true);
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/servers/${server.id}/terminal?token=${encodeURIComponent(
          getToken(),
        )}`,
      );
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;

      socket.onopen = () => {
        setConnecting(false);
        setConnected(true);
        terminal.writeln("\x1b[32m已连接，欢迎使用。输入 exit 可退出会话。\x1b[0m");
        fit.fit();
        sendResize();
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          terminal.write(event.data);
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        terminal.write(decoderRef.current.decode(bytes, { stream: true }));
      };
      socket.onerror = () => {
        setConnecting(false);
        setConnected(false);
        terminal.writeln("\r\n\x1b[31m[连接失败] 无法连接服务器，请检查网络与账号。\x1b[0m");
      };
      socket.onclose = () => {
        setConnecting(false);
        setConnected(false);
        if (wsRef.current === socket) {
          terminal.writeln("\r\n\x1b[33m[会话已断开]\x1b[0m");
        }
      };
    }

    function sendResize() {
      try {
        const dimensions = fit.proposeDimensions();
        if (dimensions && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "resize",
              cols: dimensions.cols,
              rows: dimensions.rows,
            }),
          );
        }
      } catch {
        // 尺寸变化时尽力而为。
      }
    }

    const dataHandler = terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });
    const resizeHandler = terminal.onResize(() => sendResize());
    const windowHandler = () => {
      try {
        fit.fit();
      } catch {
        // 窗口变化时尽力而为。
      }
    };
    window.addEventListener("resize", windowHandler);

    connect();

    return () => {
      window.removeEventListener("resize", windowHandler);
      dataHandler.dispose();
      resizeHandler.dispose();
      wsRef.current?.close();
      wsRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  async function runQuickCommand() {
    if (!quickCommand.trim()) return;
    setExecRunning(true);
    setExecResult(null);
    try {
      const response = await api<{ result: ServerExecResult }>(
        `/api/servers/${server.id}/exec`,
        {
          method: "POST",
          body: JSON.stringify({ command: quickCommand }),
        },
      );
      setExecResult(response.result);
    } catch (error) {
      onError(error);
    } finally {
      setExecRunning(false);
    }
  }

  async function probeEnvironment() {
    setProbing(true);
    try {
      const response = await api<{ environment: ServerEnvironmentProbe }>(
        `/api/servers/${server.id}/probe`,
        { method: "POST" },
      );
      setEnvironment(response.environment);
      notify("环境检测完成。");
    } catch (error) {
      onError(error);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="content-page">
      <section className="panel db-detail-panel">
        <div className="db-detail-head">
          <button type="button" className="button ghost compact" onClick={onBack}>
            <ChevronLeft size={15} /> 返回服务器列表
          </button>
          <div className="db-detail-title">
            <div className="db-kind-icon server">
              <Server size={18} />
            </div>
            <div>
              <h3>{server.name}</h3>
              <p>
                {server.host}:{server.port} · {server.username} ·{" "}
                {OS_LABELS[server.osType]}
              </p>
            </div>
          </div>
          <span
            className={`db-status ${
              connected ? "ok" : connecting ? "" : "bad"
            }`}
          >
            <i />
            {connected ? "终端已连接" : connecting ? "连接中" : "已断开"}
          </span>
          <button
            type="button"
            className="button secondary compact"
            disabled={probing}
            onClick={() => void probeEnvironment()}
          >
            {probing ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            环境检测
          </button>
          <button
            type="button"
            className="button secondary compact"
            onClick={() => window.location.reload()}
          >
            <RefreshCw size={14} /> 重新连接
          </button>
        </div>

        <div className="server-terminal-wrap">
          <div className="server-terminal-bar">
            <span>
              <i className="live-dot" /> SSH 实时终端 · {server.name}
            </span>
            <small>
              {server.osType === "windows"
                ? "PowerShell / CMD · OpenSSH"
                : "bash / shell · SSH 22"}
            </small>
          </div>
          <div className="server-terminal" ref={terminalHostRef} />
        </div>

        {environment && (
          <div className="server-env-panel">
            <div className="db-main-head">
              <div>
                <strong>服务器运行环境</strong>
                <small>
                  检测时间 {new Date(environment.collectedAt).toLocaleString()}
                </small>
              </div>
              <span
                className={`db-status ${
                  environment.dockerActive &&
                  environment.git !== "未安装" &&
                  environment.docker !== "未安装"
                    ? "ok"
                    : "bad"
                }`}
              >
                <i />
                {environment.dockerActive && environment.docker !== "未安装"
                  ? "容器化就绪"
                  : "未就绪"}
              </span>
            </div>
            <dl className="server-env-grid">
              <div>
                <dt>操作系统</dt>
                <dd>{environment.os || "—"}</dd>
              </div>
              <div>
                <dt>Git</dt>
                <dd>{environment.git}</dd>
              </div>
              <div>
                <dt>Docker</dt>
                <dd>{environment.docker}</dd>
              </div>
              <div>
                <dt>Docker Compose</dt>
                <dd>{environment.dockerCompose}</dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd>{environment.node}</dd>
              </div>
              <div>
                <dt>Docker 服务</dt>
                <dd>{environment.dockerActive ? "运行中" : "未运行"}</dd>
              </div>
              <div>
                <dt>运行中容器</dt>
                <dd>{environment.containerCount} 个</dd>
              </div>
              <div>
                <dt>磁盘使用</dt>
                <dd>{environment.disk || "—"}</dd>
              </div>
            </dl>
          </div>
        )}

        <div className="server-quick-exec">
          <div className="db-main-head">
            <div>
              <strong>快速执行命令（可选）</strong>
              <small>
                不想用终端时，也可以在这里直接输入一条命令执行，结果显示在下方。
              </small>
            </div>
          </div>
          <div className="server-exec-row">
            <input
              value={quickCommand}
              onChange={(event) => setQuickCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runQuickCommand();
              }}
              placeholder={
                server.osType === "windows"
                  ? "例如：dir C:\\ 或 ipconfig"
                  : "例如：df -h 或 systemctl status nginx"
              }
            />
            <button
              type="button"
              className="button primary compact"
              disabled={execRunning || !quickCommand.trim()}
              onClick={() => void runQuickCommand()}
            >
              {execRunning ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Play size={14} />
              )}
              执行
            </button>
          </div>
          {execResult && (
            <pre className="server-exec-output">
              <span>
                退出码 {execResult.exitCode ?? "—"} · {execResult.elapsedMs} ms
              </span>
              {execResult.stdout || "(无标准输出)"}
              {execResult.stderr && (
                <>
                  {"\n\n--- 标准错误 ---\n"}
                  {execResult.stderr}
                </>
              )}
            </pre>
          )}
        </div>

        <p className="db-sql-hint">
          <ShieldCheck size={14} />
          终端操作等同直接登录服务器，请谨慎执行删除、关机等高危命令；所有命令会记录审计。
        </p>
      </section>
    </div>
  );
}

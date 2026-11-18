import {
  autocompletion,
} from "@codemirror/autocomplete";
import { MySQL, sql } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { placeholder } from "@codemirror/view";
import {
  Check,
  ChevronLeft,
  Cloud,
  Database,
  HardDrive,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import type {
  DbBackup,
  DbColumnInfo,
  DbConnection,
  DbDatabaseInfo,
  DbQueryResult,
  DbTableDetail,
  DbTableInfo,
} from "./types";

const KIND_LABELS: Record<DbConnection["kind"], string> = {
  cloud_managed: "云厂商云数据库",
  self_hosted: "服务器自装 MySQL",
};

const VENDOR_LABELS: Record<DbConnection["vendor"], string> = {
  tencent: "腾讯云",
  aliyun: "阿里云",
  huawei: "华为云",
  other: "其他 / 自建",
};

function formatBytes(value: number): string {
  if (value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

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

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DatabasePage({
  onError,
  notify,
  refreshSignal,
}: {
  onError: (error: unknown) => void;
  notify: (message: string, tone?: "success" | "error") => void;
  refreshSignal: number;
}) {
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);
  const [active, setActive] = useState<DbConnection | null>(null);
  const [testingId, setTestingId] = useState("");
  const [scheduler, setScheduler] = useState<{
    enabled: boolean;
    retentionDays: number;
    lastBackupAt: string | null;
    lastBackupName: string | null;
    schedule: string;
  } | null>(null);
  const [backupRunning, setBackupRunning] = useState(false);

  async function load() {
    try {
      const response = await api<{ connections: DbConnection[] }>(
        "/api/db/connections",
      );
      setConnections(response.connections);
      setActive((current) =>
        current
          ? (response.connections.find((item) => item.id === current.id) ??
            null)
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
    api<{ scheduler: typeof scheduler }>("/api/db/scheduler/status")
      .then((response) => setScheduler(response.scheduler))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  async function runBackupNow() {
    setBackupRunning(true);
    try {
      const response = await api<{ created: number }>(
        "/api/db/backup/run-now",
        { method: "POST" },
      );
      notify(`定时备份已执行，新建 ${response.created} 个备份。`);
      const status = await api<{ scheduler: typeof scheduler }>(
        "/api/db/scheduler/status",
      );
      setScheduler(status.scheduler);
    } catch (error) {
      onError(error);
    } finally {
      setBackupRunning(false);
    }
  }

  async function testConnection(connection: DbConnection) {
    setTestingId(connection.id);
    try {
      const result = await api<{ version: string }>(
        `/api/db/connections/${connection.id}/test`,
        { method: "POST" },
      );
      await load();
      notify(`连接成功：MySQL ${result.version}。`, "success");
    } catch (error) {
      await load();
      onError(error);
    } finally {
      setTestingId("");
    }
  }

  async function removeConnection(connection: DbConnection) {
    const confirmed = window.confirm(
      `确定删除连接“${connection.name}”吗？该连接下的备份文件也会一并删除，数据库本身不受影响。`,
    );
    if (!confirmed) return;
    try {
      await api(`/api/db/connections/${connection.id}`, { method: "DELETE" });
      setActive(null);
      await load();
      notify("连接已删除。");
    } catch (error) {
      onError(error);
    }
  }

  if (active) {
    return (
      <ConnectionDetail
        key={active.id}
        connection={active}
        onBack={() => {
          setActive(null);
          void load();
        }}
        onError={onError}
        notify={notify}
        onTested={() => void load()}
      />
    );
  }

  return (
    <div className="content-page">
      <section className="panel db-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">DATABASE HUB</p>
            <h3>数据库连接</h3>
            <p className="panel-sub">
              连接云厂商云数据库或服务器自装 MySQL，在浏览器里查看、查询与备份。
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
            <Plus size={16} /> 新建数据库连接
          </button>
        </div>

        {scheduler && (
          <div className="db-scheduler-banner">
            <div>
              <strong>定时备份已启用</strong>
              <span>
                {scheduler.schedule} · 保留 {scheduler.retentionDays} 天 ·
                最近备份 {timeAgo(scheduler.lastBackupAt)}
              </span>
            </div>
            <button
              type="button"
              className="button secondary compact"
              disabled={backupRunning}
              onClick={() => void runBackupNow()}
            >
              {backupRunning ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <HardDrive size={14} />
              )}
              立即执行一次备份
            </button>
          </div>
        )}

        {loading && (
          <div className="db-loading">
            <LoaderCircle size={20} className="spin" />
            <span>正在读取连接列表</span>
          </div>
        )}

        {!loading && connections.length === 0 && (
          <div className="db-empty">
            <div className="db-empty-icon">
              <Database size={26} />
            </div>
            <h4>还没有数据库连接</h4>
            <p>
              点“新建数据库连接”，选择下面两种方式之一即可开始：
            </p>
            <div className="db-empty-cards">
              <div>
                <Cloud size={18} />
                <strong>云厂商云数据库</strong>
                <small>
                  TencentDB、RDS、GaussDB 等，在云控制台拿到内网/外网地址、
                  端口和账号后，在安全组里允许你电脑的 IP 访问 3306。
                </small>
              </div>
              <div>
                <Server size={18} />
                <strong>服务器自装 MySQL</strong>
                <small>
                  云服务器上自己安装的 MySQL。建议勾选“SSH 隧道”，
                  数据库地址填 127.0.0.1，服务器地址填公网 IP，不暴露数据库端口。
                </small>
              </div>
            </div>
            <p className="db-secret-note">
              <ShieldCheck size={15} />
              数据库密码会加密后保存在本机 AI DevOps 的数据目录中，不会出现在日志里。
            </p>
          </div>
        )}

        {!loading && connections.length > 0 && (
          <div className="db-connection-grid">
            {connections.map((connection) => (
              <article className="db-connection-card" key={connection.id}>
                <div className="db-card-head">
                  <div
                    className={`db-kind-icon ${
                      connection.kind === "cloud_managed" ? "cloud" : "server"
                    }`}
                  >
                    {connection.kind === "cloud_managed" ? (
                      <Cloud size={19} />
                    ) : (
                      <Server size={19} />
                    )}
                  </div>
                  <div className="db-card-title">
                    <strong>{connection.name}</strong>
                    <span>
                      {VENDOR_LABELS[connection.vendor]} ·{" "}
                      {KIND_LABELS[connection.kind]}
                    </span>
                  </div>
                  <span
                    className={`db-status ${
                      connection.status === "connected"
                        ? "ok"
                        : connection.status === "error"
                          ? "bad"
                          : ""
                    }`}
                  >
                    <i />
                    {connection.status === "connected"
                      ? "已连通"
                      : connection.status === "error"
                        ? "连接异常"
                        : "未测试"}
                  </span>
                </div>

                <dl className="db-card-meta">
                  <div>
                    <dt>地址</dt>
                    <dd>
                      {connection.host}:{connection.port}
                    </dd>
                  </div>
                  <div>
                    <dt>账号</dt>
                    <dd>{connection.username}</dd>
                  </div>
                  <div>
                    <dt>连接方式</dt>
                    <dd>
                      {connection.useSsh
                        ? `SSH 隧道（${connection.sshHost}）`
                        : connection.ssl
                          ? "直连 · SSL"
                          : "直连"}
                    </dd>
                  </div>
                </dl>

                <p className="db-card-status-line">
                  {connection.statusMessage} · 上次检查 {timeAgo(connection.lastCheckedAt)}
                </p>

                <div className="db-card-actions">
                  <button
                    type="button"
                    className="button primary compact"
                    onClick={() => setActive(connection)}
                  >
                    <Database size={14} /> 管理
                  </button>
                  <button
                    type="button"
                    className="button secondary compact"
                    disabled={testingId === connection.id}
                    onClick={() => void testConnection(connection)}
                  >
                    {testingId === connection.id ? (
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
                      setEditing(connection);
                      setModalOpen(true);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    title="删除连接"
                    onClick={() => void removeConnection(connection)}
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
              默认只允许查询语句；修改数据的语句（增删改、建表等）需要勾选确认。
              高危语句（导入文件、关机等）被直接禁止。所有操作都会进入审计中心。
            </p>
          </div>
        </div>
      </section>

      {modalOpen && (
        <ConnectionFormModal
          connection={editing}
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

function ConnectionFormModal({
  connection,
  onClose,
  onSaved,
  onError,
}: {
  connection: DbConnection | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(connection?.name ?? "");
  const [kind, setKind] = useState<DbConnection["kind"]>(
    connection?.kind ?? "cloud_managed",
  );
  const [vendor, setVendor] = useState<DbConnection["vendor"]>(
    connection?.vendor ?? "tencent",
  );
  const [host, setHost] = useState(connection?.host ?? "");
  const [port, setPort] = useState(String(connection?.port ?? 3306));
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [defaultDatabase, setDefaultDatabase] = useState(
    connection?.defaultDatabase ?? "",
  );
  const [ssl, setSsl] = useState(connection?.ssl ?? false);
  const [useSsh, setUseSsh] = useState(connection?.useSsh ?? false);
  const [sshHost, setSshHost] = useState(connection?.sshHost ?? "");
  const [sshPort, setSshPort] = useState(String(connection?.sshPort ?? 22));
  const [sshUsername, setSshUsername] = useState(
    connection?.sshUsername ?? "",
  );
  const [sshPassword, setSshPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (useSsh && !connection && !sshPassword) {
      setFormError("使用 SSH 隧道时需要填写 SSH 密码。");
      return;
    }
    setSubmitting(true);
    try {
      const path = connection
        ? `/api/db/connections/${connection.id}`
        : "/api/db/connections";
      const method = connection ? "PATCH" : "POST";
      await api<{ connection: DbConnection }>(path, {
        method,
        body: JSON.stringify({
          name,
          kind,
          vendor,
          host,
          port: Number(port),
          username,
          password,
          defaultDatabase,
          ssl,
          useSsh,
          sshHost,
          sshPort: Number(sshPort),
          sshUsername,
          sshPassword,
        }),
      });
      await onSaved(connection ? "连接配置已更新。" : "数据库连接已创建。");
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
            <p className="eyebrow">DATABASE CONNECTION</p>
            <h2>{connection ? "编辑数据库连接" : "新建数据库连接"}</h2>
            <p>配置一次，之后在浏览器里管理、查询和备份。</p>
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
            连接名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 官网生产库 / 订单测试库"
              required
            />
          </label>

          <label>
            数据库类型
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as DbConnection["kind"])
              }
            >
              <option value="cloud_managed">
                云厂商云数据库（TencentDB / RDS / GaussDB 等）
              </option>
              <option value="self_hosted">云服务器上自装的 MySQL</option>
            </select>
          </label>

          <label>
            所属云厂商
            <select
              value={vendor}
              onChange={(event) =>
                setVendor(event.target.value as DbConnection["vendor"])
              }
            >
              <option value="tencent">腾讯云</option>
              <option value="aliyun">阿里云</option>
              <option value="huawei">华为云</option>
              <option value="other">其他 / 自建机房</option>
            </select>
          </label>

          <div className="db-form-row">
            <label>
              数据库地址
              <input
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder={kind === "self_hosted" ? "127.0.0.1" : "例如 cdb-xxx.sql.tencentcdb.com"}
                required
              />
            </label>
            <label className="db-port">
              端口
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
              数据库账号
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="例如 root / app_user"
                required
              />
            </label>
            <label>
              数据库密码
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={connection ? "留空表示不修改" : "输入数据库密码"}
              />
            </label>
          </div>

          <label>
            默认数据库（可选）
            <input
              value={defaultDatabase}
              onChange={(event) => setDefaultDatabase(event.target.value)}
              placeholder="连接后默认打开哪个库，可留空"
            />
          </label>

          <label className="db-check">
            <input
              type="checkbox"
              checked={ssl}
              onChange={(event) => setSsl(event.target.checked)}
            />
            <span>
              使用 SSL 加密连接
              <small>云厂商云数据库通常需要开启，服务器自装一般不需要</small>
            </span>
          </label>

          {kind === "self_hosted" && (
            <>
              <label className="db-check">
                <input
                  type="checkbox"
                  checked={useSsh}
                  onChange={(event) => setUseSsh(event.target.checked)}
                />
                <span>
                  通过 SSH 隧道连接（推荐）
                  <small>
                    数据库端口不暴露公网，密码和流量都走加密隧道，更安全
                  </small>
                </span>
              </label>

              {useSsh && (
                <>
                  <div className="db-form-row">
                    <label>
                      服务器地址（公网 IP）
                      <input
                        value={sshHost}
                        onChange={(event) => setSshHost(event.target.value)}
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
                        value={sshPort}
                        onChange={(event) => setSshPort(event.target.value)}
                        required
                      />
                    </label>
                  </div>
                  <div className="db-form-row">
                    <label>
                      SSH 用户名
                      <input
                        value={sshUsername}
                        onChange={(event) => setSshUsername(event.target.value)}
                        placeholder="例如 root / ubuntu"
                        required
                      />
                    </label>
                    <label>
                      SSH 密码
                      <input
                        type="password"
                        value={sshPassword}
                        onChange={(event) => setSshPassword(event.target.value)}
                        placeholder={connection ? "留空表示不修改" : "输入服务器登录密码"}
                        required={!connection}
                      />
                    </label>
                  </div>
                  <p className="field-hint db-ssh-hint">
                    提示：勾选 SSH 隧道后，上面“数据库地址”请填 127.0.0.1
                    （即数据库在服务器本机），端口填 MySQL 实际端口。
                  </p>
                </>
              )}
            </>
          )}

          {kind === "cloud_managed" && (
            <p className="field-hint db-ssh-hint">
              提示：请在云控制台的安全组 / 白名单中，允许你当前电脑的公网 IP
              访问数据库端口（通常是 3306）。地址和账号可在云数据库实例详情页找到。
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
              {connection ? "保存修改" : "保存并完成"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ConnectionDetail({
  connection,
  onBack,
  onError,
  notify,
  onTested,
}: {
  connection: DbConnection;
  onBack: () => void;
  onError: (error: unknown) => void;
  notify: (message: string, tone?: "success" | "error") => void;
  onTested: () => void;
}) {
  const [tab, setTab] = useState<"browse" | "sql" | "backups">("browse");
  const [databases, setDatabases] = useState<DbDatabaseInfo[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(true);
  const [selectedDb, setSelectedDb] = useState("");
  const [tables, setTables] = useState<DbTableInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTable, setSelectedTable] = useState("");
  const [tableDetail, setTableDetail] = useState<DbTableDetail | null>(null);
  const [loadingTable, setLoadingTable] = useState(false);
  const [backups, setBackups] = useState<DbBackup[]>([]);
  const [testing, setTesting] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  const [sqlDb, setSqlDb] = useState(connection.defaultDatabase);
  const [sqlText, setSqlText] = useState("");
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [runningSql, setRunningSql] = useState(false);
  const [queryResult, setQueryResult] = useState<DbQueryResult | null>(null);
  const [queryError, setQueryError] = useState("");
  const sqlEditorHostRef = useRef<HTMLDivElement | null>(null);
  const sqlEditorViewRef = useRef<EditorView | null>(null);

  async function loadDatabases() {
    setLoadingDbs(true);
    try {
      const response = await api<{ databases: DbDatabaseInfo[] }>(
        `/api/db/connections/${connection.id}/databases`,
      );
      setDatabases(response.databases);
      const preferred =
        connection.defaultDatabase ||
        response.databases.find((item) => !item.system)?.name ||
        "";
      setSelectedDb((current) => current || preferred);
      if (!sqlDb && preferred) setSqlDb(preferred);
    } catch (error) {
      onError(error);
    } finally {
      setLoadingDbs(false);
    }
  }

  async function loadBackups() {
    try {
      const response = await api<{ backups: DbBackup[] }>("/api/db/backups");
      setBackups(response.backups);
    } catch (error) {
      onError(error);
    }
  }

  useEffect(() => {
    void loadDatabases();
    void loadBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab !== "sql" || !sqlEditorHostRef.current) return;
    const view = new EditorView({
      doc: sqlText,
      parent: sqlEditorHostRef.current,
      extensions: [
        basicSetup,
        sql({ dialect: MySQL, upperCaseKeywords: true }),
        autocompletion({ activateOnTyping: true }),
        oneDark,
        EditorView.lineWrapping,
        placeholder("在这里输入 SQL，例如：SELECT * FROM users LIMIT 20;\n按 Ctrl+空格 可调出补全提示。"),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setSqlText(update.state.doc.toString());
          }
        }),
      ],
    });
    sqlEditorViewRef.current = view;
    return () => {
      view.destroy();
      sqlEditorViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function selectDatabase(name: string) {
    setSelectedDb(name);
    setSelectedTable("");
    setTableDetail(null);
    setLoadingTables(true);
    try {
      const response = await api<{ tables: DbTableInfo[] }>(
        `/api/db/connections/${connection.id}/databases/${encodeURIComponent(
          name,
        )}/tables`,
      );
      setTables(response.tables);
    } catch (error) {
      onError(error);
    } finally {
      setLoadingTables(false);
    }
  }

  async function openTable(name: string) {
    setSelectedTable(name);
    setLoadingTable(true);
    try {
      const response = await api<{ table: DbTableDetail }>(
        `/api/db/connections/${connection.id}/databases/${encodeURIComponent(
          selectedDb,
        )}/tables/${encodeURIComponent(name)}`,
      );
      setTableDetail(response.table);
    } catch (error) {
      onError(error);
    } finally {
      setLoadingTable(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const result = await api<{ version: string }>(
        `/api/db/connections/${connection.id}/test`,
        { method: "POST" },
      );
      onTested();
      notify(`连接成功：MySQL ${result.version}。`);
    } catch (error) {
      onError(error);
    } finally {
      setTesting(false);
    }
  }

  async function backupDatabase(name: string) {
    setBackingUp(true);
    try {
      await api(
        `/api/db/connections/${connection.id}/databases/${encodeURIComponent(
          name,
        )}/backup`,
        { method: "POST" },
      );
      await loadBackups();
      notify(`数据库 ${name} 已备份到本机数据目录。`);
    } catch (error) {
      onError(error);
    } finally {
      setBackingUp(false);
    }
  }

  async function runQuery() {
    setRunningSql(true);
    setQueryError("");
    setQueryResult(null);
    try {
      const response = await api<{ result: DbQueryResult }>(
        `/api/db/connections/${connection.id}/query`,
        {
          method: "POST",
          body: JSON.stringify({
            database: sqlDb,
            sql: sqlText,
            confirmWrite,
          }),
        },
      );
      setQueryResult(response.result);
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : "执行失败。");
    } finally {
      setRunningSql(false);
    }
  }

  async function removeBackup(backup: DbBackup) {
    const confirmed = window.confirm(
      `确定删除备份“${backup.filename}”吗？备份文件会被移除。`,
    );
    if (!confirmed) return;
    try {
      await api(`/api/db/backups/${backup.id}`, { method: "DELETE" });
      await loadBackups();
      notify("备份已删除。");
    } catch (error) {
      onError(error);
    }
  }

  async function restoreBackup(backup: DbBackup) {
    const target = window.prompt(
      `恢复备份到哪个数据库？（原库名为 ${backup.database}）`,
      backup.database,
    );
    if (!target) return;
    const confirmed = window.confirm(
      `将把备份“${backup.filename}”恢复到数据库“${target}”，` +
        `该库中同名表会被覆盖。确定继续吗？`,
    );
    if (!confirmed) return;
    try {
      await api(`/api/db/backups/${backup.id}/restore`, {
        method: "POST",
        body: JSON.stringify({ targetDatabase: target }),
      });
      notify(`已恢复到数据库 ${target}。`);
      void loadDatabases();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="content-page">
      <section className="panel db-detail-panel">
        <div className="db-detail-head">
          <button type="button" className="button ghost compact" onClick={onBack}>
            <ChevronLeft size={15} /> 返回连接列表
          </button>
          <div className="db-detail-title">
            <div
              className={`db-kind-icon ${
                connection.kind === "cloud_managed" ? "cloud" : "server"
              }`}
            >
              {connection.kind === "cloud_managed" ? (
                <Cloud size={18} />
              ) : (
                <Server size={18} />
              )}
            </div>
            <div>
              <h3>{connection.name}</h3>
              <p>
                {connection.host}:{connection.port} · {connection.username} ·{" "}
                {connection.useSsh ? "SSH 隧道" : connection.ssl ? "SSL 直连" : "直连"}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="button secondary compact"
            disabled={testing}
            onClick={() => void testConnection()}
          >
            {testing ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            测试连接
          </button>
        </div>

        <div className="db-tabs">
          <button
            type="button"
            className={tab === "browse" ? "active" : ""}
            onClick={() => setTab("browse")}
          >
            <Database size={15} /> 库表浏览
          </button>
          <button
            type="button"
            className={tab === "sql" ? "active" : ""}
            onClick={() => setTab("sql")}
          >
            <Play size={15} /> SQL 工作台
          </button>
          <button
            type="button"
            className={tab === "backups" ? "active" : ""}
            onClick={() => {
              setTab("backups");
              void loadBackups();
            }}
          >
            <HardDrive size={15} /> 备份与恢复
          </button>
        </div>

        {tab === "browse" && (
          <div className="db-browse">
            <aside className="db-side">
              <div className="db-side-head">
                <strong>数据库</strong>
                <button
                  type="button"
                  className="icon-button"
                  title="刷新数据库列表"
                  onClick={() => void loadDatabases()}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              {loadingDbs && (
                <div className="db-loading small">
                  <LoaderCircle size={16} className="spin" />
                  <span>读取中</span>
                </div>
              )}
              {!loadingDbs &&
                databases.map((item) => (
                  <button
                    type="button"
                    key={item.name}
                    className={
                      selectedDb === item.name ? "active" : ""
                    }
                    onClick={() => void selectDatabase(item.name)}
                  >
                    <Database size={14} />
                    <span>{item.name}</span>
                    {item.system && <em>系统</em>}
                  </button>
                ))}
              {!loadingDbs && databases.length === 0 && (
                <p className="db-side-empty">没有可显示的数据库。</p>
              )}
              {selectedDb && (
                <button
                  type="button"
                  className="db-backup-button"
                  disabled={backingUp}
                  onClick={() => void backupDatabase(selectedDb)}
                >
                  {backingUp ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <HardDrive size={14} />
                  )}
                  备份此数据库
                </button>
              )}
            </aside>

            <div className="db-main">
              {!selectedDb && (
                <div className="db-placeholder">
                  <Database size={24} />
                  <p>从左侧选择一个数据库，查看里面的表。</p>
                </div>
              )}

              {selectedDb && !selectedTable && (
                <>
                  <div className="db-main-head">
                    <div>
                      <strong>{selectedDb}</strong>
                      <small>共 {tables.length} 个表 / 视图</small>
                    </div>
                    <button
                      type="button"
                      className="button secondary compact"
                      onClick={() => void selectDatabase(selectedDb)}
                    >
                      <RefreshCw size={13} /> 刷新
                    </button>
                  </div>
                  {loadingTables && (
                    <div className="db-loading">
                      <LoaderCircle size={18} className="spin" />
                      <span>正在读取表列表</span>
                    </div>
                  )}
                  {!loadingTables && (
                    <div className="data-table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>表名</th>
                            <th>类型</th>
                            <th>引擎</th>
                            <th>行数（约）</th>
                            <th>大小</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {tables.map((table) => (
                            <tr
                              key={table.name}
                              className="clickable-row"
                              onClick={() => void openTable(table.name)}
                            >
                              <td>
                                <strong>{table.name}</strong>
                              </td>
                              <td>{table.type === "VIEW" ? "视图" : "数据表"}</td>
                              <td>{table.engine || "—"}</td>
                              <td>{table.rows.toLocaleString()}</td>
                              <td>{formatBytes(table.sizeBytes)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="button ghost compact"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void openTable(table.name);
                                  }}
                                >
                                  查看
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {selectedDb && selectedTable && (
                <TableDetailView
                  table={selectedTable}
                  detail={tableDetail}
                  loading={loadingTable}
                  onBack={() => {
                    setSelectedTable("");
                    setTableDetail(null);
                  }}
                />
              )}
            </div>
          </div>
        )}

        {tab === "sql" && (
          <div className="db-sql">
            <div className="db-sql-head">
              <label>
                目标数据库
                <select
                  value={sqlDb}
                  onChange={(event) => setSqlDb(event.target.value)}
                >
                  <option value="">— 请选择 —</option>
                  {databases.map((item) => (
                    <option value={item.name} key={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="db-check inline">
                <input
                  type="checkbox"
                  checked={confirmWrite}
                  onChange={(event) => setConfirmWrite(event.target.checked)}
                />
                <span>
                  我确认执行写操作（增删改、建表等）
                  <small>查询语句无需勾选；勾选前请确认影响范围</small>
                </span>
              </label>
              <button
                type="button"
                className="button primary"
                disabled={runningSql || !sqlText.trim() || !sqlDb}
                onClick={() => void runQuery()}
              >
                {runningSql ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Play size={15} />
                )}
                执行
              </button>
            </div>

            <div className="db-sql-editor" ref={sqlEditorHostRef} />

            <p className="db-sql-hint">
              <TriangleAlert size={14} />
              默认只允许查询；修改数据的语句需要勾选“确认写操作”。
              结果最多显示 500 行。导入导出文件、关机等高危语句被禁止。
            </p>

            {queryError && <p className="form-error db-query-error">{queryError}</p>}

            {queryResult?.kind === "resultset" && (
              <div className="data-table-wrap db-result">
                <div className="db-result-head">
                  <strong>查询结果</strong>
                  <span>
                    {queryResult.rows.length} 行 · {queryResult.elapsedMs} ms
                    {queryResult.truncated && " · 结果已截断（最多 500 行）"}
                  </span>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      {queryResult.columns.map((column) => (
                        <th key={column.name}>{column.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryResult.rows.map((row, index) => (
                      <tr key={index}>
                        {queryResult.columns.map((column) => (
                          <td key={column.name}>{cellText(row[column.name])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {queryResult?.kind === "executed" && (
              <div className="db-executed">
                <Check size={16} />
                <span>
                  执行成功：影响 {queryResult.affectedRows} 行
                  {queryResult.changedRows > 0 && `，实际修改 ${queryResult.changedRows} 行`}
                  {" · "}
                  {queryResult.elapsedMs} ms
                </span>
              </div>
            )}
          </div>
        )}

        {tab === "backups" && (
          <div className="db-backups">
            <div className="db-main-head">
              <div>
                <strong>备份记录</strong>
                <small>
                  备份文件保存在本机 AI DevOps 的 data\backups 目录，可在“库表浏览”里创建新备份
                </small>
              </div>
              <button
                type="button"
                className="button secondary compact"
                onClick={() => void loadBackups()}
              >
                <RefreshCw size={13} /> 刷新
              </button>
            </div>
            {backups.length === 0 && (
              <div className="db-placeholder">
                <HardDrive size={24} />
                <p>还没有备份。到“库表浏览”选中数据库后点“备份此数据库”。</p>
              </div>
            )}
            {backups.length > 0 && (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>备份文件</th>
                      <th>所属连接</th>
                      <th>数据库</th>
                      <th>表数量</th>
                      <th>大小</th>
                      <th>创建时间</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((backup) => (
                      <tr key={backup.id}>
                        <td>
                          <strong>{backup.filename}</strong>
                        </td>
                        <td>{backup.connectionName}</td>
                        <td>{backup.database}</td>
                        <td>{backup.tableCount}</td>
                        <td>{formatBytes(backup.sizeBytes)}</td>
                        <td>{new Date(backup.createdAt).toLocaleString()}</td>
                        <td>
                          <div className="db-row-actions">
                            <button
                              type="button"
                              className="button ghost compact"
                              disabled={!connection}
                              onClick={() => void restoreBackup(backup)}
                            >
                              恢复
                            </button>
                            <button
                              type="button"
                              className="icon-button danger"
                              title="删除备份"
                              onClick={() => void removeBackup(backup)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TableDetailView({
  table,
  detail,
  loading,
  onBack,
}: {
  table: string;
  detail: DbTableDetail | null;
  loading: boolean;
  onBack: () => void;
}) {
  return (
    <div className="db-table-detail">
      <div className="db-main-head">
        <div>
          <strong>
            {table}
            {detail?.type === "view" && <em className="db-view-tag">视图</em>}
          </strong>
          <small>
            {detail
              ? `约 ${detail.rowCountHint.toLocaleString()} 行 · 显示前 100 行`
              : "正在读取结构"}
          </small>
        </div>
        <button type="button" className="button ghost compact" onClick={onBack}>
          <ChevronLeft size={14} /> 返回表列表
        </button>
      </div>

      {loading && (
        <div className="db-loading">
          <LoaderCircle size={18} className="spin" />
          <span>正在读取表数据</span>
        </div>
      )}

      {!loading && detail && (
        <>
          <div className="db-section-title">字段结构</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>类型</th>
                  <th>可空</th>
                  <th>键</th>
                  <th>默认值</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {detail.columns.map((column: DbColumnInfo) => (
                  <tr key={column.name}>
                    <td>
                      <strong>{column.name}</strong>
                    </td>
                    <td>{column.type}</td>
                    <td>{column.nullable ? "是" : "否"}</td>
                    <td>{column.key || "—"}</td>
                    <td>{column.defaultValue ?? "—"}</td>
                    <td>{column.comment || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="db-section-title">数据预览（前 100 行）</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {detail.columns.map((column) => (
                    <th key={column.name}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row, index) => (
                  <tr key={index}>
                    {detail.columns.map((column) => (
                      <td key={column.name}>{cellText(row[column.name])}</td>
                    ))}
                  </tr>
                ))}
                {detail.rows.length === 0 && (
                  <tr>
                    <td colSpan={Math.max(detail.columns.length, 1)}>
                      表中没有数据。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="db-section-title">建表语句</div>
          <pre className="db-ddl">{detail.ddl}</pre>
        </>
      )}
    </div>
  );
}

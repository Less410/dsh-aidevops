import {
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { ErrorEvent } from "./types";

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function buildReport(event: ErrorEvent): string {
  return [
    "【AI DevOps 错误报告】",
    `时间：${formatTime(event.createdAt)}`,
    `编号：${event.requestId}`,
    `接口：${event.method} ${event.path}`,
    `错误码：${event.code}`,
    `原因：${event.message}`,
    `操作人：${event.actor || "—"}`,
    "",
    "技术细节：",
    event.detail || "（无）",
    "",
    "请智能体根据以上信息帮我定位并解决问题。",
  ].join("\n");
}

export function ErrorDiagnosticsPage({
  onError,
  notify,
  refreshSignal,
}: {
  onError: (error: unknown) => void;
  notify: (message: string, tone?: "success" | "error") => void;
  refreshSignal: number;
}) {
  const [events, setEvents] = useState<ErrorEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState("");

  async function load() {
    try {
      const response = await api<{ events: ErrorEvent[] }>(
        "/api/errors?limit=100",
      );
      setEvents(response.events);
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

  async function copyReport(event: ErrorEvent) {
    const text = buildReport(event);
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
    setCopiedId(event.id);
    window.setTimeout(() => setCopiedId(""), 2_000);
  }

  async function clearAll() {
    const confirmed = window.confirm(
      "确定清空所有错误记录吗？清空后无法恢复。",
    );
    if (!confirmed) return;
    try {
      const response = await api<{ removed: number }>("/api/errors", {
        method: "DELETE",
      });
      setEvents([]);
      notify(`已清空 ${response.removed} 条错误记录。`);
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="content-page">
      <section className="panel db-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ERROR DIAGNOSTICS</p>
            <h3>错误记录</h3>
            <p className="panel-sub">
              平台每次报错都会留下编号、接口位置、原因和技术细节，方便定位问题。
            </p>
          </div>
          <div className="error-head-actions">
            <button
              type="button"
              className="button secondary compact"
              onClick={() => void load()}
            >
              <RefreshCw size={14} /> 刷新
            </button>
            <button
              type="button"
              className="button secondary compact"
              disabled={events.length === 0}
              onClick={() => void clearAll()}
            >
              <Trash2 size={14} /> 清空记录
            </button>
          </div>
        </div>

        {loading && (
          <div className="db-loading">
            <LoaderCircle size={20} className="spin" />
            <span>正在读取错误记录</span>
          </div>
        )}

        {!loading && events.length === 0 && (
          <div className="db-empty">
            <div className="db-empty-icon">
              <Check size={26} />
            </div>
            <h4>目前没有错误记录</h4>
            <p>一切正常。以后任何功能报错，都会自动记录在这里。</p>
          </div>
        )}

        {!loading && events.length > 0 && (
          <div className="error-event-list">
            {events.map((event) => (
              <article className="error-event-card" key={event.id}>
                <div className="error-event-head">
                  <span className="error-code-chip">{event.code}</span>
                  <code className="error-path">
                    {event.method} {event.path}
                  </code>
                  <span className="error-time">{formatTime(event.createdAt)}</span>
                </div>
                <p className="error-message">{event.message}</p>
                <div className="error-meta">
                  <span>编号 {event.requestId}</span>
                  <span>操作人 {event.actor || "—"}</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void copyReport(event)}
                  >
                    {copiedId === event.id ? (
                      <Check size={13} />
                    ) : (
                      <Copy size={13} />
                    )}
                    {copiedId === event.id ? "已复制" : "复制报告发给智能体"}
                  </button>
                </div>
                {event.detail && (
                  <details className="error-detail">
                    <summary>技术细节（给开发排查用）</summary>
                    <pre>{event.detail}</pre>
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel db-safety-panel">
        <div className="db-safety-copy">
          <ShieldCheck size={20} />
          <div>
            <strong>报错后你只需要做两件事</strong>
            <p>
              第一步：看错误记录里的“原因”，很多问题（网络不通、账号密码不对、
              端口没放行）会直接告诉你；第二步：如果看不懂，点“复制报告发给智能体”，
              把内容贴给 Codex / WorkBuddy 等研发工具，它们就能根据编号和技术细节定位问题。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

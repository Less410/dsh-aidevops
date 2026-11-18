import {
  Activity,
  BookOpen,
  Check,
  Clock3,
  Copy,
  ListChecks,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { PonytailStatus } from "./types";

type Mode = "off" | "lite" | "full" | "ultra";

const MODES: Array<{ id: Mode; label: string; note: string }> = [
  { id: "off", label: "Off", note: "停止精简约束，恢复普通模式" },
  { id: "lite", label: "Lite", note: "按需求开发，同时提示更小的方案" },
  { id: "full", label: "Full", note: "默认：以最小完整改动交付" },
  { id: "ultra", label: "Ultra", note: "先质疑需求，再决定是否值得开发" },
];

const SKILLS = [
  {
    id: "ponytail",
    label: "编码",
    summary: "按最小完整改动编写或修复代码。",
    when: "日常开发、重构、修 bug、选依赖。",
    needsTask: true,
  },
  {
    id: "ponytail-review",
    label: "变更审查",
    summary: "审查逻辑、安全、负载与测试，并读取相关代码。",
    when: "提交前、PR 审查、判断改动是否过度设计。",
    needsTask: true,
  },
  {
    id: "ponytail-audit",
    label: "全仓审计",
    summary: "只读扫描整个仓库的缺陷、风险、慢路径与冗余。",
    when: "接手旧项目、上线前体检、技术债盘点。",
    needsTask: true,
  },
  {
    id: "ponytail-debt",
    label: "捷径账本",
    summary: "列出代码中的 shortcut 与 ponytail 债务注释。",
    when: "迭代后核对哪些临时方案需要补完。",
    needsTask: true,
  },
  {
    id: "ponytail-gain",
    label: "节省数据",
    summary: "显示 Ponytail 官方基准中测得的代码、成本与速度收益。",
    when: "需要了解 Ponytail 的实际基准表现。",
    needsTask: false,
  },
  {
    id: "ponytail-help",
    label: "帮助",
    summary: "查看 Ponytail 的档位、Skill 与命令速查。",
    when: "忘记命令或不确认该选哪个 Skill。",
    needsTask: false,
  },
] as const;

function formatTime(value: string | null): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function buildCommand(
  skill: (typeof SKILLS)[number],
  mode: Mode,
  task: string,
): string {
  const base =
    skill.id === "ponytail"
      ? `$ponytail:ponytail ${mode}`
      : `$ponytail:${skill.id}`;
  const trimmedTask = task.trim();
  return skill.needsTask && trimmedTask ? `${base} ${trimmedTask}` : base;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("浏览器未允许复制。");
  }
}

export function PonytailPage({
  status,
  onRecord,
}: {
  status: PonytailStatus | null;
  onRecord: (skill: string, mode: Mode | null) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("full");
  const [selectedSkillId, setSelectedSkillId] =
    useState<(typeof SKILLS)[number]["id"]>("ponytail");
  const [task, setTask] = useState("");
  const [copied, setCopied] = useState(false);
  const selectedSkill =
    SKILLS.find((skill) => skill.id === selectedSkillId) ?? SKILLS[0];
  const command = buildCommand(selectedSkill, mode, task);
  const maxSkillCount = useMemo(
    () => Math.max(...Object.values(status?.bySkill ?? {}), 1),
    [status],
  );
  const installedSkills = new Set(status?.skills ?? []);

  async function handleCopy() {
    try {
      await copyText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      await onRecord(
        selectedSkill.id,
        selectedSkill.id === "ponytail" ? mode : null,
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "复制失败。");
    }
  }

  return (
    <div className="content-page ponytail-page">
      <section className="ponytail-hero">
        <div className="ponytail-hero-main">
          <span className="ponytail-mark">
            <Sparkles size={22} />
          </span>
          <div>
            <p className="eyebrow">PONYTAIL CONTROL</p>
            <h1>少写代码，完整解决问题。</h1>
            <p>
              选择工作档位和 Skill，生成可直接粘贴到 Codex 的命令。任务描述只留在当前页面，
              不会写入平台审计或会话数据。
            </p>
          </div>
        </div>
        <div
          className={`ponytail-install-state ${status?.complete ? "ready" : "warning"}`}
        >
          <span>{status?.complete ? <ShieldCheck size={16} /> : <Clock3 size={16} />}</span>
          <div>
            <strong>
              {status?.complete
                ? `Ponytail v${status.version ?? "—"} 已就绪`
                : status?.installed
                  ? "安装不完整"
                  : "未检测到 Ponytail"}
            </strong>
            <small>
              {status?.skills.length ?? 0} / {status?.expectedSkills.length ?? 6} Skills
              · 检查于 {formatTime(status?.checkedAt ?? null)}
            </small>
            <small
              className="ponytail-install-path"
              title={status?.location ?? undefined}
            >
              Skills 目录：{status?.location ?? "未检测到"}
            </small>
          </div>
        </div>
      </section>

      <section className="ponytail-workbench">
        <article className="panel ponytail-builder">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">COMMAND BUILDER</p>
              <h3>生成 Ponytail 命令</h3>
            </div>
            <span className="local-model-badge">本地生成</span>
          </div>

          <div className="ponytail-builder-body">
            <div className="ponytail-field">
              <div className="ponytail-field-title">
                <strong>工作档位</strong>
                <small>仅编码 Skill 使用档位</small>
              </div>
              <div className="ponytail-mode-grid">
                {MODES.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={mode === item.id ? "active" : ""}
                    onClick={() => setMode(item.id)}
                    disabled={selectedSkill.id !== "ponytail"}
                  >
                    <strong>{item.label}</strong>
                    <small>{item.note}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="ponytail-field">
              <div className="ponytail-field-title">
                <strong>选择 Skill</strong>
                <small>六个 Skill 与当前 Codex 安装状态同步</small>
              </div>
              <div className="ponytail-skill-grid">
                {SKILLS.map((skill) => {
                  const available = installedSkills.has(skill.id);
                  return (
                    <button
                      type="button"
                      key={skill.id}
                      className={selectedSkill.id === skill.id ? "active" : ""}
                      onClick={() => setSelectedSkillId(skill.id)}
                    >
                      <span>
                        {skill.id === "ponytail" ? (
                          <Terminal size={16} />
                        ) : skill.id.includes("audit") ||
                          skill.id.includes("review") ? (
                          <Search size={16} />
                        ) : skill.id.includes("debt") ? (
                          <ListChecks size={16} />
                        ) : (
                          <BookOpen size={16} />
                        )}
                      </span>
                      <div>
                        <strong>
                          {skill.label}
                          <i className={available ? "available" : "missing"}>
                            {available ? "可用" : "缺失"}
                          </i>
                        </strong>
                        <small>{skill.summary}</small>
                        <em>适合：{skill.when}</em>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="ponytail-field">
              <div className="ponytail-field-title">
                <strong>任务说明</strong>
                <small>
                  {selectedSkill.needsTask
                    ? "可选；随命令复制，但不会上传到 AI DevOps"
                    : "该 Skill 是单次信息展示，不需要任务说明"}
                </small>
              </div>
              {selectedSkill.needsTask ? (
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="例如：把设置页的保存逻辑改简单，并补一个关键测试"
                  rows={4}
                />
              ) : (
                <div className="ponytail-one-shot">
                  <Activity size={18} />
                  <span>{selectedSkill.summary}</span>
                </div>
              )}
            </div>

            <div className="ponytail-command-preview">
              <div>
                <span>将在 Codex 中复制</span>
                <code>{command}</code>
              </div>
              <button
                type="button"
                className="button primary"
                onClick={() => void handleCopy()}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "已复制" : "复制命令"}
              </button>
            </div>
          </div>
        </article>

        <aside className="ponytail-side">
          <article className="panel ponytail-usage-card">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">COMMAND SIGNAL</p>
                <h3>平台内命令活动</h3>
              </div>
              <Activity size={18} />
            </div>
            <div className="ponytail-period-grid">
              <div>
                <small>近 7 天</small>
                <strong>{status?.generatedCommands["7d"] ?? 0}</strong>
              </div>
              <div>
                <small>近 30 天</small>
                <strong>{status?.generatedCommands["30d"] ?? 0}</strong>
              </div>
              <div>
                <small>近 90 天</small>
                <strong>{status?.generatedCommands["90d"] ?? 0}</strong>
              </div>
            </div>
            <p className="ponytail-metric-note">
              统计口径：仅计算在 AI DevOps 中成功复制的命令，不代表 Codex 实际执行次数、
              Token 或费用。
            </p>
          </article>

          <article className="panel ponytail-skill-activity">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">SKILL MIX</p>
                <h3>近 90 天 Skill 使用分布</h3>
              </div>
            </div>
            <div className="ponytail-bars">
              {SKILLS.map((skill) => {
                const count = status?.bySkill[skill.id] ?? 0;
                return (
                  <div key={skill.id}>
                    <span>{skill.label}</span>
                    <i>
                      <b style={{ width: `${(count / maxSkillCount) * 100}%` }} />
                    </i>
                    <strong>{count}</strong>
                  </div>
                );
              })}
            </div>
          </article>

          <article className="panel ponytail-recent">
            <div className="panel-heading compact">
              <div>
                <p className="eyebrow">RECENT</p>
                <h3>最近复制</h3>
              </div>
            </div>
            {status?.recent.length ? (
              <div className="ponytail-recent-list">
                {status.recent.map((item, index) => (
                  <div key={`${item.createdAt}-${item.skill}-${index}`}>
                    <span>
                      {SKILLS.find((skill) => skill.id === item.skill)?.label ??
                        item.skill}
                    </span>
                    <small>{item.mode ? `${item.mode} 模式` : "单次执行"}</small>
                    <time>{formatTime(item.createdAt)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-inline">
                还没有平台内复制记录。复制上方命令后，这里和总览卡片会自动更新。
              </p>
            )}
          </article>
        </aside>
      </section>
    </div>
  );
}

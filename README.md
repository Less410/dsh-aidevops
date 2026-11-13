# dsh-ai-devops

English | [中文](#中文)

Bring an [AI DevOps](https://gitee.com/lees410/aidevops) control plane into **DeepSeek Harness** as native tools — no MCP client, no child process.

The plugin registers four `ai_devops_*` tools that call the platform's agent API (the same contract as the platform's MCP bridge). The control plane is expected locally or on your intranet, by default at `http://127.0.0.1:8787`.

- [What is AI DevOps?](#what-is-ai-devops)
- [Tools](#tools)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Usage examples](#usage-examples)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)
- [Development](#development)
- [Publishing to the community catalog](#publishing-to-the-community-catalog)
- [License](#license)

## What is AI DevOps?

[AI DevOps](https://gitee.com/lees410/aidevops) is a self-hosted, multi-cloud delivery and operations control plane for development teams. It brings repositories, applications, release pipelines, versions and rollbacks, cloud resources, databases, servers, incidents, approvals and audit into one browser workspace, so a small team can run the whole commit -> build -> deploy -> observe -> roll back loop without stitching together a cloud console, CI and a pile of scripts.

The platform is built around a few hard rules:

- **Control plane and execution plane are separate.** The web app, API and SQLite store never run repository scripts; build/test/deploy is meant for an isolated Runner. The current MVP uses simulated execution and marks it honestly.
- **Git and the cloud are the sources of truth.** The platform keeps references, cached inventory, pipeline state and audit events, not copies of your code or cloud credentials.
- **AI is read-mostly and writes are gated.** Agents can inspect state, analyze failures and submit delivery tasks. Production changes wait for an administrator's approval in the browser; agent tokens cannot approve, run cloud changes or read cloud secrets.
- **Everything is auditable.** Each action is an append-only event with actor, target, result and trace id.

What the browser workspace covers: overview, code repositories, application management, releases and versions (deployment history, rollback, search and pagination), multi-cloud resources (Tencent Cloud, Alibaba Cloud, Huawei Cloud: servers, VPCs, security groups, domains, DNS and real CPU/memory metrics), database connections, server SSH terminals, AI Copilot, error diagnostics, the audit center, and platform settings with Agent Bridge/MCP configuration.

This plugin is the DSH-side adapter: it calls the platform's scoped agent API so the DeepSeek Harness agent can do those four read/deliver operations without an MCP client. The platform itself is installed separately (Windows start script, `pnpm`, or Docker Compose) and is not bundled with this package.

Read more: [architecture and security boundaries](https://gitee.com/lees410/aidevops/blob/master/docs/architecture.md) · [zero-code beginner guide](https://gitee.com/lees410/aidevops/blob/master/docs/beginner-guide.md).

## Tools

| Tool | Platform endpoint | What it does |
| --- | --- | --- |
| `ai_devops_health` | `GET /api/health` | Is the control plane online? Returns its version/service payload. No token needed. |
| `ai_devops_status` | `GET /api/agent/status` | The agent's own delivery/deployment records and status. Read-only. |
| `ai_devops_resources` | `GET /api/agent/resources` | Synced cloud resources with real CPU/memory metrics; optional `accountId` filter. Read-only. |
| `ai_devops_deliver` | `POST /api/agent/deliver` | Submit a delivery task. `development`/`staging` run automatically; `production` still needs an administrator's approval inside AI DevOps. |

### `ai_devops_health`

No parameters. Example result:

```json
{ "ok": true, "baseUrl": "http://127.0.0.1:8787",
  "platform": { "status": "ok", "service": "ai-devops-control-plane", "timestamp": "2026-11-12T02:46:52.795Z" } }
```

### `ai_devops_status`

No parameters. Returns the platform's agent status payload (the agent profile and the agent's delivery records, fields as returned by `/api/agent/status`).

### `ai_devops_resources`

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `accountId` | string | no | Cloud account id; omit to query every synced account |

Returns `{ ok, count, summary, resources }`. `summary` is a human-readable block per resource:

```text
aliyun / server / web-01
cn-hangzhou · 阿里云-已知 · running
CPU 12.5% · 内存 41.2% · 指标状态 ok · 采集 2026-11-12T02:40:00.000Z
```

### `ai_devops_deliver`

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `repositoryUrl` | string | yes | Repository HTTPS URL, e.g. `https://gitee.com/example/your-repo.git` |
| `repositoryName` | string | no | Repository name registered in AI DevOps |
| `appName` | string | no | Application name; created by the platform when missing |
| `serverId` / `serverName` / `serverHost` | string | no | Target server; omit to use the server bound to the repository |
| `environment` | string | no | `development`, `staging` (default) or `production` — production needs an administrator's approval |
| `description` | string | no | What this delivery is about |

Returns `{ ok, message, result }`, where `message` is the platform's own human-readable message and `result` is the raw platform response.

## Requirements

- An AI DevOps control plane reachable from this machine (default `http://127.0.0.1:8787`).
- An **agent token** created in AI DevOps: **平台设置 → 智能体对接 → 创建智能体令牌**. The token is scoped to agent endpoints; it cannot approve, run cloud changes, read cloud secrets or change platform settings.
- DeepSeek Harness `0.2.x` (tested with desktop `0.2.2-rc.1`, `@deepseek-ai/dsh-tools` `0.2.2-rc.1`) and Node.js `>= 20`.

## Install

From npm (after publishing):

```sh
dsh plugin --profile <your-profile> add dsh-ai-devops
```

From GitHub:

```sh
dsh plugin --profile <your-profile> add github:Less410/dsh-aidevops
```

On DSH Desktop: open **Plugins**, search for `dsh-ai-devops`, install, then restart the host once so the bundle loads.

## Configure

Set environment variables for the DSH host process:

```text
AI_DEVOPS_URL=http://127.0.0.1:8787
AI_DEVOPS_AGENT_TOKEN=aid_xxxxxxxxxxxxxxxx
```

Or configure the bundle row directly in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-ai-devops
  name: 'dsh-ai-devops'
  config:
    baseUrl: http://127.0.0.1:8787
    token: !!js process.env.AI_DEVOPS_AGENT_TOKEN
```

The row config takes precedence; environment variables are the fallback. The base URL defaults to `http://127.0.0.1:8787`. A token is only required by `ai_devops_status`, `ai_devops_resources` and `ai_devops_deliver` — `ai_devops_health` works without one.

## Usage examples

Once the plugin is loaded, ask the agent in plain language:

- "Is the AI DevOps control plane online?" → `ai_devops_health`
- "What is the status of the delivery task I submitted earlier?" → `ai_devops_status`
- "List the servers and their real CPU/memory across my cloud accounts." → `ai_devops_resources`
- "The code is committed, pushed and verified locally — deliver your-app to staging." → `ai_devops_deliver`

The agent must not call `ai_devops_deliver` on its own: delivery is explicit-request only, and production always waits for a human approval in the AI DevOps browser.

## Security

- `ai_devops_health`, `ai_devops_status` and `ai_devops_resources` are strictly read-only.
- `ai_devops_deliver` only acts when the user explicitly asks for a delivery; it never approves a deployment and never touches cloud credentials. Production deliveries still require human approval in the AI DevOps browser.
- The agent token travels as an `Authorization: Bearer` header to your control plane only. Nothing is sent anywhere else.
- DSH tool approval / permission presets still apply to every call.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `未配置 AI DevOps 智能体令牌` | Set `AI_DEVOPS_AGENT_TOKEN`, or `config.token` on the plugin row. Create the token in AI DevOps → 平台设置 → 智能体对接. |
| `无法连接 AI DevOps（...）：fetch failed` | The control plane is not running or `AI_DEVOPS_URL` is wrong. Start it (`start-ai-devops.ps1`) and check `/api/health` in a browser first. |
| `请求失败（HTTP 401）` / token rejected | The token was revoked or belongs to another deployment. Revoke it in the platform and create a new one. |
| `production` delivery stays pending | Production deliveries are human-in-the-loop by design. Approve it in the AI DevOps browser; the agent cannot approve. |
| Tools never appear in a conversation | The bundle did not load: check **Plugins** in DSH, confirm the `dsh-ai-devops` row exists in the profile, then restart the host. |
| Delivery rejected because the repository is unknown | Register the repository in AI DevOps first, or pass `appName` / `serverName` explicitly. |

## Compatibility

- Tested with DeepSeek Harness `0.2.2-rc.1` (desktop bundle `@deepseek-ai/dsh-desktop` / `@deepseek-ai/dsh-tools` `0.2.2-rc.1`).
- `@deepseek-ai/dsh-tools` is a **peer dependency** supplied by the host; the published package never bundles a second copy of the host core packages.
- Supports Linux, macOS and Windows hosts. Node.js `>= 20` is required (`fetch` and `AbortSignal.timeout`).

## Development

The plugin registers its tools with `defineTool` from `@deepseek-ai/dsh-tools`. That package is a **peer dependency** supplied by the DSH host at runtime; the published package only ships `index.js`, `cordis.patch.yml`, `README.md` and `LICENSE`.

```sh
npm install          # installs the dev peer (@deepseek-ai/dsh-tools) for tests
npm test             # unit tests: stubbed fetch, tool specs and schemas, no network
npm run smoke        # integration: real cordis Context + ToolsService + live platform
```

`npm run smoke` needs a running AI DevOps control plane and an agent token:

```sh
AI_DEVOPS_URL=http://127.0.0.1:8787 AI_DEVOPS_AGENT_TOKEN=aid_xxx npm run smoke
```

It asserts that the four tools register, that the model-facing JSON Schema is valid (including the `environment` enum), that `ai_devops_health` reaches the platform, and that disposing the plugin unregisters every tool.

## Publishing to the community catalog

See [docs/market-submission.md](docs/market-submission.md) for the GitHub repository setup and the one-file PR (`data/plugins/<owner>__dsh-ai-devops.yml`) that lists this plugin in the DSH plugin market.

## License

MIT

-----

## 中文

把 **AI DevOps** 控制面（默认 `http://127.0.0.1:8787`，源码 [gitee.com/lees410/aidevops](https://gitee.com/lees410/aidevops)）接入 **DeepSeek Harness**，注册 4 个原生 `ai_devops_*` 工具，不需要 MCP 客户端、不起子进程。接口契约与平台自带的 MCP 桥一致。

### AI DevOps 是什么

[AI DevOps](https://gitee.com/lees410/aidevops) 是一个可自托管的多云研发交付与运维控制面：把代码仓库、应用、发布流水线、版本与回滚、云资源、数据库、服务器、故障、审批和审计收进一个浏览器工作台，让小团队不必在云控制台、CI 和一堆脚本之间来回切换，就能跑完“提交 → 构建 → 发布 → 观测 → 回滚”的闭环。

平台的几条硬规则：

- **控制面与执行面分离**：Web、API 和 SQLite 不直接运行仓库脚本，构建/测试/发布由隔离 Runner 执行；当前 MVP 是模拟执行，平台会如实标注。
- **Git 与云是事实源**：平台只保存引用、缓存清单、流程状态和审计事件，不复制你的代码和云凭据。
- **AI 只读为主，写操作分级**：智能体能查询、分析故障、提交交付任务；生产变更必须由管理员在浏览器里审批，智能体令牌不能审批、不能执行云变更、不能读云密钥。
- **一切可审计**：每次操作都是 append-only 事件，记录操作者、对象、结果与 trace id。

浏览器工作台现有能力：总览、代码仓库、应用管理、发布与版本（部署历史、回滚、搜索与分页）、多云资源（腾讯云/阿里云/华为云：服务器、VPC、安全组、域名、DNS 和真实 CPU/内存指标）、数据库连接、服务器 SSH 终端、AI Copilot、故障诊断、审计中心，以及带 Agent Bridge/MCP 配置的平台设置。

本插件是 DSH 侧适配器：调用平台的受限智能体接口，让 DeepSeek Harness 智能体无需 MCP 客户端即可完成上述 4 个查询/交付操作。平台本身需单独安装（Windows 启动脚本、`pnpm` 或 Docker Compose），不包含在本插件包内。

延伸阅读：[架构与安全边界](https://gitee.com/lees410/aidevops/blob/master/docs/architecture.md) · [零代码使用指南](https://gitee.com/lees410/aidevops/blob/master/docs/beginner-guide.md)。

### 工具

| 工具 | 平台接口 | 作用 |
| --- | --- | --- |
| `ai_devops_health` | `GET /api/health` | 只读检查平台是否在线；不需要令牌 |
| `ai_devops_status` | `GET /api/agent/status` | 查询本智能体自己的交付/发布记录，只读 |
| `ai_devops_resources` | `GET /api/agent/resources` | 查询已同步云资源与真实 CPU/内存指标；可选 `accountId` 过滤，只读 |
| `ai_devops_deliver` | `POST /api/agent/deliver` | 提交交付任务；development/staging 自动执行，production 必须管理员在平台浏览器里审批 |

`ai_devops_resources` 参数：`accountId`（可选，云账号 ID）。返回 `{ ok, count, summary, resources }`，`summary` 是可直接展示的逐条资源摘要（资源名、区域、账号、状态、CPU/内存与采集时间）。

`ai_devops_deliver` 参数：`repositoryUrl`（必填，仓库 HTTPS 地址）、`repositoryName`、`appName`、`serverId`/`serverName`/`serverHost`、`environment`（`development`/`staging`/`production`，默认 staging）、`description`。返回 `{ ok, message, result }`，`message` 是平台给用户的自然语言结果。

### 前置条件

- 本机或内网可访问的 AI DevOps 控制面（默认 `http://127.0.0.1:8787`）。
- 在 AI DevOps「平台设置 → 智能体对接」里创建的**智能体令牌**。令牌只能调用智能体接口，不能审批、不能执行云变更、不能读取云密钥或修改平台设置。
- DeepSeek Harness `0.2.x`（实测桌面版 `0.2.2-rc.1`，`@deepseek-ai/dsh-tools` `0.2.2-rc.1`），Node.js `>= 20`。

### 安装

```sh
dsh plugin --profile <你的 profile> add dsh-ai-devops
# 或从 GitHub 安装：
dsh plugin --profile <你的 profile> add github:Less410/dsh-aidevops
```

DSH 桌面版：打开「插件」，搜索 `dsh-ai-devops` 安装，然后重启一次宿主让 bundle 生效。

### 配置

给 DSH 宿主进程设置环境变量：

```text
AI_DEVOPS_URL=http://127.0.0.1:8787
AI_DEVOPS_AGENT_TOKEN=aid_xxxxxxxxxxxxxxxx
```

也可以在 profile 的 `cordis.patch.yml` 里给 bundle 行写 config（优先于环境变量）：

```yaml
- id: dsh-ai-devops
  name: 'dsh-ai-devops'
  config:
    baseUrl: http://127.0.0.1:8787
    token: !!js process.env.AI_DEVOPS_AGENT_TOKEN
```

只有 `ai_devops_status`、`ai_devops_resources`、`ai_devops_deliver` 需要令牌；`ai_devops_health` 无令牌也能用。

### 使用示例

- "检查一下 AI DevOps 平台是否在线。" → `ai_devops_health`
- "看看我最近提交的发布任务现在什么状态。" → `ai_devops_status`
- "列一下腾讯云账号下所有服务器的真实 CPU 和内存。" → `ai_devops_resources`
- "代码已提交并推送、本地验证通过，帮我把 your-app 发到 staging。" → `ai_devops_deliver`

交付只在用户明确要求时调用；智能体不能自行审批，生产发布始终等人工审批。

### 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `未配置 AI DevOps 智能体令牌` | 设置 `AI_DEVOPS_AGENT_TOKEN` 或插件行 `config.token`；令牌在「平台设置 → 智能体对接」创建 |
| `无法连接 AI DevOps（...）：fetch failed` | 平台没启动或 `AI_DEVOPS_URL` 写错；先用浏览器确认 `/api/health` 可访问 |
| `请求失败（HTTP 401）` | 令牌已被撤销或属于别的部署；到平台重新创建 |
| production 交付一直待审批 | 生产发布是人工在环设计，需管理员在平台审批，智能体无法审批 |
| 对话里看不到这些工具 | bundle 没加载：在 DSH「插件」里确认已安装并重启宿主 |
| 提示仓库未登记 | 先在 AI DevOps 里登记仓库，或显式传 `appName` / `serverName` |

### 开发

插件用 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册工具；该包是 **peerDependency**，运行时由 DSH 宿主提供，发布包里不带它，也不会在 profile 里再装一份宿主核心包。

```sh
npm install   # 安装测试用的 dev 依赖
npm test      # 单元测试：mock fetch，不发网络请求
npm run smoke # 集成冒烟：真实 cordis Context + ToolsService + 运行中的平台
```

`npm run smoke` 需要平台在运行并配置 `AI_DEVOPS_AGENT_TOKEN`。

MIT License.

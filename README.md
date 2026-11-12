# dsh-ai-devops

English | [中文](#中文)

Bring an [AI DevOps](https://github.com/) control plane into **DeepSeek Harness** as native tools — no MCP client, no child process.

The plugin registers four `ai_devops_*` tools that call the platform's agent API:

| Tool | Platform endpoint | What it does |
| --- | --- | --- |
| `ai_devops_health` | `GET /api/health` | Is the control plane online? Returns its version/service payload. |
| `ai_devops_status` | `GET /api/agent/status` | The agent's own delivery/deployment records and status. Read-only. |
| `ai_devops_resources` | `GET /api/agent/resources` | Synced cloud resources with real CPU/memory metrics; optional `accountId` filter. Read-only. |
| `ai_devops_deliver` | `POST /api/agent/deliver` | Submit a delivery task. `development`/`staging` run automatically; `production` still needs an administrator's approval inside AI DevOps. |

## Requirements

- An AI DevOps control plane reachable from this machine (default `http://127.0.0.1:8787`).
- An **agent token** created in AI DevOps: **平台设置 → 智能体对接 → 创建智能体令牌**. The token is scoped to agent endpoints; it cannot approve, run cloud changes, read cloud secrets or change platform settings.

## Install

From npm (after publishing):

```sh
dsh plugin --profile <your-profile> add dsh-ai-devops
```

From GitHub:

```sh
dsh plugin --profile <your-profile> add github:OWNER/dsh-ai-devops
```

On DSH Desktop: open **Plugins**, search for `dsh-ai-devops`, install, then restart the host once so the bundle loads.

## Configure

Set environment variables for the DSH host process:

```
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

Both are optional: the base URL defaults to `http://127.0.0.1:8787` and the token may also be supplied through the plugin row config.

## Security

- `ai_devops_health`, `ai_devops_status` and `ai_devops_resources` are strictly read-only.
- `ai_devops_deliver` only acts when the user explicitly asks for a delivery; it never approves a deployment and never touches cloud credentials. Production deliveries still require human approval in the AI DevOps browser.
- The agent token travels as an `Authorization: Bearer` header to your control plane only. Nothing is sent anywhere else.
- DSH tool approval / permission presets still apply to every call.

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

See [docs/market-submission.md](docs/market-submission.md) for the GitHub repository setup and the one-file PR that lists this plugin in the DSH plugin market.

## License

MIT

-----

## 中文

把 **AI DevOps** 控制面接入 **DeepSeek Harness**，注册 4 个原生 `ai_devops_*` 工具，不需要 MCP 客户端、不起子进程。

### 前置条件

- 本机或内网可访问的 AI DevOps 控制面（默认 `http://127.0.0.1:8787`）。
- 在 AI DevOps「平台设置 → 智能体对接」里创建的**智能体令牌**。令牌只能调用智能体接口，不能审批、不能执行云变更、不能读取云密钥或修改平台设置。

### 安装

```sh
dsh plugin --profile <你的 profile> add dsh-ai-devops
# 或从 GitHub 安装：
dsh plugin --profile <你的 profile> add github:OWNER/dsh-ai-devops
```

### 配置

给 DSH 宿主进程设置：

```
AI_DEVOPS_URL=http://127.0.0.1:8787
AI_DEVOPS_AGENT_TOKEN=aid_xxxxxxxxxxxxxxxx
```

也可以在 profile 的 `cordis.patch.yml` 里给 bundle 行写 config（见上方英文示例）。

### 安全

- 三个工具只读；`ai_devops_deliver` 只在用户明确要求交付时调用，且不审批、不碰云密钥，生产发布仍需在 AI DevOps 浏览器里人工审批。
- 令牌只发往你自己配置的控制面。

### 开发

插件用 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册工具；该包是 **peerDependency**，运行时由 DSH 宿主提供，发布包里不带它。

```sh
npm install   # 安装测试用的 dev 依赖
npm test      # 单元测试：mock fetch，不发网络请求
npm run smoke # 集成冒烟：真实 cordis Context + ToolsService + 运行中的平台
```

`npm run smoke` 需要平台在运行并配置 `AI_DEVOPS_AGENT_TOKEN`。

MIT License.

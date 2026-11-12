/**
 * dsh-ai-devops — DeepSeek Harness host plugin.
 *
 * Registers native tools that talk to an AI DevOps control plane's agent API.
 * Same contract as the platform's MCP bridge (bridge/mcp/ai-devops-mcp.mjs),
 * but without an MCP client or a child process:
 *
 *   AI_DEVOPS_URL          control plane base URL (default http://127.0.0.1:8787)
 *   AI_DEVOPS_AGENT_TOKEN  agent token created in AI DevOps → 平台设置 → 智能体对接
 *
 * Both values may also come from the plugin row's config:
 *
 *   - id: dsh-ai-devops
 *     name: 'dsh-ai-devops'
 *     config:
 *       baseUrl: http://127.0.0.1:8787
 *       token: !!js process.env.AI_DEVOPS_AGENT_TOKEN
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-ai-devops'
export const inject = ['tools']

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const REQUEST_TIMEOUT_MS = 30_000
const ENVIRONMENTS = ['development', 'staging', 'production']

const TEXT_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
}

function envValue(key) {
  return typeof process !== 'undefined' && process.env ? process.env[key] ?? '' : ''
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim()
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function readOptions(config) {
  const options = config && typeof config === 'object' ? config : {}
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl ?? envValue('AI_DEVOPS_URL')),
    token: String(options.token ?? envValue('AI_DEVOPS_AGENT_TOKEN') ?? '').trim(),
  }
}

async function callApi(baseUrl, token, path, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    throw new Error(`无法连接 AI DevOps（${baseUrl}）：${reason}`)
  }
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && payload.message
        ? payload.message
        : `请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return payload
}

function requireToken(token) {
  if (!token) {
    throw new Error(
      '未配置 AI DevOps 智能体令牌：请设置环境变量 AI_DEVOPS_AGENT_TOKEN，或在 AI DevOps「平台设置 → 智能体对接」里创建一枚令牌。',
    )
  }
}

function formatMetrics(resource) {
  const metrics = resource && typeof resource === 'object' ? resource.metrics : null
  const cpu = typeof metrics?.cpuPercent === 'number' ? `${metrics.cpuPercent}%` : '暂无数据'
  const memory = typeof metrics?.memoryPercent === 'number' ? `${metrics.memoryPercent}%` : '暂无数据'
  return `CPU ${cpu} · 内存 ${memory} · 指标状态 ${metrics?.status ?? 'unavailable'} · 采集 ${metrics?.updatedAt ?? resource?.metricsUpdatedAt ?? '未知'}`
}

function formatResource(resource) {
  const lines = [
    `${resource.provider ?? 'unknown'} / ${resource.resourceType ?? 'unknown'} / ${resource.name ?? '未命名'}`,
    `${resource.region || '全局'} · ${resource.accountName ?? ''} · ${resource.status ?? 'unknown'}`,
    formatMetrics(resource),
  ]
  if (resource.metrics && resource.metrics.error) lines.push(`说明：${resource.metrics.error}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const { baseUrl, token } = readOptions(config)

  ctx.effect(
    () =>
      ctx.tools.register(defineTool({
        name: 'ai_devops_health',
        description:
          '只读检查 AI DevOps 平台是否在线（GET /api/health）。不能审批、不能执行云变更、不能读取云密钥或修改平台设置。',
        parameters: {},
        output: TEXT_OUTPUT,
        execute: async () => {
          const payload = await callApi(baseUrl, token, '/api/health')
          return { ok: true, baseUrl, platform: payload }
        },
      })),
    'dsh-ai-devops: health tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(defineTool({
        name: 'ai_devops_status',
        description:
          '只查询当前智能体自己在 AI DevOps 里的发布/交付记录与状态（GET /api/agent/status）。不能审批、不能执行云变更或修改平台设置。',
        parameters: {},
        output: TEXT_OUTPUT,
        execute: async () => {
          requireToken(token)
          const payload = await callApi(baseUrl, token, '/api/agent/status')
          return payload && typeof payload === 'object' ? payload : { result: payload }
        },
      })),
    'dsh-ai-devops: status tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(defineTool({
        name: 'ai_devops_resources',
        description:
          '只读查询 AI DevOps 已同步的云资源与真实 CPU/内存指标，可按云账号过滤（GET /api/agent/resources）。不能审批、不能执行云变更、不能读取云密钥或修改平台设置。',
        parameters: {
          accountId: { type: 'string', description: '云账号 ID；不填则查询全部已同步账号' },
        },
        output: TEXT_OUTPUT,
        execute: async (args) => {
          requireToken(token)
          const accountId = args && typeof args.accountId === 'string' ? args.accountId.trim() : ''
          const suffix = accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''
          const payload = await callApi(baseUrl, token, `/api/agent/resources${suffix}`)
          const resources = Array.isArray(payload?.resources) ? payload.resources : []
          if (resources.length === 0) {
            return { ok: true, count: 0, summary: '暂无已同步的云资源。' }
          }
          return {
            ok: true,
            count: resources.length,
            summary: resources.map(formatResource).join('\n\n'),
            resources,
          }
        },
      })),
    'dsh-ai-devops: resources tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(defineTool({
        name: 'ai_devops_deliver',
        description:
          '只在用户明确要求交付、代码已提交并推送、且本地已验证后，向 AI DevOps 提交交付任务（POST /api/agent/deliver）。目标服务器默认取仓库绑定的服务器；development/staging 自动执行，production 必须由管理员在 AI DevOps 浏览器里审批。智能体不能审批、不能执行云变更、不能读取云密钥或修改平台设置。',
        parameters: {
          repositoryUrl: {
            type: 'string',
            description: '仓库 HTTPS 地址，例如 https://gitee.com/example/your-repo.git',
          },
          repositoryName: { type: 'string', description: '平台里登记的仓库名称' },
          appName: { type: 'string', description: '应用名称；不存在时平台会自动创建' },
          serverId: { type: 'string', description: '目标服务器 ID；不填时按仓库绑定的服务器发布' },
          serverName: { type: 'string', description: '目标服务器名称；不填时按仓库绑定的服务器发布' },
          serverHost: { type: 'string', description: '目标服务器 IP；不填时按仓库绑定的服务器发布' },
          environment: {
            type: 'string',
            enum: ENVIRONMENTS,
            description: '发布环境，默认 staging；production 需要管理员在 AI DevOps 中审批',
          },
          description: { type: 'string', description: '本次发布的说明' },
        },
        output: TEXT_OUTPUT,
        execute: async (args) => {
          requireToken(token)
          const input = args && typeof args === 'object' ? args : {}
          const payload = await callApi(baseUrl, token, '/api/agent/deliver', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              repositoryUrl: input.repositoryUrl,
              repositoryName: input.repositoryName,
              appName: input.appName,
              serverId: input.serverId,
              serverName: input.serverName,
              serverHost: input.serverHost,
              environment: input.environment,
              description: input.description,
            }),
          })
          const message = payload && typeof payload === 'object' && typeof payload.message === 'string'
            ? payload.message
            : JSON.stringify(payload)
          return { ok: true, message, result: payload }
        },
      })),
    'dsh-ai-devops: deliver tool',
  )
}

/**
 * Integration smoke test: loads the plugin into a real cordis Context with the
 * real DSH ToolsService, checks the model-facing schemas, calls the live AI DevOps
 * health endpoint, and verifies tools are unregistered when the plugin is disposed.
 *
 * Needs a running AI DevOps control plane and an agent token:
 *
 *   AI_DEVOPS_URL=http://127.0.0.1:8787 \
 *   AI_DEVOPS_AGENT_TOKEN=aid_xxx \
 *   node scripts/integration-smoke.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as plugin from '../index.js'

const baseUrl = (process.env.AI_DEVOPS_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const token = (process.env.AI_DEVOPS_AGENT_TOKEN || '').trim()
if (!token) {
  console.error('AI_DEVOPS_AGENT_TOKEN is not set - skipping integration smoke test.')
  process.exit(1)
}

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolsService)

const fiber = await ctx.plugin(plugin, { baseUrl, token })

const defs = ctx.tools.definitions()
const names = defs.map((d) => d.name).sort()
console.log('registered:', names.join(','))
if (names.join(',') !== 'ai_devops_deliver,ai_devops_health,ai_devops_resources,ai_devops_status') {
  throw new Error('unexpected tool set: ' + names.join(','))
}

const deliver = ctx.tools.schemas().find((s) => s.name === 'ai_devops_deliver')
const environment = deliver?.parameters?.properties?.environment
if (deliver?.parameters?.type !== 'object' || environment?.enum?.length !== 3) {
  throw new Error('deliver parameters are not a model-ready JSON Schema')
}

const health = defs.find((d) => d.name === 'ai_devops_health')
const result = await health.execute({}, {})
console.log('health:', JSON.stringify({ ok: result.ok, baseUrl: result.baseUrl, platform: result.platform }).slice(0, 300))
if (!result.ok) throw new Error('health check failed')

await fiber.dispose()
if (ctx.tools.definitions().length !== 0) throw new Error('dispose did not unregister tools')
console.log('INTEGRATION SMOKE OK')

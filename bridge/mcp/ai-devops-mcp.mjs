import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (process.env.AI_DEVOPS_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = process.env.AI_DEVOPS_AGENT_TOKEN ?? "";

async function callApi(path, init = {}) {
  const headers = {
    ...(init.headers ?? {}),
    Authorization: `Bearer ${token}`,
  };
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && payload.message
        ? payload.message
        : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return payload;
}

const server = new McpServer({
  name: "ai-devops",
  version: "1.0.0",
});

server.registerTool(
  "ai_devops_deliver",
  {
    title: "AI DevOps 发布交付",
    description:
      "只在用户明确要求交付、代码已提交并推送、且本地已验证后提交交付任务。目标服务器默认取仓库绑定的服务器，可用 serverId/serverName/serverHost 覆盖，禁止盲发到别的服务器。development/staging 自动执行，production 必须由管理员在 AI DevOps 浏览器中审批。智能体不能审批、不能执行云变更、不能读取云密钥或修改平台设置。",
    inputSchema: {
      repositoryUrl: z.string().optional().describe("仓库 HTTPS 地址，例如 https://gitee.com/example/your-repo.git"),
      repositoryName: z.string().optional().describe("平台里登记的仓库名称"),
      appName: z.string().optional().describe("应用名称；不存在时平台会自动创建"),
      serverId: z.string().optional().describe("目标服务器 ID；不填时按仓库绑定的服务器发布"),
      serverName: z.string().optional().describe("目标服务器名称，例如“阿里云-示例”；不填时按仓库绑定的服务器发布"),
      serverHost: z.string().optional().describe("目标服务器 IP，例如 203.0.113.10；不填时按仓库绑定的服务器发布"),
      environment: z.enum(["development", "staging", "production"]).optional().describe("发布环境，默认 staging；production 需要管理员在 AI DevOps 中审批"),
      description: z.string().optional().describe("本次发布的说明"),
    },
  },
  async ({ repositoryUrl, repositoryName, appName, serverId, serverName, serverHost, environment, description }) => {
    if (!token) {
      return {
        content: [{ type: "text", text: "未配置 AI_DEVOPS_AGENT_TOKEN，请在 MCP 配置中设置智能体令牌。" }],
        isError: true,
      };
    }
    try {
      const result = await callApi("/api/agent/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryUrl,
          repositoryName,
          appName,
          serverId,
          serverName,
          serverHost,
          environment,
          description,
        }),
      });
      return {
        content: [{ type: "text", text: result.message ?? JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `交付失败：${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "ai_devops_status",
  {
    title: "AI DevOps 部署状态",
    description:
      "只查询当前智能体自己的发布/部署记录与状态。不能审批、不能执行云变更、不能读取云密钥或修改平台设置。",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await callApi("/api/agent/status");
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `查询失败：${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "ai_devops_health",
  {
    title: "AI DevOps 平台健康检查",
    description:
      "只读检查 AI DevOps 平台是否在线。不能审批、不能执行云变更、不能读取云密钥或修改平台设置。",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await callApi("/api/health");
      return {
        content: [{ type: "text", text: `AI DevOps 在线：${JSON.stringify(result)}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `AI DevOps 不可用：${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "ai_devops_resources",
  {
    title: "AI DevOps 已同步资源与指标",
    description:
      "只读查询平台已同步的云资源和真实 CPU/内存指标，可按云账号过滤。不能审批、不能执行云变更、不能读取云密钥或修改平台设置。",
    inputSchema: {
      accountId: z.string().min(1).max(100).optional().describe("云账号 ID；不填则查询全部已同步账号"),
    },
  },
  async ({ accountId }) => {
    try {
      const suffix = accountId
        ? `?accountId=${encodeURIComponent(accountId)}`
        : "";
      const result = await callApi(`/api/agent/resources${suffix}`);
      const resources = Array.isArray(result?.resources) ? result.resources : [];
      if (resources.length === 0) {
        return {
          content: [{ type: "text", text: "暂无已同步的云资源。" }],
        };
      }
      const text = resources
        .map((resource) => {
          const metrics = resource.metrics;
          const cpu =
            typeof metrics?.cpuPercent === "number"
              ? `${metrics.cpuPercent}%`
              : "暂无数据";
          const memory =
            typeof metrics?.memoryPercent === "number"
              ? `${metrics.memoryPercent}%`
              : "暂无数据";
          return [
            `${resource.provider} / ${resource.resourceType} / ${resource.name}`,
            `${resource.region || "全局"} · ${resource.accountName} · ${resource.status}`,
            `CPU ${cpu} · 内存 ${memory} · 指标状态 ${metrics?.status ?? "unavailable"} · 采集 ${metrics?.updatedAt ?? resource.metricsUpdatedAt ?? "未知"}`,
            ...(metrics?.error ? [`说明：${metrics.error}`] : []),
          ].join("\n");
        })
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `查询资源失败：${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

import { config, isLlmConfigured } from "./env.js";
import {
  getOverview,
  listCloudAccounts,
  listDeployments,
  type PipelineRunRecord,
} from "./db.js";

interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiResponse {
  message: string;
  mode: "local-analysis" | "model";
  proposals: Array<{
    id: string;
    title: string;
    risk: "low" | "medium" | "high";
    requiresApproval: boolean;
  }>;
}

function localAnalysis(message: string): AiResponse {
  const normalized = message.toLowerCase();
  const overview = getOverview();
  const deployments = listDeployments(20);
  const failedDeployment = deployments.find(
    (deployment) => deployment.status === "failed",
  );
  const pendingDeployment = deployments.find(
    (deployment) => deployment.status === "waiting_approval",
  );
  const accounts = listCloudAccounts();

  if (
    normalized.includes("失败") ||
    normalized.includes("故障") ||
    normalized.includes("报错")
  ) {
    if (!failedDeployment) {
      return {
        mode: "local-analysis",
        message:
          "我检查了最近 20 条真实部署记录，当前没有失败部署。旧门禁模拟记录不参与发布结果判断，因此不会把它们误报成线上故障。",
        proposals: [],
      };
    }
    const failedStep = failedDeployment.steps.find(
      (step) => step.status === "failed",
    );
    return {
      mode: "local-analysis",
      message: `我检查了真实部署记录：“${failedDeployment.appName}”最近一次发布状态为失败，环境为 ${failedDeployment.environment}，commit 为 ${failedDeployment.commitSha || "未记录"}。失败步骤是“${failedStep?.name ?? "未记录"}”，平台记录的错误为：${failedDeployment.error || failedDeployment.logs.at(-1)?.message || "暂无更详细错误"}。建议先打开部署详情核对失败日志和健康检查，再决定重试或回滚。`,
      proposals: [
        {
          id: `proposal-review-${failedDeployment.id}`,
          title: `检查失败部署 ${failedDeployment.appName}`,
          risk: "high",
          requiresApproval: true,
        },
      ],
    };
  }

  if (
    normalized.includes("发布") ||
    normalized.includes("部署") ||
    normalized.includes("上线")
  ) {
    return {
      mode: "local-analysis",
      message: pendingDeployment
        ? `当前有 ${overview.metrics.pendingDeploymentApprovals} 个真实生产部署等待审批。最近的是“${pendingDeployment.appName}”，commit 为 ${pendingDeployment.commitSha || "未记录"}，构建和镜像推送已完成，但尚未执行服务器写入。上线前仍需确认审批、健康阈值和回滚目标。`
        : "当前没有等待审批的生产发布。若创建新发布，我会先固定 commit、检查质量门禁，再生成包含风险和回滚方案的审批单。",
      proposals: pendingDeployment
        ? [
            {
              id: `proposal-review-${pendingDeployment.id}`,
              title: `审查发布 ${pendingDeployment.appName}`,
              risk: "high",
              requiresApproval: true,
            },
          ]
        : [],
    };
  }

  if (
    normalized.includes("成本") ||
    normalized.includes("费用") ||
    normalized.includes("资源")
  ) {
    return {
      mode: "local-analysis",
      message: `当前已同步 ${overview.metrics.cloudResourceCount} 个云资源，来自 ${accounts.length} 个已登记云账号，记录的本月消费合计约 ¥${overview.metrics.monthlyCost.toLocaleString("zh-CN")}。这些数字来自当前云账号同步结果；在缺少连续监控和完整账单时，我不会据此自动缩容或删除资源。`,
      proposals: [],
    };
  }

  return {
    mode: "local-analysis",
    message: `我已经读取当前控制台数据：${overview.metrics.repositoryCount} 个仓库、${overview.metrics.deploymentCount} 次真实部署、${accounts.length} 个云账号入口，其中 ${overview.metrics.failedDeployments} 次部署失败、${overview.metrics.pendingDeploymentApprovals} 次等待生产审批。发布结果只以真实部署记录为准，旧门禁运行不参与统计。\n\n当前未配置外部模型，所以使用本地证据规则分析；不会自动执行任何写操作。`,
    proposals: [],
  };
}

function systemPrompt(): string {
  return `你是 AI DevOps 控制台的运维助手。请使用简体中文回答。
你只能基于提供的平台上下文给出事实、推断、风险和下一步。
不得声称执行了未执行的操作，不得索取明文云密钥。
任何生产写入、重启、扩缩容、回滚、配置或权限变更都必须标记为需要审批。
建议要包含可验证证据和回滚考虑。`;
}

export async function chat(
  messages: AiMessage[],
): Promise<AiResponse> {
  const latest = messages.filter((item) => item.role === "user").at(-1);
  if (!latest?.content.trim()) {
    throw new Error("请输入问题。");
  }
  if (!isLlmConfigured) {
    return localAnalysis(latest.content);
  }

  const context = {
    overview: getOverview().metrics,
    recentDeployments: listDeployments(6),
    cloudAccounts: listCloudAccounts(),
    mode: "read-only",
  };
  const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.llmApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt() },
        {
          role: "system",
          content: `当前只读平台上下文：${JSON.stringify(context)}`,
        },
        ...messages.slice(-10),
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型网关返回 ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("模型未返回有效内容。");
  }
  return {
    message: content,
    mode: "model",
    proposals: [],
  };
}

export function analyzeRun(run: PipelineRunRecord): {
  severity: "low" | "medium" | "high";
  summary: string;
  evidence: string[];
  recommendations: Array<{
    title: string;
    risk: "low" | "medium" | "high";
    requiresApproval: boolean;
  }>;
} {
  const evidence = run.logs
    .filter((line) => line.level === "warn" || line.level === "error")
    .map((line) => line.message);
  const dependencyFailure = run.logs.some((line) =>
    line.message.includes("依赖"),
  );
  return {
    severity: run.status === "failed" ? "medium" : "high",
    summary: dependencyFailure
      ? "构建阶段因依赖闭环缺失而中止，生产环境未被修改。"
      : run.status === "failed"
        ? "流水线在完成生产变更前中止，需要检查失败步骤。"
        : "流水线状态仍在流转，建议等待最新证据完成后再判断。",
    evidence:
      evidence.length > 0
        ? evidence
        : ["当前日志没有错误级别事件，请结合运行步骤继续检查。"],
    recommendations: [
      {
        title: dependencyFailure
          ? "在功能分支补齐依赖并重新执行质量门禁"
          : "重新运行失败步骤前先核对变更和制品",
        risk: "medium",
        requiresApproval: true,
      },
      {
        title: "确认生产环境无相关变更和异常指标",
        risk: "low",
        requiresApproval: false,
      },
    ],
  };
}


import {
  audit,
  createDeployment,
  findSucceededDeploymentByImage,
  getDeployment,
  getGitCredentialSecret,
  getLastSucceededDeployment,
  getRegistryCredentialSecret,
  getRepositoryAccess,
  updateDeployment,
  listRegistryCredentials,
  upsertHealthCheck,
  type DeploymentRecord,
} from "./db.js";
import { getApplicationEnv, type ApplicationRecord } from "./apps.js";
import {
  repositoryAccessUrl,
  repositoryUserUrl,
  syncRepository,
} from "./git.js";
import {
  execServerCommand,
  getServerSecret,
} from "./servers.js";
import type { LogLine, PipelineStep } from "./types.js";

interface PublishInput {
  deploymentId: string;
  app: {
    id: string;
    name: string;
    fields: Record<string, string | number | boolean>;
  };
  repositoryId: string;
  environment: "development" | "staging" | "production";
}

interface StepUpdate {
  description?: string;
  command?: string;
  exitCode?: number | null;
  result?: string;
  evidence?: string[];
}

function stepLog(
  deploymentId: string,
  current: { steps: PipelineStep[]; logs: LogLine[] },
  key: string,
  name: string,
  status: PipelineStep["status"],
  message: string,
  level: LogLine["level"] = "info",
  update: StepUpdate = {},
) {
  const now = new Date().toISOString();
  let found = false;
  const steps = current.steps.map((step) => {
    if (step.key !== key) return step;
    found = true;
    const terminal = ["succeeded", "failed", "skipped"].includes(status);
    const startedAt =
      step.startedAt ??
      (status === "running" || (terminal && status !== "skipped")
        ? now
        : undefined);
    const finishedAt = terminal ? now : step.finishedAt;
    const durationMs =
      startedAt && finishedAt
        ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
        : step.durationMs;
    return {
      ...step,
      name,
      status,
      startedAt,
      finishedAt,
      durationMs,
      description: update.description ?? step.description,
      command: update.command ?? step.command,
      exitCode:
        update.exitCode === undefined ? step.exitCode : update.exitCode,
      result:
        update.result ??
        (status === "succeeded" || status === "failed" || status === "skipped"
          ? message
          : step.result),
      evidence: update.evidence ?? step.evidence,
    };
  });
  if (!found) {
    const terminal = ["succeeded", "failed", "skipped"].includes(status);
    steps.push({
      key,
      name,
      description: update.description,
      status,
      startedAt: terminal ? now : now,
      finishedAt: terminal ? now : undefined,
      durationMs: terminal ? 0 : undefined,
      command: update.command,
      exitCode: update.exitCode,
      result: update.result ?? message,
      evidence: update.evidence,
    });
  }
  const logs = [
    ...current.logs,
    { time: now, level, message },
  ];
  updateDeployment(deploymentId, { steps, logs });
  return { steps, logs };
}

function safeOutput(value: string, maxLength = 700): string {
  return value
    .replace(
      /(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi,
      "$1=***",
    )
    .replace(/https?:\/\/[^@\s]+@/gi, "https://***@")
    .trim()
    .slice(-maxLength);
}

function releaseSteps(deployment: DeploymentRecord): PipelineStep[] {
  const production = deployment.environment === "production";
  return [
    {
      key: "preflight",
      name: "前置检查",
      description: "检查服务器基础命令、Docker 状态与运行端口",
      status: "pending",
    },
    {
      key: "sync_code",
      name: "同步代码",
      description: `从仓库 ${deployment.repositoryName} 拉取固定 commit`,
      status: "pending",
    },
    {
      key: "build_image",
      name: "构建镜像",
      description: "在目标服务器执行 Docker 构建",
      status: "pending",
    },
    {
      key: "push_image",
      name: "推送镜像",
      description: "推送不可变 commit 标签到腾讯云 TCR",
      status: "pending",
    },
    {
      key: "approval",
      name: "生产审批",
      description: production
        ? "生产写入前等待管理员批准"
        : "开发/预发环境按策略自动执行",
      status: production ? "pending" : "skipped",
    },
    {
      key: "runtime_config",
      name: "运行配置",
      description: "检查或写入环境变量文件并设置安全权限",
      status: "pending",
    },
    {
      key: "deploy_container",
      name: "部署容器",
      description: "替换当前容器并启动目标镜像",
      status: "pending",
    },
    {
      key: "health_check",
      name: "健康检查",
      description: `检查端口 ${deployment.port}${deployment.healthPath || "/"}`,
      status: "pending",
    },
    {
      key: "configure_domain",
      name: "配置域名",
      description: deployment.domain
        ? `绑定 ${deployment.domain} 到端口 ${deployment.port}`
        : "当前应用未配置访问域名",
      status: deployment.domain ? "pending" : "skipped",
    },
  ];
}

function rollbackSteps(deployment: DeploymentRecord): PipelineStep[] {
  return [
    {
      key: "verify_target",
      name: "校验目标版本",
      description: "确认目标版本成功部署过且镜像仍可用",
      status: "pending",
    },
    {
      key: "approval",
      name: "回滚审批",
      description: "回滚属于生产变更，执行前必须由管理员批准",
      status: "pending",
    },
    {
      key: "runtime_config",
      name: "检查运行配置",
      description: "沿用当前服务器、端口、环境变量和数据卷配置",
      status: "pending",
    },
    {
      key: "deploy_container",
      name: "部署历史镜像",
      description: "用历史 commit 镜像替换当前容器",
      status: "pending",
    },
    {
      key: "health_check",
      name: "回滚健康检查",
      description: `回滚后检查端口 ${deployment.port}${deployment.healthPath || "/"}`,
      status: "pending",
    },
    {
      key: "configure_domain",
      name: "核对域名",
      description: deployment.domain
        ? `确认 ${deployment.domain} 指向端口 ${deployment.port}`
        : "当前应用未配置访问域名",
      status: deployment.domain ? "pending" : "skipped",
    },
  ];
}

function containerName(appId: string): string {
  return `aidevops-${appId.slice(0, 12)}`;
}

function imageName(appName: string, commitSha: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "app";
  const namespace = process.env.CCR_NAMESPACE?.trim() || "examplespace";
  return `ccr.ccs.tencentyun.com/${namespace}/${slug}:${commitSha}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function dockerRunCommand(
  deployment: DeploymentRecord,
  container: string,
  tag: string,
): string {
  const networkMode = deployment.networkMode === "host" ? "host" : "bridge";
  const containerPort = Number(deployment.containerPort || 80);
  const portArgs =
    networkMode === "host"
      ? ""
      : `-p ${shellQuote(`${deployment.port}:${containerPort}`)}`;
  const networkArgs = networkMode === "host" ? "--network host" : "";
  const envArgs = deployment.envFile
    ? `--env-file ${shellQuote(deployment.envFile)}`
    : "";
  const volumeArgs = String(deployment.volumes || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `-v ${shellQuote(item)}`)
    .join(" ");
  return [
    "docker run -d",
    `--name ${shellQuote(container)}`,
    "--restart unless-stopped",
    networkArgs,
    portArgs,
    envArgs,
    volumeArgs,
    shellQuote(tag),
  ]
    .filter(Boolean)
    .join(" ");
}

function containerStartScript(
  deployment: DeploymentRecord,
  container: string,
  tag: string,
): string {
  const quoted = shellQuote(container);
  const logFile = "/tmp/aidevops-container-start.log";
  const run = dockerRunCommand(deployment, container, tag);
  return [
    `docker rm -f ${quoted} >/dev/null 2>&1 || true`,
    "for i in 1 2 3 4 5 6 7 8 9 10; do",
    `  if ! docker inspect ${quoted} >/dev/null 2>&1; then break; fi`,
    "  sleep 1",
    "done",
    "for i in 1 2 3 4 5; do",
    `  if ${run} > ${logFile} 2>&1; then cat ${logFile}; exit 0; fi`,
    `  if grep -qi "already in use" ${logFile}; then`,
    `    docker rm -f ${quoted} >/dev/null 2>&1 || true`,
    "    sleep 2",
    "    continue",
    "  fi",
    `  cat ${logFile}`,
    "  exit 1",
    "done",
    `cat ${logFile}`,
    "exit 1",
  ].join("\n");
}

function nginxConfig(
  domain: string,
  port: number,
  tlsEnabled: boolean,
): string {
  const serverNames = domain.startsWith("www.")
    ? domain
    : `${domain} www.${domain}`;
  const proxyLocation = [
    "    location / {",
    `        proxy_pass http://127.0.0.1:${port};`,
    "        proxy_http_version 1.1;",
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Real-IP $remote_addr;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    "        proxy_read_timeout 120s;",
    "    }",
  ];
  const lines = [
    "server {",
    "    listen 80;",
    `    server_name ${serverNames};`,
    "    client_max_body_size 64m;",
    "    location ^~ /.well-known/acme-challenge/ {",
    `        root /var/www/letsencrypt-${domain};`,
    "        default_type text/plain;",
    "    }",
    ...(tlsEnabled
      ? [
          "    location / {",
          "        return 301 https://$host$request_uri;",
          "    }",
        ]
      : proxyLocation),
    "}",
  ];
  if (tlsEnabled) {
    lines.push(
      "",
      "server {",
      "    listen 443 ssl;",
      `    server_name ${serverNames};`,
      "    client_max_body_size 64m;",
      `    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;`,
      `    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`,
      "    ssl_protocols TLSv1.2 TLSv1.3;",
      "    ssl_session_cache shared:SSL:10m;",
      "    ssl_session_timeout 1d;",
      '    add_header Strict-Transport-Security "max-age=31536000" always;',
      ...proxyLocation,
      "}",
    );
  }
  return lines.join("\n");
}

async function configureDomain(
  serverId: string,
  domain: string,
  port: number,
): Promise<void> {
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain)) {
    throw new Error(`域名不合法：${domain}`);
  }
  const certProbe = await execServerCommand(
    serverId,
    `test -f /etc/letsencrypt/live/${domain}/fullchain.pem && test -f /etc/letsencrypt/live/${domain}/privkey.pem && echo CERT_OK`,
    { sudo: true, timeoutMs: 15_000 },
  );
  const tlsEnabled = certProbe.stdout.includes("CERT_OK");
  const content = Buffer.from(
    nginxConfig(domain, port, tlsEnabled),
    "utf8",
  ).toString("base64");
  const command = [
    "set -e",
    `mkdir -p /var/www/letsencrypt-${domain}/.well-known/acme-challenge`,
    `chmod -R 755 /var/www/letsencrypt-${domain}`,
    "mkdir -p /usr/local/nginx/conf/vhost",
    `target=/usr/local/nginx/conf/vhost/${domain}.conf`,
    "backup=$target.bak.$(date +%s)",
    'if [ -f "$target" ]; then cp "$target" "$backup"; fi',
    `printf '%s' '${content}' | base64 -d > "$target"`,
    "if ! nginx -t; then",
    '  if [ -n "$backup" ] && [ -f "$backup" ]; then mv "$backup" "$target"; else rm -f "$target"; fi',
    "  exit 1",
    "fi",
    "systemctl reload nginx",
    'if [ -n "$backup" ] && [ -f "$backup" ]; then rm -f "$backup"; fi',
  ].join("\n");
  const result = await execServerCommand(serverId, command, {
    sudo: true,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Nginx 域名配置失败：${result.stderr || result.stdout || "未知错误"}`,
    );
  }
}

async function assertHostPortAvailable(
  serverId: string,
  deployment: DeploymentRecord,
  container: string,
): Promise<void> {
  if (deployment.networkMode !== "host") return;
  const inspect = await execServerCommand(
    serverId,
    `docker inspect -f '{{.State.Pid}}' ${shellQuote(container)} 2>/dev/null || true`,
    { timeoutMs: 15_000 },
  );
  const ownPid = inspect.stdout.trim();
  const listeners = await execServerCommand(
    serverId,
    `ss -ltnp 2>/dev/null | grep -E ':${deployment.port}[[:space:]]' || true`,
    { sudo: true, timeoutMs: 15_000 },
  );
  const lines = listeners.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const foreign = lines.filter(
    (line) =>
      !ownPid ||
      (!line.includes(`pid=${ownPid},`) && !line.includes(`pid=${ownPid})`)),
  );
  if (foreign.length > 0) {
    throw new Error(
      `端口 ${deployment.port} 已被其他服务占用，已中止部署：${foreign[0]}`,
    );
  }
}

export async function runBuildAndPush(input: PublishInput): Promise<void> {
  const deployment = getDeployment(input.deploymentId);
  if (!deployment) throw new Error("部署任务不存在。");
  let state = { steps: releaseSteps(deployment), logs: [] as LogLine[] };
  updateDeployment(input.deploymentId, {
    steps: state.steps,
    logs: [],
  });

  try {
    state = stepLog(
      input.deploymentId,
      state,
      "preflight",
      "前置检查",
      "running",
      "正在检查服务器 Docker、Git、curl 与端口配置",
      "info",
      {
        command:
          "command -v docker && command -v git && command -v curl && docker info",
        evidence: [
          `服务器：${deployment.serverName || deployment.serverId}`,
          `网络模式：${deployment.networkMode}`,
          `端口：${deployment.port} → ${deployment.containerPort}`,
        ],
      },
    );
    const server = getServerSecret(deployment.serverId);
    if (!server) throw new Error("部署服务器不存在，请检查云服务器连接。");
    const preflight = await execServerCommand(
      deployment.serverId,
      "command -v docker >/dev/null 2>&1 && command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo PREFLIGHT_OK",
      { timeoutMs: 30_000 },
    );
    if (!preflight.stdout.includes("PREFLIGHT_OK")) {
      throw new Error(
        `服务器前置检查失败：缺少 Docker/Git/curl，或当前用户无权访问 Docker。${safeOutput(preflight.stderr || preflight.stdout, 300)}`,
      );
    }
    state = stepLog(
      input.deploymentId,
      state,
      "preflight",
      "前置检查",
      "succeeded",
      "服务器基础环境与 Docker 状态正常",
      "success",
      { exitCode: preflight.exitCode ?? 0, result: "前置检查通过" },
    );

    const access = getRepositoryAccess(input.repositoryId);
    if (!access) throw new Error("仓库配置不存在。");
    let remoteUrl = access.url;
    let remotePassword: string | undefined;
    if (access.token) {
      remoteUrl = repositoryAccessUrl(
        access.url,
        access.provider,
        access.token,
      );
    } else if (access.provider === "gitee") {
      const credential = getGitCredentialSecret("gitee");
      if (credential) {
        remoteUrl = repositoryUserUrl(access.url, credential.username);
        remotePassword = credential.password;
      }
    }

    state = stepLog(
      input.deploymentId,
      state,
      "sync_code",
      "同步代码",
      "running",
      `正在从 ${access.provider} 拉取分支 ${access.branch}`,
      "info",
      {
        command: `git fetch origin ${access.branch} && git checkout FETCH_HEAD`,
        evidence: [
          `仓库：${deployment.repositoryName}`,
          `分支：${access.branch}`,
        ],
      },
    );
    const syncResult = await syncRepository({
      id: input.repositoryId,
      url: remoteUrl,
      branch: access.branch,
      server: {
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
      },
      password: remotePassword,
    });
    updateDeployment(input.deploymentId, { commitSha: syncResult.commitSha });
    state = stepLog(
      input.deploymentId,
      state,
      "sync_code",
      "同步代码",
      "succeeded",
      `已同步 commit ${syncResult.commitSha}：${syncResult.message}`,
      "success",
      {
        exitCode: 0,
        result: `commit ${syncResult.commitSha}`,
        evidence: [
          `提交说明：${syncResult.message || "未提供"}`,
          `固定版本：${syncResult.commitSha}`,
        ],
      },
    );

    const registry = listRegistryCredentials().find(
      (item) => item.registry === "ccr.ccs.tencentyun.com",
    );
    if (!registry) throw new Error("镜像仓库凭据未配置。");
    const registrySecret = getRegistryCredentialSecret(registry.id);
    if (!registrySecret) throw new Error("镜像仓库凭据读取失败。");

    const tag = imageName(input.app.name, syncResult.commitSha);
    updateDeployment(input.deploymentId, { imageTag: tag });

    state = stepLog(
      input.deploymentId,
      state,
      "build_image",
      "构建镜像",
      "running",
      `正在构建镜像 ${tag}`,
      "info",
      {
        command: `docker build -t ${tag} <repository>`,
        evidence: [`固定镜像标签：${tag}`],
      },
    );
    const repoDir = `/opt/ai-devops/repos/${input.repositoryId}`;
    const build = await execServerCommand(
      deployment.serverId,
      `cd '${repoDir}' && build_log="/tmp/aidevops-build-$$.log"; timeout 600 docker build -t '${tag}' . > "$build_log" 2>&1; build_exit=$?; tail -20 "$build_log"; rm -f "$build_log"; echo BUILD_EXIT=$build_exit; exit $build_exit`,
      { timeoutMs: 620_000 },
    );
    if (!build.stdout.includes("BUILD_EXIT=0")) {
      throw new Error(
        `镜像构建失败：${build.stdout.slice(-500) || build.stderr.slice(0, 500)}`,
      );
    }
    state = stepLog(
      input.deploymentId,
      state,
      "build_image",
      "构建镜像",
      "succeeded",
      `镜像构建完成 ${tag}`,
      "success",
      {
        exitCode: 0,
        result: `镜像构建成功：${tag}`,
        evidence: [
          `构建输出摘要：${safeOutput(build.stdout.replace("BUILD_EXIT=0", "").trim(), 500) || "Docker 构建成功"}`,
        ],
      },
    );

    state = stepLog(
      input.deploymentId,
      state,
      "push_image",
      "推送镜像",
      "running",
      "正在登录并推送镜像到腾讯云 TCR",
      "info",
      {
        command: `docker push ${tag}`,
        evidence: ["认证信息通过服务器标准输入传递，不写入日志"],
      },
    );
    await execServerCommand(
      deployment.serverId,
      `docker login ccr.ccs.tencentyun.com --username=${registrySecret.username} --password-stdin`,
      { stdin: `${registrySecret.password}\n`, timeoutMs: 60_000 },
    );
    const push = await execServerCommand(
      deployment.serverId,
      `push_log="/tmp/aidevops-push-$$.log"; timeout 300 docker push '${tag}' > "$push_log" 2>&1; push_exit=$?; tail -10 "$push_log"; rm -f "$push_log"; echo PUSH_EXIT=$push_exit; exit $push_exit`,
      { timeoutMs: 320_000 },
    );
    if (!push.stdout.includes("PUSH_EXIT=0")) {
      throw new Error(`镜像推送失败：${push.stdout.slice(-400)}`);
    }
    state = stepLog(
      input.deploymentId,
      state,
      "push_image",
      "推送镜像",
      "succeeded",
      `镜像已推送到 ${tag}`,
      "success",
      {
        exitCode: 0,
        result: `TCR 推送成功：${tag}`,
        evidence: [
          `推送输出摘要：${safeOutput(push.stdout.replace("PUSH_EXIT=0", "").trim(), 400) || "镜像已推送"}`,
        ],
      },
    );

    if (input.environment === "production") {
      state = stepLog(
        input.deploymentId,
        state,
        "approval",
        "生产审批",
        "pending",
        "构建与推送完成，等待管理员审批后部署",
        "info",
        {
          result: "等待管理员批准",
          evidence: [
            `待部署镜像：${tag}`,
            `环境：生产`,
          ],
        },
      );
      updateDeployment(input.deploymentId, {
        status: "waiting_approval",
      });
      return;
    }

    state = stepLog(
      input.deploymentId,
      state,
      "approval",
      "生产审批",
      "skipped",
      "开发/预发环境按策略自动执行，无需人工审批",
      "info",
      {
        result: "生产审批不适用",
        evidence: [`执行策略：${input.environment} 自动发布`],
      },
    );
    await deployContainer(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "发布失败";
    const runningStep = state.steps.find((step) => step.status === "running");
    if (runningStep?.key) {
      state = stepLog(
        input.deploymentId,
        state,
        runningStep.key,
        runningStep.name,
        "failed",
        message,
        "error",
        {
          exitCode: 1,
          result: message,
          evidence: [`失败时间：${new Date().toISOString()}`],
        },
      );
    }
    updateDeployment(input.deploymentId, {
      status: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }
}

async function verifyContainerHealth(deployment: DeploymentRecord): Promise<{
  healthy: boolean;
  httpStatus: number;
  attempts: number;
  responseMs: number;
}> {
  const healthPath = deployment.healthPath || "/";
  const startedAt = Date.now();
  const health = await execServerCommand(
    deployment.serverId,
    `ok=0; attempts=0; http=000; for i in $(seq 1 20); do attempts=$i; http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:${deployment.port}${healthPath}' 2>/dev/null || echo 000); if [ "$http" -ge 200 ] && [ "$http" -lt 400 ]; then ok=1; break; fi; sleep 2; done; echo "HEALTH ok=$ok http=$http attempts=$attempts"`,
    { timeoutMs: 120_000 },
  );
  const match = health.stdout.match(/HEALTH ok=(\d) http=(\d+) attempts=(\d+)/);
  return {
    healthy: match?.[1] === "1",
    httpStatus: Number(match?.[2] ?? 0),
    attempts: Number(match?.[3] ?? 0),
    responseMs: Date.now() - startedAt,
  };
}

function failedStepMessage(
  state: { steps: PipelineStep[]; logs: LogLine[] },
): PipelineStep | undefined {
  return state.steps.find((step) => step.status === "running");
}

export async function deployContainer(
  input: PublishInput,
  approvedBy = "",
): Promise<void> {
  const deployment = getDeployment(input.deploymentId);
  if (!deployment) throw new Error("部署任务不存在。");
  const tag = deployment.imageTag;
  if (!tag) throw new Error("缺少镜像标签，无法部署。");
  const previous = getLastSucceededDeployment(
    deployment.appId,
    deployment.environment,
  );
  let state = { steps: deployment.steps, logs: deployment.logs };
  const approvalStep = state.steps.find((step) => step.key === "approval");
  if (approvalStep?.status === "pending" && !approvedBy) {
    throw new Error("该部署仍等待管理员审批。");
  }
  if (approvedBy && approvalStep?.status === "pending") {
    state = stepLog(
      input.deploymentId,
      state,
      "approval",
      approvalStep.name,
      "succeeded",
      `管理员已批准${deployment.kind === "rollback" ? "回滚" : "生产发布"}：${approvedBy}`,
      "success",
      {
        result: `审批通过：${approvedBy}`,
        evidence: [
          `审批人：${approvedBy}`,
          `审批时间：${new Date().toISOString()}`,
          `目标镜像：${tag}`,
        ],
      },
    );
  }
  updateDeployment(input.deploymentId, {
    previousImageTag: previous?.imageTag ?? "",
    approvedAt: approvedBy ? new Date().toISOString() : deployment.approvedAt,
    approvedBy,
  });

  const container = containerName(input.app.id);
  const deployStep = state.steps.find(
    (step) => step.key === "deploy_container",
  );
  const runtimeStep = state.steps.find(
    (step) => step.key === "runtime_config",
  );
  const healthStep = state.steps.find(
    (step) => step.key === "health_check",
  );
  const domainStep = state.steps.find(
    (step) => step.key === "configure_domain",
  );
  let activeKey = "runtime_config";
  let replacementAttempted = false;
  let healthPassed = false;

  try {
    state = stepLog(
      input.deploymentId,
      state,
      "runtime_config",
      runtimeStep?.name ?? "运行配置",
      "running",
      deployment.kind === "release"
        ? "正在检查并写入运行配置"
        : "正在检查当前运行配置",
      "info",
      {
        command:
          deployment.kind === "release"
            ? "umask 077; mkdir -p <env-dir>; cat > <env-file>; chmod 600 <env-file>"
            : "test -f <env-file>",
        evidence: [
          deployment.envFile
            ? `环境变量文件：${deployment.envFile}`
            : "未配置文件型环境变量",
          `数据卷：${deployment.volumes || "无"}`,
          `网络模式：${deployment.networkMode}`,
        ],
      },
    );
    const envContent = getApplicationEnv(input.app.id);
    if (deployment.kind === "release" && envContent.trim() && !deployment.envFile) {
      throw new Error(
        "应用已配置环境变量内容，但未设置“环境变量文件”路径，请在应用配置中补充绝对路径。",
      );
    }
    if (deployment.kind === "release" && deployment.envFile && envContent.trim()) {
      const envPath = shellQuote(deployment.envFile);
      const variableCount = envContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("=")).length;
      const write = await execServerCommand(
        deployment.serverId,
        `umask 077; mkdir -p "$(dirname ${envPath})"; cat > ${envPath}`,
        {
          stdin: envContent.endsWith("\n") ? envContent : `${envContent}\n`,
          timeoutMs: 30_000,
        },
      );
      if (write.exitCode !== 0) {
        throw new Error("写入环境变量文件失败，请检查服务器目录权限。");
      }
      await execServerCommand(
        deployment.serverId,
        `chmod 600 ${envPath}`,
        { timeoutMs: 15_000 },
      );
      state = stepLog(
        input.deploymentId,
        state,
        "runtime_config",
        runtimeStep?.name ?? "运行配置",
        "running",
        `已安全写入环境变量文件（${variableCount} 个变量，内容不进入日志）`,
      );
    }
    if (deployment.envFile) {
      const envCheck = await execServerCommand(
        deployment.serverId,
        `test -f ${shellQuote(deployment.envFile)} && echo ENV_FILE_OK`,
        { timeoutMs: 15_000 },
      );
      if (!envCheck.stdout.includes("ENV_FILE_OK")) {
        throw new Error(`环境变量文件不存在：${deployment.envFile}`);
      }
    }
    state = stepLog(
      input.deploymentId,
      state,
      "runtime_config",
      runtimeStep?.name ?? "运行配置",
      deployment.envFile || envContent.trim() ? "succeeded" : "skipped",
      deployment.envFile || envContent.trim()
        ? "运行配置检查完成"
        : "该应用没有文件型环境变量或数据卷配置",
      "success",
      {
        exitCode: 0,
        result: deployment.envFile
          ? "运行配置可用"
          : "无需额外运行配置",
      },
    );

    activeKey = "deploy_container";
    state = stepLog(
      input.deploymentId,
      state,
      "deploy_container",
      deployStep?.name ?? "部署容器",
      "running",
      `正在替换容器 ${container}，目标端口 ${deployment.port}`,
      "info",
      {
        command: `docker rm -f ${container} && docker run -d --name ${container} ${tag}`,
        evidence: [`目标镜像：${tag}`, `容器端口：${deployment.containerPort}`],
      },
    );
    await assertHostPortAvailable(
      deployment.serverId,
      deployment,
      container,
    );
    replacementAttempted = true;
    const runResult = await execServerCommand(
      deployment.serverId,
      containerStartScript(deployment, container, tag),
      { timeoutMs: 180_000 },
    );
    const containerId = runResult.stdout.trim().split(/\s+/).pop() ?? "";
    if (!containerId || !/^[0-9a-f]{12,64}$/.test(containerId)) {
      throw new Error(
        `容器启动失败：${safeOutput(runResult.stdout || runResult.stderr, 500)}`,
      );
    }
    state = stepLog(
      input.deploymentId,
      state,
      "deploy_container",
      deployStep?.name ?? "部署容器",
      "succeeded",
      `容器 ${containerId.slice(0, 12)} 已启动`,
      "success",
      {
        exitCode: 0,
        result: `容器 ID：${containerId.slice(0, 12)}`,
        evidence: [
          `镜像：${tag}`,
          `端口映射：${deployment.port} → ${deployment.containerPort}`,
        ],
      },
    );

    activeKey = "health_check";
    state = stepLog(
      input.deploymentId,
      state,
      "health_check",
      healthStep?.name ?? "健康检查",
      "running",
      "容器已启动，正在执行健康检查",
      "info",
      {
        command: `curl http://127.0.0.1:${deployment.port}${deployment.healthPath || "/"}`,
        evidence: ["最多检查 20 次，每次间隔 2 秒"],
      },
    );
    const health = await verifyContainerHealth(deployment);
    if (!health.healthy) {
      throw new Error(
        `健康检查未通过：HTTP ${health.httpStatus || "无响应"}，共检查 ${health.attempts} 次`,
      );
    }
    healthPassed = true;
    state = stepLog(
      input.deploymentId,
      state,
      "health_check",
      healthStep?.name ?? "健康检查",
      "succeeded",
      `健康检查通过：HTTP ${health.httpStatus}`,
      "success",
      {
        exitCode: 0,
        result: `HTTP ${health.httpStatus}`,
        evidence: [
          `检查次数：${health.attempts}`,
          `总耗时：${health.responseMs} ms`,
          `检查地址：127.0.0.1:${deployment.port}${deployment.healthPath || "/"}`,
        ],
      },
    );

    if (deployment.domain) {
      activeKey = "configure_domain";
      state = stepLog(
        input.deploymentId,
        state,
        "configure_domain",
        domainStep?.name ?? "配置域名",
        "running",
        `正在绑定域名 ${deployment.domain} 到端口 ${deployment.port}`,
        "info",
        {
          command: `nginx vhost: ${deployment.domain} -> 127.0.0.1:${deployment.port}`,
          evidence: ["写入前自动备份 vhost", "nginx -t 通过后才 reload"],
        },
      );
      await configureDomain(
        deployment.serverId,
        deployment.domain,
        deployment.port,
      );
      state = stepLog(
        input.deploymentId,
        state,
        "configure_domain",
        domainStep?.name ?? "配置域名",
        "succeeded",
        `Nginx 已绑定 ${deployment.domain} → 127.0.0.1:${deployment.port}`,
        "success",
        {
          exitCode: 0,
          result: "域名配置已生效",
          evidence: [`域名：${deployment.domain}`, `后端端口：${deployment.port}`],
        },
      );
    } else {
      state = stepLog(
        input.deploymentId,
        state,
        "configure_domain",
        domainStep?.name ?? "配置域名",
        "skipped",
        "未配置访问域名，跳过 Nginx 绑定",
        "info",
        { result: "无需配置域名" },
      );
    }

    updateDeployment(input.deploymentId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      error: "",
    });
  } catch (error) {
    let message = error instanceof Error ? error.message : "部署失败";
    const runningStep = failedStepMessage(state);
    if (runningStep?.key) {
      state = stepLog(
        input.deploymentId,
        state,
        runningStep.key,
        runningStep.name,
        "failed",
        message,
        "error",
        {
          exitCode: 1,
          result: message,
          evidence: [`失败步骤：${runningStep.name}`],
        },
      );
    }
    if (previous?.imageTag && replacementAttempted && !healthPassed) {
      const target =
        findSucceededDeploymentByImage(
          deployment.appId,
          previous.imageTag,
          deployment.environment,
        ) ?? previous;
      const rollback = await autoRollbackToTarget({
        source: deployment,
        target,
        reason: message,
      }).catch((rollbackError: unknown) => ({
        recovered: false,
        message:
          rollbackError instanceof Error
            ? rollbackError.message
            : "自动回滚执行异常",
      }));
      message = `${message}；${rollback.message}`;
    } else if (healthPassed && activeKey === "configure_domain") {
      message = `${message}；新容器本身健康，当前运行版本未被自动回退`;
    }
    updateDeployment(input.deploymentId, {
      status: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }
}

export function prepareRollback(input: {
  application: ApplicationRecord;
  targetDeploymentId: string;
  actor: string;
}): DeploymentRecord {
  const target = getDeployment(input.targetDeploymentId);
  if (!target || target.appId !== input.application.id) {
    throw new Error("回滚目标不存在或不属于当前应用。");
  }
  if (target.status !== "succeeded" || !target.imageTag) {
    throw new Error("只有发布成功且具有镜像标签的版本才能作为回滚目标。");
  }
  const current = getLastSucceededDeployment(
    input.application.id,
    target.environment,
  );
  if (current?.imageTag === target.imageTag) {
    throw new Error("目标版本就是当前运行版本，无需回滚。");
  }
  const runtime = current ?? target;
  const server = getServerSecret(runtime.serverId);
  if (!server) {
    throw new Error("回滚目标使用的服务器已不可用，请先恢复服务器连接。");
  }
  const deployment = createDeployment({
    appId: input.application.id,
    appName: input.application.name,
    repositoryId: target.repositoryId,
    repositoryName: target.repositoryName,
    serverId: runtime.serverId,
    serverName: server.name,
    environment: target.environment,
    port: runtime.port,
    containerPort: runtime.containerPort,
    envFile: runtime.envFile,
    volumes: runtime.volumes,
    networkMode: runtime.networkMode,
    domain: runtime.domain,
    healthPath: runtime.healthPath,
    kind: "rollback",
    targetDeploymentId: target.id,
    triggeredBy: input.actor,
  });
  let state = {
    steps: rollbackSteps(deployment),
    logs: [] as LogLine[],
  };
  state = stepLog(
    deployment.id,
    state,
    "verify_target",
    "校验目标版本",
    "running",
    `正在校验回滚目标 ${target.commitSha}`,
  );
  state = stepLog(
    deployment.id,
    state,
    "verify_target",
    "校验目标版本",
    "succeeded",
    `目标版本可用：commit ${target.commitSha}，镜像 ${target.imageTag}`,
    "success",
    {
      exitCode: 0,
      result: `目标 commit ${target.commitSha}`,
      evidence: [
        `目标部署：${target.id}`,
        `当前版本：${current?.commitSha || "无"}`,
        `回滚范围：仅镜像与 commit；沿用当前服务器、端口和环境变量配置`,
      ],
    },
  );
  state = stepLog(
    deployment.id,
    state,
    "approval",
    "回滚审批",
    "pending",
    `回滚到 commit ${target.commitSha} 的审批单已创建，等待管理员批准`,
    "warn",
    {
      result: "等待管理员批准",
      evidence: [
        `目标镜像：${target.imageTag}`,
        `当前镜像：${current?.imageTag || "无"}`,
      ],
    },
  );
  updateDeployment(deployment.id, {
    imageTag: target.imageTag,
    commitSha: target.commitSha,
    previousImageTag: current?.imageTag ?? "",
    status: "waiting_approval",
    steps: state.steps,
    logs: state.logs,
  });
  return getDeployment(deployment.id) as DeploymentRecord;
}

export async function autoRollbackToTarget(input: {
  source: DeploymentRecord;
  target: DeploymentRecord;
  reason: string;
}): Promise<{ recovered: boolean; message: string }> {
  if (!input.target.imageTag) {
    return { recovered: false, message: "没有可用的历史镜像，无法自动回滚" };
  }
  const deployment = createDeployment({
    appId: input.source.appId,
    appName: input.source.appName,
    repositoryId: input.source.repositoryId,
    repositoryName: input.source.repositoryName,
    serverId: input.source.serverId,
    serverName: input.source.serverName,
    environment: input.source.environment,
    port: input.source.port,
    containerPort: input.source.containerPort,
    envFile: input.source.envFile,
    volumes: input.source.volumes,
    networkMode: input.source.networkMode,
    domain: input.source.domain,
    healthPath: input.source.healthPath,
    kind: "auto_rollback",
    targetDeploymentId: input.target.id,
    triggeredBy: "system:auto-recovery",
  });
  updateDeployment(deployment.id, {
    imageTag: input.target.imageTag,
    commitSha: input.target.commitSha,
    previousImageTag: input.source.imageTag,
  });
  let state = {
    steps: [
      {
        key: "detect_failure",
        name: "检测故障",
        description: "确认新版本或运行中容器不健康",
        status: "succeeded" as const,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        result: input.reason,
        evidence: [
          `故障版本：${input.source.commitSha || input.source.imageTag}`,
          `目标版本：${input.target.commitSha}`,
        ],
      },
      {
        key: "deploy_container",
        name: "部署历史镜像",
        description: "自动替换当前容器为上一成功版本",
        status: "running" as const,
      },
      {
        key: "health_check",
        name: "回滚健康检查",
        description: `检查端口 ${deployment.port}${deployment.healthPath || "/"}`,
        status: "pending" as const,
      },
      {
        key: "configure_domain",
        name: "核对域名",
        description: "自动回滚复用现有域名配置",
        status: "skipped" as const,
      },
    ] as PipelineStep[],
    logs: [
      {
        time: new Date().toISOString(),
        level: "warn" as const,
        message: `自动恢复触发：${input.reason}`,
      },
    ] as LogLine[],
  };
  try {
    const container = containerName(input.source.appId);
    const run = await execServerCommand(
      input.source.serverId,
      containerStartScript(
        input.source,
        container,
        input.target.imageTag,
      ),
      { timeoutMs: 180_000 },
    );
    const containerId = run.stdout.trim().split(/\s+/).pop() ?? "";
    if (!containerId || !/^[0-9a-f]{12,64}$/.test(containerId)) {
      throw new Error(`历史镜像启动失败：${safeOutput(run.stderr || run.stdout, 500)}`);
    }
    state = stepLog(
      deployment.id,
      state,
      "deploy_container",
      "部署历史镜像",
      "succeeded",
      `历史容器已启动：${containerId.slice(0, 12)}`,
      "success",
      {
        exitCode: 0,
        result: `容器 ${containerId.slice(0, 12)}`,
        evidence: [`目标镜像：${input.target.imageTag}`],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    state = stepLog(
      deployment.id,
      state,
      "health_check",
      "回滚健康检查",
      "running",
      "等待 8 秒后检查回滚版本健康状态",
    );
    const health = await verifyContainerHealth(deployment);
    if (!health.healthy) {
      throw new Error(
        `回滚健康检查未通过：HTTP ${health.httpStatus || "无响应"}`,
      );
    }
    state = stepLog(
      deployment.id,
      state,
      "health_check",
      "回滚健康检查",
      "succeeded",
      `回滚健康检查通过：HTTP ${health.httpStatus}`,
      "success",
      {
        exitCode: 0,
        result: `HTTP ${health.httpStatus}`,
        evidence: [
          `检查次数：${health.attempts}`,
          `总耗时：${health.responseMs} ms`,
        ],
      },
    );
    updateDeployment(deployment.id, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      error: "",
    });
    upsertHealthCheck({
      deploymentId: deployment.id,
      appId: deployment.appId,
      appName: deployment.appName,
      serverId: deployment.serverId,
      port: deployment.port,
      healthPath: deployment.healthPath || "/",
      status: "healthy",
      httpStatus: health.httpStatus,
      responseMs: health.responseMs,
      consecutiveFailures: 0,
      message: `自动回滚后健康：HTTP ${health.httpStatus}`,
      checkedAt: new Date().toISOString(),
    });
    audit(
      "system:auto-recovery",
      "deployment.auto_rollback",
      `${deployment.appName} / ${deployment.environment}`,
      "success",
      {
        deploymentId: deployment.id,
        targetDeploymentId: input.target.id,
        targetImage: input.target.imageTag,
      },
    );
    return {
      recovered: true,
      message: `已自动回滚到 ${input.target.commitSha || input.target.imageTag} 并通过健康检查`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "自动回滚失败";
    const runningStep = failedStepMessage(state);
    if (runningStep?.key) {
      state = stepLog(
        deployment.id,
        state,
        runningStep.key,
        runningStep.name,
        "failed",
        message,
        "error",
        { exitCode: 1, result: message },
      );
    }
    updateDeployment(deployment.id, {
      status: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
    });
    audit(
      "system:auto-recovery",
      "deployment.auto_rollback",
      `${deployment.appName} / ${deployment.environment}`,
      "failed",
      { deploymentId: deployment.id, message },
    );
    return { recovered: false, message: `自动回滚失败：${message}` };
  }
}

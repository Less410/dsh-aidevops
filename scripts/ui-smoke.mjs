import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { aliyunRpcSignature } from "../services/api/dist/aliyun.js";

const projectRoot = process.cwd();
const artifactDirectory = path.join(projectRoot, "artifacts");
try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch {
  // Environment variables may be supplied by the host instead.
}
const edgePath =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = process.env.AI_DEVOPS_URL ?? "http://127.0.0.1:8787";
const email = process.env.ADMIN_EMAIL ?? "admin@aidevops.local";
const password = process.env.ADMIN_PASSWORD;
if (!password) {
  throw new Error("ADMIN_PASSWORD is required for the UI smoke test.");
}

assert.equal(
  aliyunRpcSignature("testsecret", {
    AccessKeyId: "testid",
    Action: "DescribeDedicatedHosts",
    Format: "JSON",
    RegionId: "cn-beijing",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: "edb2b34af0af9a6d14deaf7c1a5315eb",
    SignatureVersion: "1.0",
    Timestamp: "2023-03-13T08:34:30Z",
    Version: "2014-05-26",
  }),
  "9NaGiOspFP5UPcwX8Iwt2YJXXuk=",
  "阿里云 RPC 签名与官方固定向量不一致。",
);

fs.mkdirSync(artifactDirectory, { recursive: true });

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => {
  consoleErrors.push(error.message);
});

let cloudScanSummary = null;

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.screenshot({
    path: path.join(artifactDirectory, "01-login.png"),
    fullPage: true,
  });

  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByText("研发运维总览", { exact: true })
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const desktopLayout = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: `${element.tagName.toLowerCase()}.${String(element.className)
            .trim()
            .replace(/\s+/g, ".")}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter((item) => item.right > viewportWidth + 1 || item.left < -1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 8);
    return { viewportWidth, scrollWidth, scrollX: window.scrollX, offenders };
  });
  if (desktopLayout.scrollWidth > desktopLayout.viewportWidth + 1) {
    throw new Error(`桌面端出现横向溢出：${JSON.stringify(desktopLayout)}`);
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "02-dashboard.png"),
    fullPage: true,
  });

  if (process.env.RUN_CLOUD_SCAN_SMOKE === "1") {
    // The full cloud scan is an explicit action on the cloud page; the topbar
    // refresh only reloads the current page's own data.
    await page
      .locator(".nav-item")
      .filter({ hasText: "多云资源" })
      .first()
      .click();
    await page.getByText("统一资源视图", { exact: true }).waitFor();
    const syncAllButton = page.getByRole("button", { name: "同步云资源" });
    await syncAllButton.waitFor();
    const scanResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/cloud/scan-all"),
      { timeout: 90_000 },
    );
    await syncAllButton.click();
    const busyButton = page.getByRole("button", { name: "同步中" });
    await busyButton.waitFor({ timeout: 5_000 });
    if (!(await busyButton.isDisabled())) {
      throw new Error("云资源扫描期间，“同步云资源”按钮未进入禁用状态。");
    }

    const scanResponse = await scanResponsePromise;
    if (!scanResponse.ok()) {
      throw new Error(
        `云资源真实扫描失败：HTTP ${scanResponse.status()} ${await scanResponse.text()}`,
      );
    }
    const scanResult = await scanResponse.json();
    const { totals, accounts } = scanResult;
    if (!totals || totals.scannedAccounts < 1 || totals.resources < 1) {
      throw new Error(
        `云资源真实扫描未返回有效资源：${JSON.stringify(scanResult)}`,
      );
    }
    if (totals.domains < 1) {
      throw new Error(
        `云资源真实扫描未返回注册域名：${JSON.stringify(scanResult)}`,
      );
    }
    const unsupportedRegionWarnings = accounts.flatMap((account) =>
      (account.warnings ?? []).filter((warning) =>
        /UnsupportedRegion/i.test(warning),
      ),
    );
    if (unsupportedRegionWarnings.length > 0) {
      throw new Error(
        `已正常跳过的地域探测仍被记为告警：${unsupportedRegionWarnings.join("；")}`,
      );
    }

    const toast = page.locator(".toast");
    await toast.waitFor({ timeout: 15_000 });
    const toastText = (await toast.textContent()) ?? "";
    if (
      !toastText.includes(
        `${totals.scannedAccounts}/${totals.accounts} 个账号`,
      ) ||
      !toastText.includes(`${totals.resources} 个资源`) ||
      !toastText.includes(`${totals.domains} 个注册域名`)
    ) {
      throw new Error(`刷新完成提示内容不完整：${toastText}`);
    }

    await page
      .locator(".nav-item")
      .filter({ hasText: "多云资源" })
      .click();
    await page.getByText("统一资源视图", { exact: true }).waitFor();
    const domainSection = page
      .locator(".resource-category")
      .filter({ hasText: "注册域名" });
    const dnsSection = page
      .locator(".resource-category")
      .filter({ hasText: "DNS 域名" });
    await domainSection.waitFor();
    await dnsSection.waitFor();
    const registeredDomainCount = await domainSection
      .locator(".resource-card")
      .count();
    if (registeredDomainCount !== totals.domains) {
      throw new Error(
        `注册域名未完整展示：接口 ${totals.domains} 个，页面 ${registeredDomainCount} 个。`,
      );
    }
    const demoDomain = domainSection.getByText("example.com", {
      exact: true,
    });
    await demoDomain.waitFor({ timeout: 5_000 });
    const registeredDomainNames = await domainSection
      .locator(".resource-card strong")
      .allTextContents();
    await page.screenshot({
      path: path.join(artifactDirectory, "03a-cloud-domains.png"),
      fullPage: true,
    });
    cloudScanSummary = {
      totals,
      registeredDomainCount,
      registeredDomainNames,
      exampleDomainVisible: true,
    };
  }

  await page
    .locator(".nav-item")
    .filter({ hasText: "应用管理" })
    .click();
  await page.getByText("应用类型字段模板", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "02a-apps.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "新建应用" }).first().click();
  await page.getByRole("heading", { name: "新建应用" }).waitFor();
  await page.getByLabel("访问域名").waitFor();
  await page.getByRole("button", { name: /小程序/ }).click();
  await page.getByLabel("AppID").waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "02b-app-type-switch.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "取消" }).click();

  await page
    .locator(".nav-item")
    .filter({ hasText: "Ponytail" })
    .click();
  await page.getByText("生成 Ponytail 命令", { exact: true }).waitFor();
  await page.getByText("Ponytail v5.3.3 已就绪", { exact: true }).waitFor();
  if ((await page.locator(".ponytail-skill-grid button").count()) !== 6) {
    throw new Error("Ponytail 页面未完整展示六个 Skill。");
  }
  const ponytailMark = page.locator(".ponytail-mark");
  await ponytailMark.waitFor();
  await page
    .locator(".ponytail-install-state")
    .getByText(/Skills 目录：D:\\CodexHome\\plugins\\cache\\ponytail/)
    .waitFor();
  const ponytailTask =
    "UI_SMOKE_PRIVATE_TASK_20261030_不要写入平台审计";
  await page
    .getByPlaceholder("例如：把设置页的保存逻辑改简单，并补一个关键测试")
    .fill(ponytailTask);
  await page
    .locator(".ponytail-command-preview code")
    .getByText(`$ponytail:ponytail full ${ponytailTask}`, { exact: true })
    .waitFor();
  const ponytailCountBefore = Number(
    await page.locator(".ponytail-period-grid strong").nth(1).textContent(),
  );
  const activityRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/ponytail/activity"),
  );
  const activityResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/ponytail/activity"),
  );
  await page.getByRole("button", { name: "复制命令" }).click();
  await page.getByRole("button", { name: "已复制" }).waitFor();
  const activityRequest = await activityRequestPromise;
  const activityBody = activityRequest.postDataJSON();
  if (
    JSON.stringify(activityBody).includes(ponytailTask) ||
    activityBody.skill !== "ponytail" ||
    activityBody.mode !== "full" ||
    Object.keys(activityBody).length !== 2
  ) {
    throw new Error(
      `Ponytail 活动请求包含多余数据：${JSON.stringify(activityBody)}`,
    );
  }
  const activityResponse = await activityResponsePromise;
  if (!activityResponse.ok()) {
    throw new Error(
      `Ponytail 活动记录失败：HTTP ${activityResponse.status()} ${await activityResponse.text()}`,
    );
  }
  await page.waitForFunction(
    (countBefore) =>
      Number(
        document.querySelectorAll(".ponytail-period-grid strong")[1]
          ?.textContent,
      ) === countBefore + 1,
    ponytailCountBefore,
  );
  const sessionToken = await page.evaluate(
    () => localStorage.getItem("ai-devops-session") ?? "",
  );
  if (!sessionToken) throw new Error("Ponytail 冒烟测试缺少登录会话。");
  const sessionHeaders = { Authorization: `Bearer ${sessionToken}` };
  const recordActivity = (body, authenticated) =>
    page.request.post(`${baseUrl}/api/ponytail/activity`, {
      headers: authenticated
        ? { ...sessionHeaders, "Content-Type": "application/json" }
        : { "Content-Type": "application/json" },
      data: body,
    });
  const [
    unauthorizedGetResponse,
    unauthorizedPostResponse,
    invalidSkillResponse,
    invalidModeResponse,
    nonCodingWithModeResponse,
  ] = await Promise.all([
    page.request.get(`${baseUrl}/api/ponytail`),
    recordActivity({ skill: "ponytail", mode: "full" }, false),
    recordActivity({ skill: "not-a-skill", mode: null }, true),
    recordActivity({ skill: "ponytail", mode: "turbo" }, true),
    recordActivity({ skill: "ponytail-review", mode: "full" }, true),
  ]);
  const auditResponse = await page.request.get(
    `${baseUrl}/api/audit?limit=200`,
    { headers: sessionHeaders },
  );
  const ponytailApiChecks = {
    unauthorizedGet: unauthorizedGetResponse.status(),
    unauthorizedPost: unauthorizedPostResponse.status(),
    invalidSkill: invalidSkillResponse.status(),
    invalidMode: invalidModeResponse.status(),
    nonCodingWithMode: nonCodingWithModeResponse.status(),
    auditStatus: auditResponse.status(),
    auditContainsTask: (await auditResponse.text()).includes(ponytailTask),
  };
  const expectedPonytailApiChecks = {
    unauthorizedGet: 401,
    unauthorizedPost: 401,
    invalidSkill: 400,
    invalidMode: 400,
    nonCodingWithMode: 400,
    auditStatus: 200,
    auditContainsTask: false,
  };
  for (const [check, expected] of Object.entries(expectedPonytailApiChecks)) {
    if (ponytailApiChecks[check] !== expected) {
      throw new Error(
        `Ponytail API 边界检查失败：${check}=${ponytailApiChecks[check]}，预期 ${expected}`,
      );
    }
  }
  const ponytailLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (ponytailLayout.scrollWidth > ponytailLayout.viewportWidth + 1) {
    throw new Error(
      `桌面端 Ponytail 出现横向溢出：${ponytailLayout.scrollWidth}px > ${ponytailLayout.viewportWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "02a-ponytail.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    window.location.hash = "#overview";
  });
  const ponytailOverview = page.locator(".ponytail-overview-card");
  await ponytailOverview.getByText("精简开发 Skill", { exact: true }).waitFor();
  await ponytailOverview.getByText("v5.3.3 完整可用", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "02b-ponytail-overview.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    window.location.hash = "#pipelines";
  });
  await page.getByRole("heading", { name: "项目发布" }).waitFor();
  if ((await page.locator(".runs-panel").count()) > 0) {
    throw new Error("发布流水线仍在用户界面展示旧门禁运行历史。");
  }
  const firstProject = page.locator(".project-release-card").first();
  if ((await firstProject.count()) > 0) {
    await firstProject.click();
    await page.getByText("发布历史（真实部署）", { exact: true }).waitFor();
    if ((await page.locator(".runs-panel").count()) > 0) {
      throw new Error("项目详情仍在展示旧门禁运行历史。");
    }
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "02c-project-releases.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    window.location.hash = "#versions";
  });
  await page.getByText("版本中心（真实部署）", { exact: true }).waitFor();
  await page.getByText("版本中心", { exact: true }).first().waitFor();
  const versionRows = page.locator(".deployments-panel .data-table tbody tr");
  if ((await versionRows.count()) > 0) {
    await versionRows.first().getByRole("button", { name: "详情" }).click();
    await page.getByRole("heading", { name: /部署详情/ }).waitFor();
    await page.getByText("执行步骤", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(artifactDirectory, "02e-version-detail.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
  const rollbackButton = page.getByRole("button", {
    name: "回滚",
    exact: true,
  }).first();
  if ((await rollbackButton.count()) > 0) {
    await rollbackButton.click();
    await page.getByText("确认创建回滚审批单", { exact: true }).waitFor();
    await page
      .getByText("确认创建回滚审批单", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(artifactDirectory, "02f-rollback-confirm.png"),
      fullPage: true,
    });
    await page
      .locator(".rollback-confirm")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "02d-version-center.png"),
    fullPage: true,
  });

  await page
    .locator(".nav-item")
    .filter({ hasText: "使用指南" })
    .click();
  await page.getByText("你负责什么", { exact: true }).waitFor();
  await page.getByRole("button", { name: "复制指令" }).first().click();
  await page.getByRole("button", { name: "已复制" }).first().waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "02b-beginner-guide.png"),
    fullPage: true,
  });

  await page
    .locator(".nav-item")
    .filter({ hasText: "多云资源" })
    .click();
  await page.getByText("统一资源视图", { exact: true }).waitFor();
  await page.getByRole("button", { name: "登记云账号" }).click();
  await page.getByRole("heading", { name: "登记云账号" }).waitFor();
  await page
    .locator(".cloud-provider-choice button")
    .filter({ hasText: "阿里云" })
    .click();
  const aliyunMainLogin = page.getByRole("link", {
    name: /先登录阿里云官方控制台/,
  });
  await aliyunMainLogin.waitFor();
  if (
    (await aliyunMainLogin.getAttribute("href")) !==
    "https://account.aliyun.com/login/login.htm"
  ) {
    throw new Error("阿里云登录入口没有指向官方登录页。");
  }
  const aliyunForm = page.locator("form.modal-form");
  const officialLinks = [
    ["打开账号中心", "https://account.console.aliyun.com/"],
    [
      "打开 AccessKey 管理",
      "https://usercenter.console.aliyun.com/#/manage/ak",
    ],
    [
      "查看 AccessKey 创建文档",
      "https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair",
    ],
  ];
  for (const [name, expectedHref] of officialLinks) {
    const link = aliyunForm.getByRole("link", { name });
    await link.waitFor();
    if ((await link.getAttribute("href")) !== expectedHref) {
      throw new Error(`阿里云信息获取入口“${name}”地址不正确。`);
    }
  }
  if (
    (await aliyunForm
      .getByText("Secret Manager 引用", { exact: true })
      .count()) > 0
  ) {
    throw new Error("阿里云登记表单不应显示 Secret Manager 引用。");
  }
  await aliyunForm.getByLabel(/主账号 ID \(UID/).waitFor();
  await aliyunForm.getByLabel("AccessKey ID", { exact: true }).waitFor();
  await aliyunForm.getByLabel(/^AccessKey Secret/).waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "03a-aliyun-account.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.screenshot({
    path: path.join(artifactDirectory, "03-cloud.png"),
    fullPage: true,
  });

  await page
    .locator(".nav-item")
    .filter({ hasText: "平台设置" })
    .click();
  await page
    .getByRole("heading", { name: "智能体对接（Agent Bridge + MCP）" })
    .waitFor();
  const mcpConfigBox = page
    .locator(".agent-prompt-box")
    .filter({ hasText: "MCP 配置（WorkBuddy / Codex / Cursor）" });
  const mcpConfig = JSON.parse(
    (await mcpConfigBox.locator("pre").textContent()) ?? "{}",
  );
  const aiDevOpsServer = mcpConfig.mcpServers?.["ai-devops"];
  assert.equal(aiDevOpsServer?.type, "stdio");
  assert.equal(
    aiDevOpsServer?.command,
    "D:\\AI-DevOps\\runtime\\node\\node.exe",
  );
  assert.match(
    aiDevOpsServer?.args?.[0] ?? "",
    /bridge\\mcp\\ai-devops-mcp\.mjs$/,
  );
  assert.equal(aiDevOpsServer?.env?.AI_DEVOPS_URL, baseUrl);
  assert.equal(
    aiDevOpsServer?.env?.AI_DEVOPS_AGENT_TOKEN,
    "<粘贴新创建的智能体令牌>",
  );
  await mcpConfigBox
    .getByText("Authorization: Bearer <AI_DEVOPS_AGENT_TOKEN>", {
      exact: true,
    })
    .waitFor();
  const bridgePrompt =
    (await page
      .locator(".agent-prompt-box")
      .filter({ hasText: "对接指令（发给任意智能体）" })
      .locator("pre")
      .textContent()) ?? "";
  assert.match(bridgePrompt, /当前只做只读接入检查/);
  assert.match(bridgePrompt, /没有代码改动.*不得推送/);
  assert.doesNotMatch(bridgePrompt, /把最新代码推送到/);
  await page.screenshot({
    path: path.join(artifactDirectory, "03b-agent-bridge.png"),
    fullPage: true,
  });

  await page
    .locator(".nav-item")
    .filter({ hasText: "AI Copilot" })
    .click();
  await page
    .getByPlaceholder("询问发布状态、故障原因或云资源风险…")
    .fill("分析最近一次流水线失败");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByText(/我检查了最近 20 条真实部署记录/).waitFor({
    timeout: 10_000,
  });
  await page.screenshot({
    path: path.join(artifactDirectory, "04-copilot.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.location.hash = "#overview";
  });
  await page.waitForTimeout(350);
  const mobileLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (mobileLayout.scrollWidth > mobileLayout.viewportWidth + 1) {
    throw new Error(
      `移动端出现横向溢出：${mobileLayout.scrollWidth}px > ${mobileLayout.viewportWidth}px`,
    );
  }
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.locator(".sidebar.is-open").waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "05-mobile-dashboard.png"),
    fullPage: true,
  });
  await page.locator(".mobile-close").click();
  await page.locator(".sidebar.is-open").waitFor({ state: "hidden" });

  await page.evaluate(() => {
    window.location.hash = "#guide";
  });
  await page.getByText("你负责什么", { exact: true }).waitFor();
  const mobileGuideLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (mobileGuideLayout.scrollWidth > mobileGuideLayout.viewportWidth + 1) {
    throw new Error(
      `移动端指南出现横向溢出：${mobileGuideLayout.scrollWidth}px > ${mobileGuideLayout.viewportWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "06-mobile-guide.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    window.location.hash = "#versions";
  });
  await page.getByText("版本中心（真实部署）", { exact: true }).waitFor();
  const mobileVersionLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    toolbarWidth:
      document.querySelector(".version-center-page .page-toolbar > div")
        ?.getBoundingClientRect().width ?? 0,
  }));
  if (mobileVersionLayout.scrollWidth > mobileVersionLayout.viewportWidth + 1) {
    throw new Error(
      `移动端版本中心出现横向溢出：${mobileVersionLayout.scrollWidth}px > ${mobileVersionLayout.viewportWidth}px`,
    );
  }
  if (mobileVersionLayout.toolbarWidth < 240) {
    throw new Error(
      `移动端版本中心工具栏被异常压缩：${mobileVersionLayout.toolbarWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "07-mobile-version-center.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    window.location.hash = "#ponytail";
  });
  await page.getByText("生成 Ponytail 命令", { exact: true }).waitFor();
  const mobilePonytailLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (
    mobilePonytailLayout.scrollWidth >
    mobilePonytailLayout.viewportWidth + 1
  ) {
    throw new Error(
      `移动端 Ponytail 出现横向溢出：${mobilePonytailLayout.scrollWidth}px > ${mobilePonytailLayout.viewportWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "08-mobile-ponytail.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(250);
  const narrowPonytailLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (
    narrowPonytailLayout.scrollWidth >
    narrowPonytailLayout.viewportWidth + 1
  ) {
    throw new Error(
      `320px Ponytail 出现横向溢出：${narrowPonytailLayout.scrollWidth}px > ${narrowPonytailLayout.viewportWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "08a-320px-ponytail.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 858, height: 782 });
  await page.waitForTimeout(250);
  const tabletVersionLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    filterFieldMinWidth: Math.min(
      ...[...document.querySelectorAll(".version-filter-field")].map(
        (element) => element.getBoundingClientRect().width,
      ),
    ),
  }));
  if (tabletVersionLayout.scrollWidth > tabletVersionLayout.viewportWidth + 1) {
    throw new Error(
      `平板端版本中心出现横向溢出：${tabletVersionLayout.scrollWidth}px > ${tabletVersionLayout.viewportWidth}px`,
    );
  }
  if (tabletVersionLayout.filterFieldMinWidth < 150) {
    throw new Error(
      `平板端版本筛选控件被过度压缩：${tabletVersionLayout.filterFieldMinWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "08-tablet-version-center.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    window.location.hash = "#ponytail";
  });
  await page.getByText("生成 Ponytail 命令", { exact: true }).waitFor();
  const tabletPonytailLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (
    tabletPonytailLayout.scrollWidth >
    tabletPonytailLayout.viewportWidth + 1
  ) {
    throw new Error(
      `平板端 Ponytail 出现横向溢出：${tabletPonytailLayout.scrollWidth}px > ${tabletPonytailLayout.viewportWidth}px`,
    );
  }
  await page.screenshot({
    path: path.join(artifactDirectory, "09-tablet-ponytail.png"),
    fullPage: true,
  });

  if (consoleErrors.length > 0) {
    throw new Error(`浏览器控制台出现错误：\n${consoleErrors.join("\n")}`);
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        pages: [
          "login",
          "dashboard",
          "apps",
          "app-type-switch",
          "ponytail",
          "ponytail-overview",
          "project-releases",
          "version-center",
          "beginner-guide",
          "cloud",
          "settings-agent-bridge",
          "copilot",
          "mobile-dashboard",
          "mobile-guide",
          "mobile-version-center",
          "mobile-ponytail",
          "320px-ponytail",
          "tablet-version-center",
          "tablet-ponytail",
        ],
        screenshots: artifactDirectory,
        desktopLayout,
        mobileLayout,
        mobileGuideLayout,
        mobileVersionLayout,
        mobilePonytailLayout,
        narrowPonytailLayout,
        tabletVersionLayout,
        tabletPonytailLayout,
        ponytailApiChecks,
        cloudScanSummary,
        consoleErrors: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

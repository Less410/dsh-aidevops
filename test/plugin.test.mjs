import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apply, inject, name } from "../index.js";

const realFetch = globalThis.fetch;
const savedEnv = {
  url: process.env.AI_DEVOPS_URL,
  token: process.env.AI_DEVOPS_AGENT_TOKEN,
};

function makeCtx() {
  const tools = [];
  const ctx = {
    tools: {
      register(spec) {
        tools.push(spec);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, tools };
}

function toolNamed(tools, toolName) {
  const tool = tools.find((item) => item.name === toolName);
  assert.ok(tool, `missing tool ${toolName}`);
  return tool;
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = await handler(String(url), init);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(result.body ?? {}),
    };
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv.url === undefined) delete process.env.AI_DEVOPS_URL;
  else process.env.AI_DEVOPS_URL = savedEnv.url;
  if (savedEnv.token === undefined) delete process.env.AI_DEVOPS_AGENT_TOKEN;
  else process.env.AI_DEVOPS_AGENT_TOKEN = savedEnv.token;
});

test("declares the cordis plugin shape", () => {
  assert.equal(name, "dsh-ai-devops");
  assert.deepEqual(inject, ["tools"]);
});

test("registers the four ai_devops tools", () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787", token: "aid_test" });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["ai_devops_deliver", "ai_devops_health", "ai_devops_resources", "ai_devops_status"],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
  }
});

test("health calls the platform health endpoint", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787/", token: "aid_test" });
  const calls = stubFetch(() => ({
    body: { status: "ok", service: "ai-devops-control-plane" },
  }));
  const result = await toolNamed(tools, "ai_devops_health").execute({});
  assert.equal(calls[0].url, "http://127.0.0.1:8787/api/health");
  assert.equal(result.ok, true);
  assert.equal(result.platform.status, "ok");
});

test("agent tools send the bearer token", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://example.test:8787", token: "aid_secret" });
  const calls = stubFetch(() => ({ body: { deployments: [] } }));
  await toolNamed(tools, "ai_devops_status").execute({});
  assert.equal(calls[0].url, "http://example.test:8787/api/agent/status");
  assert.equal(calls[0].init.headers.Authorization, "Bearer aid_secret");
});

test("missing token is reported as a configuration problem", async () => {
  delete process.env.AI_DEVOPS_AGENT_TOKEN;
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787" });
  await assert.rejects(
    () => toolNamed(tools, "ai_devops_status").execute({}),
    /未配置 AI DevOps 智能体令牌/,
  );
});

test("platform error messages surface unchanged", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787", token: "aid_wrong" });
  stubFetch(() => ({ status: 401, body: { message: "智能体令牌无效或已撤销。" } }));
  await assert.rejects(
    () => toolNamed(tools, "ai_devops_status").execute({}),
    /智能体令牌无效或已撤销/,
  );
});

test("resources are formatted with real metrics", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787", token: "aid_test" });
  stubFetch(() => ({
    body: {
      resources: [
        {
          provider: "aliyun",
          resourceType: "ECS",
          name: "demo-ecs",
          region: "cn-hangzhou",
          accountName: "ai-devops",
          status: "healthy",
          metrics: { cpuPercent: 0, memoryPercent: 42.5, status: "ok", updatedAt: "2026-11-10T00:00:00.000Z" },
          metricsUpdatedAt: "2026-11-10T00:00:00.000Z",
        },
      ],
    },
  }));
  const result = await toolNamed(tools, "ai_devops_resources").execute({ accountId: "acc 1" });
  assert.equal(result.count, 1);
  assert.match(result.summary, /aliyun \/ ECS \/ demo-ecs/);
  assert.match(result.summary, /CPU 0% · 内存 42.5%/);
});

test("resources pass the account filter through", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787", token: "aid_test" });
  const calls = stubFetch(() => ({ body: { resources: [] } }));
  const result = await toolNamed(tools, "ai_devops_resources").execute({ accountId: "acc 1" });
  assert.equal(calls[0].url, "http://127.0.0.1:8787/api/agent/resources?accountId=acc%201");
  assert.equal(result.count, 0);
});

test("deliver posts the payload and returns the platform message", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787", token: "aid_test" });
  const calls = stubFetch(() => ({ body: { message: "已创建 staging 交付任务。" } }));
  const result = await toolNamed(tools, "ai_devops_deliver").execute({
    repositoryName: "demo",
    appName: "demo-web",
    environment: "staging",
  });
  assert.equal(calls[0].url, "http://127.0.0.1:8787/api/agent/deliver");
  assert.equal(calls[0].init.method, "POST");
  // JSON.stringify drops undefined fields, so only the provided ones travel.
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    repositoryName: "demo",
    appName: "demo-web",
    environment: "staging",
  });
  assert.equal(result.message, "已创建 staging 交付任务。");
});

test("deliver rejects unknown environments before calling the platform", async () => {
  const { ctx, tools } = makeCtx();
  apply(ctx, { baseUrl: "http://127.0.0.1:8787", token: "aid_test" });
  const calls = stubFetch(() => ({ body: {} }));
  await assert.rejects(
    () => toolNamed(tools, "ai_devops_deliver").execute({ environment: "prod" }),
    /"environment" must be one of \["development","staging","production"\]/,
  );
  assert.equal(calls.length, 0);
});

test("env vars provide the defaults", async () => {
  process.env.AI_DEVOPS_URL = "http://example.test:9999///";
  process.env.AI_DEVOPS_AGENT_TOKEN = "aid_env";
  const { ctx, tools } = makeCtx();
  apply(ctx);
  const calls = stubFetch(() => ({ body: { deployments: [] } }));
  await toolNamed(tools, "ai_devops_status").execute({});
  assert.equal(calls[0].url, "http://example.test:9999/api/agent/status");
  assert.equal(calls[0].init.headers.Authorization, "Bearer aid_env");
});

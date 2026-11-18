import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

const artifactDirectory = path.resolve("data/test-artifacts");
const testDatabasePath = path.join(
  artifactDirectory,
  `agent-routes-${process.pid}-${Date.now()}.sqlite`,
);
fs.mkdirSync(artifactDirectory, { recursive: true });

process.env.DATABASE_PATH = testDatabasePath;
process.env.JWT_SECRET = "agent-test-secret-not-for-production";
process.env.ADMIN_PASSWORD = "agent-test-admin-password";
process.env.DEMO_MODE = "false";

let app: FastifyInstance | undefined;
let database: { close: () => void } | undefined;
let agentToken = "";

before(async () => {
  const db = await import("../src/db.js");
  const { registerRoutes } = await import("../src/routes.js");
  database = db.db;
  agentToken = db.createAgentToken("test-agent").token;

  const accountId = db.createCloudAccount({
    name: "测试云账号",
    provider: "aliyun",
    region: "cn-hangzhou",
    accountType: "main",
    ownerId: "123456789",
    accessKeyId: "test-access-key",
    secretKey: "test-secret-key",
    note: "",
  });
  db.replaceCloudResources(
    accountId,
    [
      {
        id: "i-test",
        type: "ECS",
        name: "test-ecs",
        status: "healthy",
        region: "cn-hangzhou",
        attributes: {
          AccessKeyId: "must-not-leak",
          Secret: "must-not-leak",
          credentialRef: "must-not-leak",
        },
        tags: { environment: "test" },
        metrics: {
          status: "ok",
          cpuPercent: 0,
          memoryPercent: 42.5,
          periodSeconds: 60,
          updatedAt: "2026-11-02T00:00:00.000Z",
        },
        metricsUpdatedAt: "2026-11-02T00:00:00.000Z",
      },
    ],
    "cn-hangzhou",
    true,
  );

  app = Fastify({ logger: false });
  await registerRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  database?.close();
  for (const suffix of ["", "-journal", "-shm", "-wal"]) {
    fs.rmSync(`${testDatabasePath}${suffix}`, { force: true });
  }
});

test("智能体接口只接受 Bearer 令牌", async () => {
  assert.ok(app);
  const queryToken = await app.inject({
    method: "GET",
    url: `/api/agent/status?token=${encodeURIComponent(agentToken)}`,
  });
  assert.equal(queryToken.statusCode, 401);

  const missingToken = await app.inject({
    method: "GET",
    url: "/api/agent/resources",
  });
  assert.equal(missingToken.statusCode, 401);

  const validToken = await app.inject({
    method: "GET",
    url: "/api/agent/status",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(validToken.statusCode, 200);
  assert.equal(validToken.json().agent, "test-agent");
});

test("智能体不能审批、执行写操作或创建新令牌", async () => {
  assert.ok(app);
  const calls = [
    { method: "POST" as const, url: "/api/apps", payload: { name: "blocked" } },
    {
      method: "POST" as const,
      url: "/api/deployments/missing/approve",
      payload: {},
    },
    {
      method: "POST" as const,
      url: "/api/cloud/lighthouse/lhins-test/firewall/open",
      payload: { port: 80 },
    },
    {
      method: "POST" as const,
      url: "/api/agent/tokens",
      payload: { name: "blocked" },
    },
  ];

  for (const call of calls) {
    const response = await app.inject({
      ...call,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    assert.equal(response.statusCode, 401, `${call.method} ${call.url}`);
  }
});

test("管理员可以重命名、撤销并删除已撤销的智能体令牌", async () => {
  assert.ok(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@aidevops.local",
      password: process.env.ADMIN_PASSWORD,
    },
  });
  assert.equal(login.statusCode, 200);
  const auth = { authorization: `Bearer ${login.json().token}` };

  const created = await app.inject({
    method: "POST",
    url: "/api/agent/tokens",
    headers: auth,
    payload: { name: "待整理令牌" },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().record.id;

  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/agent/tokens/${id}`,
    headers: auth,
    payload: { name: "已重命名令牌" },
  });
  assert.equal(renamed.statusCode, 200);

  const listed = await app.inject({
    method: "GET",
    url: "/api/agent/tokens",
    headers: auth,
  });
  assert.equal(
    listed.json().tokens.find((item: { id: string }) => item.id === id)?.name,
    "已重命名令牌",
  );

  const activeDelete = await app.inject({
    method: "DELETE",
    url: `/api/agent/tokens/${id}`,
    headers: auth,
  });
  assert.equal(activeDelete.statusCode, 409);

  const revoked = await app.inject({
    method: "POST",
    url: `/api/agent/tokens/${id}/revoke`,
    headers: auth,
  });
  assert.equal(revoked.statusCode, 200);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/agent/tokens/${id}`,
    headers: auth,
  });
  assert.equal(deleted.statusCode, 200);

  const after = await app.inject({
    method: "GET",
    url: "/api/agent/tokens",
    headers: auth,
  });
  assert.equal(
    after.json().tokens.some((item: { id: string }) => item.id === id),
    false,
  );
});

test("资源接口返回真实指标且不泄露厂商属性或密钥", async () => {
  assert.ok(app);
  const response = await app.inject({
    method: "GET",
    url: "/api/agent/resources",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(response.statusCode, 200);

  const resource = response
    .json()
    .resources.find((item: { externalId: string }) => item.externalId === "i-test");
  assert.ok(resource);
  assert.equal(resource.metrics.cpuPercent, 0);
  assert.equal(resource.metrics.memoryPercent, 42.5);
  assert.doesNotMatch(
    response.body,
    /attributes|AccessKeyId|"Secret"|credentialRef/,
  );
});

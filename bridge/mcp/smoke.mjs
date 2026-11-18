import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectNode = path.resolve(
  packageDirectory,
  "..",
  "..",
  "runtime",
  "node",
  "node.exe",
);

const client = new Client({
  name: "ai-devops-mcp-smoke",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: fs.existsSync(projectNode) ? projectNode : process.execPath,
  args: [path.join(packageDirectory, "ai-devops-mcp.mjs")],
  cwd: packageDirectory,
  env: {
    ...process.env,
    AI_DEVOPS_URL:
      process.env.AI_DEVOPS_URL?.replace(/\/+$/, "") ?? "http://127.0.0.1:8787",
    AI_DEVOPS_AGENT_TOKEN: "smoke-test-no-privilege",
  },
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "ai_devops_deliver",
      "ai_devops_health",
      "ai_devops_resources",
      "ai_devops_status",
    ],
  );

  const health = await client.callTool({
    name: "ai_devops_health",
    arguments: {},
  });
  assert.notEqual(health.isError, true);
  const text = health.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(text, /AI DevOps 在线/);

  const unauthenticatedStatus = await client.callTool({
    name: "ai_devops_status",
    arguments: {},
  });
  assert.equal(unauthenticatedStatus.isError, true);
  assert.match(
    unauthenticatedStatus.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    /令牌无效或已撤销/,
  );

  console.log(
    JSON.stringify(
      {
        status: "passed",
        tools: listed.tools.map((tool) => tool.name),
        health: text,
        authenticationBoundary: "invalid-token-rejected",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

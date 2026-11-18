import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDeliveryServer } from "../src/delivery-target.js";

const aliyun = { id: "aliyun-1", name: "阿里云-示例", host: "203.0.113.10" };
const tencent = { id: "tencent-1", name: "腾讯云-示例", host: "198.51.100.20" };
const servers = [tencent, aliyun];

test("未指定服务器时按仓库绑定选择", () => {
  const server = resolveDeliveryServer(servers, {
    preferredServerId: "aliyun-1",
  });
  assert.equal(server.id, "aliyun-1");
});

test("仓库没有绑定时回退第一台", () => {
  const server = resolveDeliveryServer(servers, { preferredServerId: "" });
  assert.equal(server.id, "tencent-1");
});

test("显式指定服务器支持 id、名称和 IP", () => {
  for (const requested of ["aliyun-1", "阿里云-示例", "203.0.113.10"]) {
    const server = resolveDeliveryServer(servers, { requested });
    assert.equal(server.id, "aliyun-1", requested);
  }
});

test("显式指定优先于仓库绑定", () => {
  const server = resolveDeliveryServer(servers, {
    requested: "腾讯云-示例",
    preferredServerId: "aliyun-1",
  });
  assert.equal(server.id, "tencent-1");
});

test("指定了不存在的服务器时报错而不是回退", () => {
  assert.throws(
    () => resolveDeliveryServer(servers, { requested: "不存在的服务器" }),
    /服务器不存在/,
  );
});

test("仓库绑定的服务器已删除时报错而不是回退", () => {
  assert.throws(
    () => resolveDeliveryServer(servers, { preferredServerId: "gone" }),
    /仓库绑定的服务器已不存在/,
  );
});

test("没有登记服务器时报错", () => {
  assert.throws(
    () => resolveDeliveryServer([], { preferredServerId: "aliyun-1" }),
    /还没有登记任何服务器/,
  );
});

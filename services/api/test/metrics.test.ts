import assert from "node:assert/strict";
import test from "node:test";
import { parseAliyunMetricValues } from "../src/aliyun.js";
import { parseTencentMetricValues } from "../src/tencent.js";

test("腾讯云指标保留最新真实值，包括 0%", () => {
  const values = parseTencentMetricValues({
    DataPoints: [
      {
        Dimensions: [{ Name: "InstanceId", Value: "ins-test" }],
        Timestamps: [100, 200],
        Values: [12.5, 0],
      },
    ],
  });

  assert.equal(values.get("ins-test"), 0);
});

test("腾讯云指标不把空值伪装成 0%", () => {
  for (const rawValue of [null, "", " "]) {
    const values = parseTencentMetricValues({
      DataPoints: [
        {
          Dimensions: [{ Name: "InstanceId", Value: "ins-test" }],
          Timestamps: [100],
          Values: [rawValue],
        },
      ],
    });
    assert.equal(values.size, 0);
  }

  assert.equal(parseTencentMetricValues({ DataPoints: [] }).size, 0);
});

test("阿里云指标支持 JSON 字符串并保留最新 0%", () => {
  const values = parseAliyunMetricValues(
    JSON.stringify([
      { instanceId: "i-test", timestamp: 100, Average: "12.5" },
      { instanceId: "i-test", timestamp: 200, Average: 0 },
    ]),
  );

  assert.equal(values.get("i-test"), 0);
});

test("阿里云指标不把空值伪装成 0%", () => {
  for (const rawValue of [null, "", " "]) {
    const values = parseAliyunMetricValues([
      { instanceId: "i-test", timestamp: 100, Average: rawValue },
    ]);
    assert.equal(values.size, 0);
  }

  assert.equal(parseAliyunMetricValues("not-json").size, 0);
});

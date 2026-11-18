#!/usr/bin/env node
// 只检查暂存区新增行，命中真实地址/域名/密钥就拦下提交。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const diff = execFileSync("git", ["diff", "--cached", "--no-color", "-U0"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 << 20,
});

// 文档保留地址与厂商示例放行
const safeIp = /^(?:0\.0\.0\.0|127\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|255\.|119\.29\.100\.20$)/;
const rules = [
  ["真实 IP（用 203.0.113.x 占位）", /\b(?:\d{1,3}\.){3}\d{1,3}\b/, (m) => !safeIp.test(m)],
  ["真实域名（用 example.com 占位）", /\b[a-z0-9-]{2,}\.(?:cn|com\.cn)\b/i],
  ["密钥/令牌", /(?:aid_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|LTAI[A-Za-z0-9]{10,}|AKID[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9_-]{15,}|glpat-[A-Za-z0-9_-]{15,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,})/],
  ["TCR 命名空间（用 CCR_NAMESPACE / examplespace）", /ccr\.ccs\.tencentyun\.com\/(?!examplespace\b)[a-z0-9_-]+/i],
];

// 本机私有的敏感词表，不进仓库
const localLists = join(root, ".githooks", "sensitive.local.txt");
if (existsSync(localLists)) {
  const words = readFileSync(localLists, "utf8").split(/\r?\n/).map((w) => w.trim()).filter((w) => w && !w.startsWith("#"));
  if (words.length > 0) {
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    rules.push(["真实名称（用示例值占位）", new RegExp(pattern, "i")]);
  }
}

const hits = [];
let file = "";
let lineNo = 0;

for (const line of diff.split(/\r?\n/)) {
  const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
  if (fileMatch) { file = fileMatch[1]; continue; }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) { lineNo = Number(hunk[1]); continue; }
  if (line.startsWith("+")) {
    const text = line.slice(1);
    for (const [label, re, allow] of rules) {
      const match = re.exec(text);
      if (match && (!allow || allow(match[0]))) {
        hits.push({ file, line: lineNo, label, text: text.trim().slice(0, 120) });
        break;
      }
    }
    lineNo += 1;
  } else if (!line.startsWith("-")) {
    lineNo += 1;
  }
}

if (hits.length === 0) process.exit(0);

console.error("\n提交被拦下：暂存区里有疑似真实数据，这个仓库是公开的。");
for (const hit of hits.slice(0, 20)) console.error(`  [${hit.label}] ${hit.file}:${hit.line}\n      ${hit.text}`);
if (hits.length > 20) console.error(`  … 另有 ${hits.length - 20} 处`);
console.error("\n处理方式：换成占位值（203.0.113.x / example.com / 示例站点），或把真实值写进 .env（已被忽略）。");
console.error("确认不是真实数据时可用 git commit --no-verify 跳过本次检查。\n");
process.exit(1);

#!/usr/bin/env bun
/**
 * 集成测试：项目上下文发现、app 标签自动注入、环境切换（含 prod 真实连通）。
 * 用法：bun run test/integration.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = new URL("../index.ts", import.meta.url).pathname;

// 临时项目目录：验证 server 从 cwd 向上发现 .grafana.json
const projectDir = mkdtempSync(join(tmpdir(), "grafana-mcp-test-"));
writeFileSync(
  join(projectDir, ".grafana.json"),
  JSON.stringify(
    {
      defaultEnv: "test",
      app: "grafana",
      appLabel: "app",
      namespace: "monitoring",
      notes: "集成测试项目上下文",
    },
    null,
    2,
  ),
);

const child = spawn("bun", ["run", serverPath], {
  cwd: projectDir,
  env: { ...process.env, GRAFANA_ENV: "test" },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let buffer = "";

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const id = typeof msg.id === "number" ? msg.id : undefined;
    if (id !== undefined && pending.has(id)) {
      const p = pending.get(id)!;
      pending.delete(id);
      if (msg.error) p.reject(new Error(String(msg.error.message)));
      else p.resolve(msg.result);
    }
  }
});

function request(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`请求 ${method} 超时`));
      }
    }, 40_000);
  });
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = async (name: string, args?: unknown) => request("tools/call", { name, arguments: args ?? {} });

  console.log("── 项目上下文（GRAFANA_ENV=test + 临时目录 .grafana.json）──");
  const ctx = textOf(await call("project_context"));
  check("初始环境来自 GRAFANA_ENV", ctx.includes("初始环境来源: 环境变量 GRAFANA_ENV"), ctx.split("\n")[2]);
  check("发现项目 .grafana.json", ctx.includes("grafana-mcp-test-"), "未在输出中找到临时项目路径");
  check("项目 App 正确", ctx.includes("项目 App: grafana"), ctx);

  console.log("── loki_query app 自动注入 ──");
  const loki = textOf(await call("loki_query", { query: '{job=~".+"}', range: "30m", limit: 3 }));
  check("注入了 app=\"grafana\"", loki.includes(`app="grafana"`), loki.split("\n").slice(0, 4).join("\n"));

  console.log("── loki_labels 项目 app 校验 ──");
  const labels = textOf(await call("loki_labels", { label: "app", range: "24h" }));
  check("提示项目 app 存在于取值列表", labels.includes('在取值列表中'), labels.split("\n").slice(-3).join("\n"));

  console.log("── prom_instant 连通性（数据源 UID 解析）──");
  const prom = textOf(await call("prom_instant", { query: "count(up)" }));
  check("Prometheus 查询成功", !prom.startsWith("Error:"), prom.slice(0, 200));
  check("返回了序列", /→\s*[1-9]/.test(prom) || prom.includes("条结果"), prom.slice(0, 300));

  console.log("── switch_environment → prod ──");
  const switched = textOf(await call("switch_environment", { env: "prod" }));
  check("已切换到 prod", switched.includes("激活环境: prod"), switched.split("\n")[2]);
  const prodDs = textOf(await call("datasources"));
  check("prod 真实连通（列出数据源）", !prodDs.startsWith("Error:") && prodDs.includes("grafana-ops") === false && /（共 \d+ 个数据源）/.test(prodDs), prodDs.slice(0, 300));

  rmSync(projectDir, { recursive: true, force: true });
  console.log(failures === 0 ? "\n── 集成测试全部通过 ──" : `\n── ${failures} 项失败 ──`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("INTEGRATION FAILED:", err instanceof Error ? err.message : err);
  rmSync(projectDir, { recursive: true, force: true });
  child.kill();
  process.exit(1);
});

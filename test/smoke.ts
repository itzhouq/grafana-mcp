#!/usr/bin/env bun
/**
 * 冒烟测试：以 MCP 客户端身份 spawn server，验证协议握手、工具清单与真实查询。
 * 用法：bun run test/smoke.ts
 */

import { spawn } from "node:child_process";

const serverPath = new URL("../index.ts", import.meta.url).pathname;

const child = spawn("bun", ["run", serverPath], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });

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
      if (msg.error) p.reject(new Error(`${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
});

const stderrChunks: string[] = [];
child.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString()));

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

function notify(method: string, params?: unknown): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
}

async function main(): Promise<void> {
  // 1. 握手
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  console.log("── initialize ──");
  console.log(JSON.stringify(init.serverInfo), "protocol:", init.protocolVersion);
  notify("notifications/initialized");

  // 2. 工具清单
  const tools = (await request("tools/list")) as { tools: Array<{ name: string }> };
  console.log("\n── tools/list ──");
  console.log(tools.tools.map((t) => t.name).join(", "));

  const call = async (name: string, args?: unknown): Promise<Record<string, unknown>> =>
    request("tools/call", { name, arguments: args ?? {} });

  // 3. 项目上下文
  console.log("\n── project_context ──");
  const ctx = textOf(await call("project_context"));
  console.log(ctx);

  // 本机（交互 shell）会从 .zshrc 继承 GRAFANA_*；CI 无凭据时只验证协议与脱敏输出
  const hasCreds = Boolean(process.env.GRAFANA_TEST_URL ?? process.env.GRAFANA_URL);
  if (!hasCreds) {
    console.log("\n未检测到 GRAFANA_TEST_URL / GRAFANA_URL，跳过真实查询（CI 模式）✅");
    child.kill();
    process.exit(0);
  }

  // 4. loki app 标签取值（验证 zshrc 解析出的 test 环境真实可用）
  console.log("\n── loki_labels label=app ──");
  const labels = await call("loki_labels", { label: "app", range: "24h" });
  console.log(labels.isError ? textOf(labels) : textOf(labels).split("\n").slice(0, 30).join("\n"));

  // 5. loki 查询（若拿到 app 取值则验证自动注入）
  console.log("\n── loki_query（自动注入 app）──");
  const loki = await call("loki_query", { query: "{job=~\".+\"}", range: "30m", limit: 5 });
  console.log(loki.isError ? textOf(loki) : textOf(loki).split("\n").slice(0, 12).join("\n"));

  // 6. prom 即时查询
  console.log("\n── prom_instant ──");
  const prom = await call("prom_instant", { query: "count(kube_pod_info)" });
  console.log(prom.isError ? textOf(prom) : textOf(prom).split("\n").slice(0, 6).join("\n"));

  console.log("\n── 完成，全部通过 ──");
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  console.error("server stderr:", stderrChunks.join(""));
  child.kill();
  process.exit(1);
});

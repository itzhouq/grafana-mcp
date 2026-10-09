#!/usr/bin/env bun
/**
 * grafana-mcp — 项目级 Grafana MCP server（stdio，零依赖，bun 直接运行）
 *
 * 解决两个痛点：
 *   1. 项目上下文（Grafana 中的 app 名称、namespace、默认环境）可在项目根 `.grafana.json`
 *      或 `.mcp.json` 的 env 中配置（GRAFANA_APP / GRAFANA_NAMESPACE / GRAFANA_ENV 等），
 *      agent 通过 project_context 工具即可对齐方向，无需每次口头指定。
 *   2. test/prod 双环境连接信息支持三种来源，按优先级合并：
 *      a) 进程环境变量（.mcp.json env）：GRAFANA_{ENV}_{URL|USER|PASSWORD|...}
 *         —— 零全局依赖，每个项目独立配置，不依赖 ~/.zshrc。
 *      b) ~/.zshrc / ~/.zshenv 文本解析：同上格式，适合全机统一配置。
 *      c) 全局配置文件 ~/.config/grafana-mcp/config.json。
 *
 * 协议：MCP stdio（newline-delimited JSON-RPC 2.0）。
 * 查询能力：Loki / Prometheus / Tempo / Alerts。
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const SERVER_NAME = "grafana-mcp";
// 版本号与 package.json 单一来源；以 index.ts 所在目录解析，兼容任意 cwd
const SERVER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();
const MAX_OUTPUT_CHARS = 60_000;
const HTTP_TIMEOUT_MS = 30_000;

// ── 配置模型 ─────────────────────────────────────────────────────────────────

interface DatasourceUids {
  loki?: string;
  prometheus?: string;
  tempo?: string;
}

/** 单个环境的连接信息（来自 zshrc / 全局配置 / 项目配置 / 环境变量 的合并结果） */
interface EnvConfig {
  url?: string;
  user?: string;
  password?: string;
  /** 该环境的 Loki app 标签值；同一项目在 test/prod 命名可能不同，故按环境配置 */
  app?: string;
  /** 该环境 app 标签名，默认 app */
  appLabel?: string;
  datasources?: DatasourceUids;
}

/** 项目上下文：agent 每次（会话）都需要的"这个项目在 Grafana 里长什么样" */
interface ProjectConfig {
  defaultEnv?: string;
  app?: string;
  appLabel?: string;
  namespace?: string;
  notes?: string;
  environments?: Record<string, EnvConfig>;
}

interface Credentials {
  username: string;
  password: string;
}

interface Datasource {
  id: number;
  uid: string;
  name: string;
  type: string;
}

class GrafanaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Grafana HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

// ── zshrc / zshenv 文本解析（核心：不依赖 shell 环境） ───────────────────────

/**
 * 解析 rc 文件中的：
 *   export GRAFANA_{ENV}_{URL|USER|PASSWORD|LOKI_DATASOURCE|PROMETHEUS_DATASOURCE|TEMPO_DATASOURCE}=...
 *   export GRAFANA_DEFAULT_ENV=test
 * ENV 段（TEST/PROD/STAGING…）小写化后作为环境名。
 */
function parseRcFile(filePath: string, into: Record<string, EnvConfig>): string | undefined {
  if (!existsSync(filePath)) return undefined;
  let defaultEnv: string | undefined;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const raw of lines) {
    const dm = raw.match(/^\s*(?:export\s+)?GRAFANA_DEFAULT_ENV\s*=\s*(.+?)\s*$/);
    if (dm) {
      defaultEnv = unquote(dm[1]);
      continue;
    }
    const m = raw.match(
      /^\s*(?:export\s+)?GRAFANA_([A-Za-z0-9]+)_(URL|USER|PASSWORD|APP|APP_LABEL|LOKI_DATASOURCE|PROMETHEUS_DATASOURCE|TEMPO_DATASOURCE)\s*=\s*(.+?)\s*$/,
    );
    if (!m) continue;
    const [, envSegment, key, rawVal] = m;
    const envName = envSegment.toLowerCase();
    const env = (into[envName] ??= {});
    const val = unquote(rawVal);
    if (key === "URL") env.url = val;
    else if (key === "USER") env.user = val;
    else if (key === "PASSWORD") env.password = val;
    else if (key === "APP") env.app = val;
    else if (key === "APP_LABEL") env.appLabel = val;
    else {
      env.datasources ??= {};
      if (key === "LOKI_DATASOURCE") env.datasources.loki = val;
      else if (key === "PROMETHEUS_DATASOURCE") env.datasources.prometheus = val;
      else if (key === "TEMPO_DATASOURCE") env.datasources.tempo = val;
    }
  }
  return defaultEnv;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) {
    return t.slice(1, -1);
  }
  return t;
}

// ── 配置加载与合并 ───────────────────────────────────────────────────────────
// 优先级（逐字段覆盖，从低到高）：
//   ~/.zshenv + ~/.zshrc 解析  →  全局 config.json  →  项目 .grafana.json  →  进程环境变量

const rcEnvs: Record<string, EnvConfig> = {};
const rcDefaultEnv =
  parseRcFile(join(homedir(), ".zshenv"), rcEnvs) ?? parseRcFile(join(homedir(), ".zshrc"), rcEnvs) ?? undefined;

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log(`警告：配置文件 ${path} 解析失败，已忽略（${err instanceof Error ? err.message : String(err)}）`);
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pickEnvConfig(v: unknown): EnvConfig {
  const r = asRecord(v);
  const ds = asRecord(r.datasources);
  const env: EnvConfig = {};
  if (typeof r.url === "string") env.url = r.url;
  if (typeof r.user === "string") env.user = r.user;
  if (typeof r.password === "string") env.password = r.password;
  if (typeof r.app === "string") env.app = r.app;
  if (typeof r.appLabel === "string") env.appLabel = r.appLabel;
  const dsv: DatasourceUids = {};
  if (typeof ds.loki === "string") dsv.loki = ds.loki;
  if (typeof ds.prometheus === "string") dsv.prometheus = ds.prometheus;
  if (typeof ds.tempo === "string") dsv.tempo = ds.tempo;
  if (Object.keys(dsv).length) env.datasources = dsv;
  return env;
}

/** 从 cwd 向上查找项目 .grafana.json（最多 6 层） */
function findProjectConfig(): string | undefined {
  const explicit = process.env.GRAFANA_PROJECT_CONFIG;
  if (explicit) return resolve(explicit);
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".grafana.json");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const globalConfigPath = process.env.GRAFANA_CONFIG
  ? resolve(process.env.GRAFANA_CONFIG)
  : join(homedir(), ".config", SERVER_NAME, "config.json");

const globalConfig = asRecord(existsSync(globalConfigPath) ? readJsonFile(globalConfigPath) : undefined);
const globalEnvs: Record<string, EnvConfig> = Object.fromEntries(
  Object.entries(asRecord(globalConfig.environments)).map(([k, v]) => [k, pickEnvConfig(v)]),
);

const projectConfigPath = findProjectConfig();
const projectConfig: ProjectConfig = (() => {
  let cfg: ProjectConfig = {};
  if (projectConfigPath) {
    const r = asRecord(readJsonFile(projectConfigPath));
    cfg = {
      defaultEnv: typeof r.defaultEnv === "string" ? r.defaultEnv : undefined,
      app: typeof r.app === "string" ? r.app : undefined,
      appLabel: typeof r.appLabel === "string" ? r.appLabel : undefined,
      namespace: typeof r.namespace === "string" ? r.namespace : undefined,
      notes: typeof r.notes === "string" ? r.notes : undefined,
      environments: Object.fromEntries(
        Object.entries(asRecord(r.environments)).map(([k, v]) => [k, pickEnvConfig(v)]),
      ),
    };
  }
  // 进程环境变量（.mcp.json env）覆盖 .grafana.json 的项目上下文字段
  if (process.env.GRAFANA_APP) cfg.app = process.env.GRAFANA_APP;
  if (process.env.GRAFANA_APP_LABEL) cfg.appLabel = process.env.GRAFANA_APP_LABEL;
  if (process.env.GRAFANA_NAMESPACE) cfg.namespace = process.env.GRAFANA_NAMESPACE;
  if (process.env.GRAFANA_NOTES) cfg.notes = process.env.GRAFANA_NOTES;
  return cfg;
})();

/** 扫描进程环境变量中的 GRAFANA_{ENV}_URL 模式，发现仅在 .mcp.json env 中配置的环境 */
function envScopedEnvs(): string[] {
  const found: string[] = [];
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^GRAFANA_([A-Za-z0-9]+)_URL$/);
    if (m) found.push(m[1].toLowerCase());
  }
  return found;
}

function availableEnvs(): string[] {
  const names = new Set([
    ...Object.keys(rcEnvs),
    ...Object.keys(globalEnvs),
    ...Object.keys(projectConfig.environments ?? {}),
    ...envScopedEnvs(),
  ]);
  return [...names].sort();
}

function resolveDefaultEnv(): { env: string; source: string } {
  const fromProcess = process.env.GRAFANA_ENV;
  if (fromProcess) return { env: fromProcess, source: "环境变量 GRAFANA_ENV（.mcp.json）" };
  if (projectConfig.defaultEnv) return { env: projectConfig.defaultEnv, source: `项目配置 ${projectConfigPath ?? ""}` };
  const globalDefault = typeof globalConfig.defaultEnv === "string" ? globalConfig.defaultEnv : undefined;
  if (globalDefault) return { env: globalDefault, source: "全局配置 config.json" };
  if (rcDefaultEnv) return { env: rcDefaultEnv, source: "~/.zshrc 的 GRAFANA_DEFAULT_ENV" };
  const all = availableEnvs();
  if (all.includes("test")) return { env: "test", source: "默认安全值（未显式配置时优先 test）" };
  if (all.length) return { env: all[0], source: "第一个可用环境" };
  return { env: "local", source: "无任何已配置环境，回退 local" };
}

/** 合并某环境的连接信息（rc < 全局 < 项目 < 进程 env；进程 env 支持直连与按环境两种写法） */
function mergedEnvConfig(envName: string): EnvConfig {
  const upper = envName.toUpperCase();
  const merged: EnvConfig = {
    ...rcEnvs[envName],
    ...globalEnvs[envName],
    ...projectConfig.environments?.[envName],
  };
  merged.datasources = { ...rcEnvs[envName]?.datasources, ...globalEnvs[envName]?.datasources, ...projectConfig.environments?.[envName]?.datasources };
  // 环境级 app 标签：同一项目在 test/prod 的 app 命名可能不同，按 环境配置 < 进程 env 合并
  merged.app = projectConfig.environments?.[envName]?.app ?? globalEnvs[envName]?.app ?? rcEnvs[envName]?.app;
  merged.appLabel = projectConfig.environments?.[envName]?.appLabel ?? globalEnvs[envName]?.appLabel ?? rcEnvs[envName]?.appLabel;

  // 按环境写法：GRAFANA_TEST_URL 等（.mcp.json env 可直接覆盖某个环境）
  const envScoped: EnvConfig = {
    url: process.env[`GRAFANA_${upper}_URL`],
    user: process.env[`GRAFANA_${upper}_USER`],
    password: process.env[`GRAFANA_${upper}_PASSWORD`],
    app: process.env[`GRAFANA_${upper}_APP`],
    appLabel: process.env[`GRAFANA_${upper}_APP_LABEL`],
    datasources: {
      loki: process.env[`GRAFANA_${upper}_LOKI_DATASOURCE`],
      prometheus: process.env[`GRAFANA_${upper}_PROMETHEUS_DATASOURCE`],
      tempo: process.env[`GRAFANA_${upper}_TEMPO_DATASOURCE`],
    },
  };
  // 直连写法：GRAFANA_URL 等（仅钉死在启动时的初始环境，切换环境后不再跟随，避免直连地址"污染"其他环境）
  const direct: EnvConfig = {
    url: process.env.GRAFANA_URL,
    user: process.env.GRAFANA_USER,
    password: process.env.GRAFANA_PASSWORD,
    datasources: {
      loki: process.env.GRAFANA_LOKI_DATASOURCE,
      prometheus: process.env.GRAFANA_PROMETHEUS_DATASOURCE,
      tempo: process.env.GRAFANA_TEMPO_DATASOURCE,
    },
  };
  const activeEnv = envName === initialEnv ? direct : {};
  return {
    url: envScoped.url ?? merged.url ?? activeEnv.url,
    user: envScoped.user ?? merged.user ?? activeEnv.user,
    password: envScoped.password ?? merged.password ?? activeEnv.password,
    app: envScoped.app ?? merged.app,
    appLabel: envScoped.appLabel ?? merged.appLabel,
    datasources: {
      loki: envScoped.datasources.loki ?? merged.datasources?.loki ?? activeEnv.datasources?.loki,
      prometheus: envScoped.datasources.prometheus ?? merged.datasources?.prometheus ?? activeEnv.datasources?.prometheus,
      tempo: envScoped.datasources.tempo ?? merged.datasources?.tempo ?? activeEnv.datasources?.tempo,
    },
  };
}

/** 当前环境生效的 app 标签：环境级配置优先，回退到项目级（app/appLabel） */
function currentApp(): { value?: string; label: string; source: string } {
  const env = mergedEnvConfig(currentEnv);
  if (env.app) {
    const src = process.env[`GRAFANA_${currentEnv.toUpperCase()}_APP`]
      ? `来自 .mcp.json env GRAFANA_${currentEnv.toUpperCase()}_APP`
      : projectConfig.environments?.[currentEnv]?.app
        ? `来自 .grafana.json environments.${currentEnv}.app`
        : `来自环境 ${currentEnv} 的 GRAFANA_${currentEnv.toUpperCase()}_APP`;
    return { value: env.app, label: env.appLabel ?? "app", source: src };
  }
  return {
    value: projectConfig.app,
    label: projectConfig.appLabel ?? "app",
    source: process.env.GRAFANA_APP ? "来自 .mcp.json env GRAFANA_APP（项目级）" : "来自 .grafana.json（项目级）",
  };
}

// ── 会话状态 ─────────────────────────────────────────────────────────────────

const initialEnv = resolveDefaultEnv().env;
let currentEnv = initialEnv;
let dsCache: { key: string; list: Datasource[] } | null = null;

function connKey(cfg: EnvConfig): string {
  return `${cfg.url}|${cfg.user}|${cfg.password}`;
}

function getConn(): EnvConfig {
  const cfg = mergedEnvConfig(currentEnv);
  if (!cfg.url) {
    throw new Error(
      `环境 "${currentEnv}" 未配置 GRAFANA_URL。` +
        `已解析到的环境：${availableEnvs().join(", ") || "（无）"}。` +
        `请检查 ~/.zshrc 中的 GRAFANA_${currentEnv.toUpperCase()}_URL，或在 .mcp.json 的 env / 项目 .grafana.json 中配置。`,
    );
  }
  return cfg;
}

// ── 1Password 回退（与原 skill 兼容） ────────────────────────────────────────

function getCredentials(conn: EnvConfig): Credentials {
  if (conn.user && conn.password) return { username: conn.user, password: conn.password };
  const vault = process.env.GRAFANA_OP_VAULT;
  const item = process.env.GRAFANA_OP_ITEM;
  if (vault && item) {
    try {
      const json = execSync(
        `op item get "${item}" --vault "${vault}" --fields user,password --format json --reveal`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      const fields = JSON.parse(json) as Array<{ label: string; value: string }>;
      const username = fields.find((f) => f.label === "user")?.value;
      const password = fields.find((f) => f.label === "password")?.value;
      if (username && password) return { username, password };
    } catch {
      log("1Password 凭据获取失败，继续以无认证方式请求");
    }
  }
  return { username: "", password: "" };
}

// ── HTTP（修正 base path 拼接：test 地址带 /proxy/grafana/xxx 路径时必须保留） ──

function buildUrl(path: string, params?: Record<string, string>): string {
  const conn = getConn();
  const base = conn.url.replace(/\/+$/, "");
  const full = path.startsWith("/") ? base + path : `${base}/${path}`;
  if (!params || Object.keys(params).length === 0) return full;
  const qs = new URLSearchParams(params).toString();
  return `${full}?${qs}`;
}

async function grafanaGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const conn = getConn();
  const creds = getCredentials(conn);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (creds.username && creds.password) {
    headers.Authorization = "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, params), { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason.includes("TimeoutError") || reason.toLowerCase().includes("timeout")) {
      throw new Error(`请求 ${conn.url}${path} 超时（${HTTP_TIMEOUT_MS / 1000}s）。请确认网络/VPN 可达，或 Grafana 是否过载。`);
    }
    throw new Error(`无法连接 Grafana（${conn.url}）：${reason}。请检查 URL、网络或 VPN。`);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new GrafanaHttpError(res.status, `认证/授权失败（当前环境 ${currentEnv}，user=${creds.username || "（空）"}）。请检查账号密码配置。原始响应: ${body.slice(0, 200)}`);
    }
    throw new GrafanaHttpError(res.status, body);
  }
  return res.json();
}

// ── 时间与工具函数 ───────────────────────────────────────────────────────────

const DURATION_MULTIPLIERS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuration(dur: string): number {
  const m = dur.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`无效的时间跨度 "${dur}"，支持格式：30m、1h、6h、24h、7d`);
  return parseInt(m[1]) * DURATION_MULTIPLIERS[m[2]];
}

function resolveTimeRange(args: Record<string, unknown>): { startMs: number; endMs: number } {
  const range = optStr(args, "range") ?? "1h";
  const endMs = optStr(args, "end") ? new Date(optStr(args, "end") as string).getTime() : Date.now();
  const startMs = optStr(args, "start")
    ? new Date(optStr(args, "start") as string).getTime()
    : endMs - parseDuration(range);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error("--start/--end 需要合法的 ISO 8601 时间，如 2026-09-26T02:00:00Z");
  return { startMs, endMs };
}

function toNanos(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

function toUnixSec(ms: number): string {
  return Math.floor(ms / 1000).toString();
}

function autoStep(startMs: number, endMs: number): string {
  const rangeSeconds = (endMs - startMs) / 1000;
  return Math.max(15, Math.floor(rangeSeconds / 120)).toString();
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n\n...[输出过长已截断：共 ${s.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS}。请缩小时间范围或用更精确的过滤条件]`;
}

function fmtLabels(labels: Record<string, string>): string {
  return Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(", ");
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = optStr(args, key);
  if (!v) throw new Error(`缺少必填参数 "${key}"`);
  return v;
}

function numStr(args: Record<string, unknown>, key: string, dflt: string): string {
  const v = args[key];
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`参数 "${key}" 需要正整数`);
  return String(Math.floor(n));
}

// ── 数据源解析（优先用配置的 UID，避免多数据源实例上"按 type 取第一个"选错） ──

async function listDatasources(): Promise<Datasource[]> {
  const conn = getConn();
  const key = connKey(conn);
  if (dsCache?.key === key) return dsCache.list;
  const list = (await grafanaGet("/api/datasources")) as Datasource[];
  dsCache = { key, list };
  return list;
}

async function resolveDatasource(type: keyof DatasourceUids): Promise<Datasource> {
  const conn = getConn();
  const all = await listDatasources();
  const configuredUid = conn.datasources?.[type];
  if (configuredUid) {
    const byUid = all.find((d) => d.uid === configuredUid);
    if (!byUid) {
      throw new Error(
        `环境 "${currentEnv}" 配置的 ${type} 数据源 UID "${configuredUid}" 不存在。可用数据源：${all.map((d) => `${d.name}(${d.type}/${d.uid})`).join(", ")}`,
      );
    }
    return byUid;
  }
  const byType = all.find((d) => d.type === type);
  if (!byType) {
    throw new Error(`当前 Grafana 没有 ${type} 类型数据源。可用：${all.map((d) => `${d.name}(${d.type})`).join(", ")}`);
  }
  return byType;
}

// ── Loki app 标签自动注入（减少方向跑偏） ───────────────────────────────────

function injectAppLabel(query: string, label: string, value: string, source = "项目配置"): { query: string; injected: boolean; reason: string } {
  const open = query.indexOf("{");
  if (open === -1) return { query, injected: false, reason: "查询中没有 selector（{...}），未注入" };
  const close = query.indexOf("}", open);
  if (close === -1) return { query, injected: false, reason: "selector 未闭合，未注入" };
  const selector = query.slice(open + 1, close);
  if (new RegExp(`\\b${label}\\s*[=!~]`).test(selector)) {
    return { query, injected: false, reason: `selector 已包含 ${label} 标签，未注入` };
  }
  const inner = selector.trim();
  const patched = inner ? `${label}="${value}", ${inner}` : `${label}="${value}"`;
  return {
    query: query.slice(0, open + 1) + patched + query.slice(close),
    injected: true,
    reason: `已在 selector 注入 ${label}="${value}"（${source}）`,
  };
}

// ── 工具实现（返回面向 agent 的文本） ────────────────────────────────────────

function maskPassword(p: string | undefined): string {
  return p ? "（已配置，隐藏）" : "（未配置）";
}

async function toolProjectContext(): Promise<string> {
  const lines: string[] = [];
  const defaultInfo = resolveDefaultEnv();
  lines.push("=== Grafana MCP 项目上下文 ===");
  lines.push("");
  lines.push(`激活环境: ${currentEnv}`);
  lines.push(`初始环境来源: ${defaultInfo.source}`);
  lines.push(`可用环境: ${availableEnvs().join(", ") || "（无，请检查 ~/.zshrc 或配置文件）"}`);
  lines.push("");
  lines.push(`配置来源层级: 进程环境变量(.mcp.json env) > 项目 ${projectConfigPath ?? "（未找到 .grafana.json）"} > 全局 ${globalConfigPath}${existsSync(globalConfigPath) ? "" : "（不存在）"} > ~/.zshrc 文本解析${Object.keys(rcEnvs).length ? "（已解析到 " + Object.keys(rcEnvs).join(", ") + "）" : "（未解析到 GRAFANA_* 变量）"}`);
  const envScopedList = envScopedEnvs();
  if (envScopedList.length) {
    lines.push(`.mcp.json env 已配置的环境: ${envScopedList.join(", ")}（地址/凭据通过 GRAFANA_{ENV}_* 传入）`);
  }
  lines.push("");
  const effApp = currentApp();
  if (effApp.value || projectConfig.namespace || projectConfig.notes) {
    lines.push("── 项目信息 ──");
    if (effApp.value) {
      lines.push(`当前环境 App: ${effApp.value}（Loki 标签 ${effApp.label}，${effApp.source}），loki_query 默认自动注入`);
      if (projectConfig.app && projectConfig.app !== effApp.value) {
        lines.push(`项目级默认 App: ${projectConfig.app}（被环境级配置覆盖）`);
      }
    }
    if (projectConfig.namespace) {
      const nsSource = process.env.GRAFANA_NAMESPACE ? "（来自 .mcp.json env）" : projectConfigPath ? "（来自 .grafana.json）" : "";
      lines.push(`Namespace: ${projectConfig.namespace}${nsSource}`);
    }
    if (projectConfig.notes) lines.push(`备注: ${projectConfig.notes}`);
    lines.push("");
  }
  lines.push("── 各环境连接信息（密码脱敏） ──");
  for (const name of availableEnvs()) {
    const cfg = mergedEnvConfig(name);
    const ds = cfg.datasources;
    const dsText = [ds?.loki && `loki=${ds.loki}`, ds?.prometheus && `prometheus=${ds.prometheus}`, ds?.tempo && `tempo=${ds.tempo}`]
      .filter(Boolean)
      .join(", ");
    lines.push(`  [${name}${name === currentEnv ? " ← 当前" : ""}] ${cfg.url ?? "（未配置 URL）"}  user=${cfg.user ?? "（空）"} password=${maskPassword(cfg.password)}${dsText ? `  数据源: ${dsText}` : ""}`);
  }
  if (effApp.value) {
    lines.push("");
    lines.push(`提示：loki_query 会自动为缺省 selector 注入 ${effApp.label}="${effApp.value}"（随环境切换）；传 injectApp=false 可关闭。`);
  }
  return truncate(lines.join("\n"));
}

async function toolSwitchEnvironment(args: Record<string, unknown>): Promise<string> {
  const target = reqStr(args, "env");
  if (!availableEnvs().includes(target)) {
    throw new Error(`未知环境 "${target}"。可用环境：${availableEnvs().join(", ")}`);
  }
  currentEnv = target;
  dsCache = null;
  return `已切换到环境 "${target}"。\n\n${await toolProjectContext()}`;
}

async function toolDatasources(): Promise<string> {
  const all = await listDatasources();
  const lines = [`=== Grafana 数据源（环境 ${currentEnv}）===`, ""];
  for (const ds of all) {
    lines.push(`  [${ds.type}] ${ds.name}  (id=${ds.id}, uid=${ds.uid})`);
  }
  lines.push("", `（共 ${all.length} 个数据源）`);
  return truncate(lines.join("\n"));
}

interface AlertItem {
  status: { state: string };
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
}

async function toolAlerts(): Promise<string> {
  const alerts = (await grafanaGet("/api/alertmanager/grafana/api/v2/alerts")) as AlertItem[];
  const lines = [`=== 当前告警（环境 ${currentEnv}）===`, ""];
  if (!alerts.length) {
    lines.push("  当前无告警。");
    return lines.join("\n");
  }
  for (const a of alerts) {
    lines.push(`  [${a.status.state.toUpperCase()}] ${a.labels.alertname ?? "unnamed"}`);
    lines.push(`    Labels: ${fmtLabels(a.labels)}`);
    if (a.annotations.summary) lines.push(`    Summary: ${a.annotations.summary}`);
    if (a.annotations.description) lines.push(`    Description: ${a.annotations.description}`);
    lines.push(`    Since: ${a.startsAt}`, "");
  }
  lines.push(`（共 ${alerts.length} 条告警）`);
  return truncate(lines.join("\n"));
}

async function appInjectionParams(args: Record<string, unknown>): Promise<{ label: string; value: string | undefined; inject: boolean }> {
  const inject = args.injectApp !== false;
  const eff = currentApp();
  const label = optStr(args, "appLabel") ?? eff.label;
  const explicitApp = optStr(args, "app");
  const value = explicitApp ?? eff.value;
  return { label, value, inject: inject && !!value };
}

async function toolLokiQuery(args: Record<string, unknown>): Promise<string> {
  let query = reqStr(args, "query");
  const ds = await resolveDatasource("loki");
  const { startMs, endMs } = resolveTimeRange(args);
  const limit = numStr(args, "limit", "200");

  const injection: string[] = [];
  const { label, value, inject } = await appInjectionParams(args);
  if (inject && value) {
    const r = injectAppLabel(query, label, value, currentApp().source);
    query = r.query;
    injection.push(r.reason);
  }

  const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/loki/api/v1/query_range`, {
    query,
    start: toNanos(startMs),
    end: toNanos(endMs),
    limit,
    direction: "backward",
  })) as { data?: { result?: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> } };

  const lines: string[] = [`=== Loki 日志（环境 ${currentEnv}，数据源 ${ds.name}）===`, `查询: ${query}`];
  if (injection.length) lines.push(`注入: ${injection.join("；")}`);
  lines.push(`范围: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`, "");

  const streams = result.data?.result ?? [];
  let total = 0;
  for (const stream of streams) {
    lines.push(`--- {${fmtLabels(stream.stream)}} ---`);
    for (const [ts, line] of stream.values) {
      lines.push(`[${new Date(Number(BigInt(ts) / 1_000_000n)).toISOString()}] ${line}`);
      total++;
    }
    lines.push("");
  }
  lines.push(`（${total} 行日志，来自 ${streams.length} 个流${total === Number(limit) ? "，已达 limit 上限，可能还有更多" : ""}）`);
  return truncate(lines.join("\n"));
}

async function toolLokiLabels(args: Record<string, unknown>): Promise<string> {
  const ds = await resolveDatasource("loki");
  const { startMs, endMs } = resolveTimeRange(args);
  const label = optStr(args, "label");
  const start = toUnixSec(startMs);
  const end = toUnixSec(endMs);

  if (!label) {
    const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/loki/api/v1/labels`, { start, end })) as { data?: string[] } | string[];
    const names = Array.isArray(result) ? result : (result.data ?? []);
    const lines = [
      `=== Loki 标签名（环境 ${currentEnv}）===`,
      `范围: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
      "",
      ...names.map((n) => `  ${n}`),
      "",
      `（共 ${names.length} 个标签。用 loki_labels 的 label 参数可查某个标签的取值，例如 label=app 确认项目 app 名称。）`,
    ];
    return truncate(lines.join("\n"));
  }

  const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/loki/api/v1/label/${encodeURIComponent(label)}/values`, { start, end })) as { data?: string[] } | string[];
  const values = Array.isArray(result) ? result : (result.data ?? []);
  const eff = currentApp();
  const hint =
    eff.value && label === eff.label
      ? values.includes(eff.value)
        ? `\n提示：当前环境 App "${eff.value}"（${eff.source}）在取值列表中。✓`
        : `\n警告：当前环境 App "${eff.value}" 不在取值列表中！请用 loki_labels label=app 核对真实 app 名称，勿基于错误假设继续查询。`
      : "";
  const lines = [
    `=== Loki 标签 ${label} 的取值（环境 ${currentEnv}）===`,
    `范围: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
    "",
    ...values.map((v) => `  ${v}`),
    "",
    `（共 ${values.length} 个取值）${hint}`,
  ];
  return truncate(lines.join("\n"));
}

interface PromResult {
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values?: Array<[number, string]>; value?: [number, string] }>;
  };
}

async function toolPromQuery(args: Record<string, unknown>): Promise<string> {
  const query = reqStr(args, "query");
  const ds = await resolveDatasource("prometheus");
  const { startMs, endMs } = resolveTimeRange(args);
  const step = optStr(args, "step") ?? autoStep(startMs, endMs);

  const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/api/v1/query_range`, {
    query,
    start: toUnixSec(startMs),
    end: toUnixSec(endMs),
    step,
  })) as PromResult;

  const lines = [
    `=== Prometheus 区间查询（环境 ${currentEnv}，数据源 ${ds.name}）===`,
    `查询: ${query}`,
    `范围: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}，step=${step}s`,
    "",
  ];
  const series = result.data?.result ?? [];
  for (const s of series) {
    lines.push(`--- {${fmtLabels(s.metric)}} ---`);
    for (const [ts, val] of s.values ?? []) lines.push(`  ${new Date(ts * 1000).toISOString()}  ${val}`);
    lines.push("");
  }
  lines.push(`（${series.length} 条序列）`);
  return truncate(lines.join("\n"));
}

async function toolPromInstant(args: Record<string, unknown>): Promise<string> {
  const query = reqStr(args, "query");
  const ds = await resolveDatasource("prometheus");
  const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/api/v1/query`, {
    query,
    time: toUnixSec(Date.now()),
  })) as PromResult;

  const lines = [`=== Prometheus 即时查询（环境 ${currentEnv}）===`, `查询: ${query}`, ""];
  const results = result.data?.result ?? [];
  for (const r of results) {
    lines.push(`  {${fmtLabels(r.metric)}}  →  ${r.value?.[1] ?? "（无值）"}`);
  }
  if (!results.length) {
    lines.push(`  （0 条结果：指标可能不存在、标签不匹配或当前环境无此数据。可用 prom_instant 'count by (__name__) ({__name__=~"kube_.*"})' 探索可用指标，或先用 project_context 确认环境。）`);
  } else {
    lines.push("", `（${results.length} 条结果）`);
  }
  return truncate(lines.join("\n"));
}

interface TempoSearchResult {
  traces?: Array<{
    traceID: string;
    rootServiceName: string;
    rootTraceName: string;
    startTimeUnixNano: string;
    durationMs: number;
  }>;
}

async function toolTempoSearch(args: Record<string, unknown>): Promise<string> {
  const query = reqStr(args, "query");
  const ds = await resolveDatasource("tempo");
  const { startMs, endMs } = resolveTimeRange(args);
  const limit = numStr(args, "limit", "20");

  const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/api/search`, {
    q: query,
    start: toUnixSec(startMs),
    end: toUnixSec(endMs),
    limit,
  })) as TempoSearchResult;

  const lines = [
    `=== Tempo 追踪搜索（环境 ${currentEnv}，数据源 ${ds.name}）===`,
    `查询: ${query}`,
    `范围: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`,
    "",
  ];
  const traces = result.traces ?? [];
  for (const t of traces) {
    const startTime = new Date(Number(BigInt(t.startTimeUnixNano) / 1_000_000n)).toISOString();
    lines.push(`  ${t.traceID}  ${t.rootServiceName}/${t.rootTraceName}  ${t.durationMs}ms  ${startTime}`);
  }
  lines.push("", `（${traces.length} 条 trace。用 tempo_trace 可按 traceID 查看详情。）`);
  return truncate(lines.join("\n"));
}

interface TempoTraceResult {
  batches?: Array<{
    resource?: { attributes?: Array<{ key: string; value: { stringValue?: string } }> };
    scopeSpans?: Array<{
      spans?: Array<{
        traceId: string;
        spanId: string;
        operationName?: string;
        name?: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status?: { code?: number; message?: string };
      }>;
    }>;
  }>;
}

async function toolTempoTrace(args: Record<string, unknown>): Promise<string> {
  const traceId = reqStr(args, "traceId");
  const ds = await resolveDatasource("tempo");
  const result = (await grafanaGet(`/api/datasources/proxy/${ds.id}/api/traces/${encodeURIComponent(traceId)}`)) as TempoTraceResult;

  const lines = [`=== Tempo Trace（环境 ${currentEnv}）===`, `TraceID: ${traceId}`, ""];
  const batches = result.batches ?? [];
  let spanCount = 0;
  for (const batch of batches) {
    const serviceName =
      batch.resource?.attributes?.find((a) => a.key === "service.name")?.value?.stringValue ?? "unknown";
    lines.push(`Service: ${serviceName}`);
    for (const scope of batch.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const name = span.name ?? span.operationName ?? "unnamed";
        const startNs = BigInt(span.startTimeUnixNano);
        const endNs = BigInt(span.endTimeUnixNano);
        const durationMs = Number((endNs - startNs) / 1_000_000n);
        const startTime = new Date(Number(startNs / 1_000_000n)).toISOString();
        const statusCode = span.status?.code ?? 0;
        const statusStr = statusCode === 2 ? " [ERROR]" : statusCode === 1 ? " [OK]" : "";
        lines.push(`  [${startTime}] ${name} (${durationMs}ms)${statusStr} spanId=${span.spanId}`);
        spanCount++;
      }
    }
    lines.push("");
  }
  lines.push(`（${spanCount} 个 span，跨 ${batches.length} 个服务）`);
  return truncate(lines.join("\n"));
}

// ── 工具注册表 ───────────────────────────────────────────────────────────────

const PROJECT_CFG_HINT = projectConfigPath
  ? `本项目的上下文来自 ${projectConfigPath}。`
  : "当前目录未找到 .grafana.json 项目配置（可在项目根创建，参见 grafana-mcp README）。";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const timeProps = {
  range: { type: "string", description: "回看时长，从现在往回算，默认 1h。示例：30m、6h、24h、7d" },
  start: { type: "string", description: "绝对开始时间（ISO 8601，如 2026-09-26T02:00:00Z），设置后覆盖 range" },
  end: { type: "string", description: "绝对结束时间（ISO 8601），默认现在" },
};

const TOOLS: ToolDef[] = [
  {
    name: "project_context",
    description:
      `【调查前必调】获取当前项目的 Grafana 上下文：激活环境（test/prod）、项目 App 名称、namespace、数据源 UID、配置来源。` +
      `每次会话开始调查 Grafana 相关问题前先调用本工具对齐方向，避免查错环境或查错应用。${PROJECT_CFG_HINT}`,
    inputSchema: { type: "object", properties: {} },
    handler: () => toolProjectContext(),
  },
  {
    name: "switch_environment",
    description: `切换 Grafana 环境（仅影响本会话）。环境信息（连接地址、账密、数据源 UID）来自 ~/.zshrc 解析或配置文件，无需手动 export。切换后返回新环境上下文。`,
    inputSchema: {
      type: "object",
      properties: { env: { type: "string", description: "目标环境名，如 test、prod" } },
      required: ["env"],
    },
    handler: (args) => toolSwitchEnvironment(args),
  },
  {
    name: "datasources",
    description: "列出当前 Grafana 实例的全部数据源（类型、名称、UID）。",
    inputSchema: { type: "object", properties: {} },
    handler: () => toolDatasources(),
  },
  {
    name: "alerts",
    description: "列出当前正在告警的规则（Grafana Alertmanager）。收到 [FIRING:N] 类告警消息后先用它确认现状。",
    inputSchema: { type: "object", properties: {} },
    handler: () => toolAlerts(),
  },
  {
    name: "loki_query",
    description:
      `执行 LogQL 日志查询（range 查询）。` +
      (currentApp().value
        ? `当前环境默认 app 标签 ${currentApp().label}="${currentApp().value}" 会自动注入到首个 selector（传 injectApp=false 关闭）；切换环境后自动改用该环境的 app。`
        : `若项目或环境配置了 app，会自动注入到首个 selector（传 injectApp=false 关闭）。`) +
      ` 示例 query：{namespace="prod", container="api"} |~ "(?i)(error|panic)"`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "LogQL 查询语句" },
        ...timeProps,
        limit: { type: "integer", description: "最大返回行数，默认 200" },
        app: { type: "string", description: "覆盖自动注入的 app 值（默认取项目配置）" },
        appLabel: { type: "string", description: "覆盖注入使用的标签名（默认项目配置或 app）" },
        injectApp: { type: "boolean", description: "是否自动注入 app 标签，默认 true（有项目配置时）" },
      },
      required: ["query"],
    },
    handler: (args) => toolLokiQuery(args),
  },
  {
    name: "loki_labels",
    description:
      "查询 Loki 标签名或某标签的全部取值。不带 label 参数 → 列出所有标签名；带 label=app → 返回 app 标签的所有取值（用于确认项目 app 名称在当前环境是否存在，防止查错应用）。",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "要查询取值的标签名，如 app、namespace；不传则列出所有标签名" },
        ...timeProps,
      },
    },
    handler: (args) => toolLokiLabels(args),
  },
  {
    name: "prom_query",
    description: '执行 PromQL 区间查询。示例：rate(container_cpu_usage_seconds_total{namespace="prod"}[5m])',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "PromQL 查询语句" },
        ...timeProps,
        step: { type: "string", description: "采样步长（秒），默认按时间跨度自动选择" },
      },
      required: ["query"],
    },
    handler: (args) => toolPromQuery(args),
  },
  {
    name: "prom_instant",
    description: '执行 PromQL 即时查询（单时间点）。示例：kube_pod_container_status_restarts_total{namespace="prod"}',
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "PromQL 查询语句" } },
      required: ["query"],
    },
    handler: (args) => toolPromInstant(args),
  },
  {
    name: "tempo_search",
    description: '用 TraceQL 搜索链路追踪。示例：{resource.service.name="api" && status=error}',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "TraceQL 查询语句" },
        ...timeProps,
        limit: { type: "integer", description: "最大返回条数，默认 20" },
      },
      required: ["query"],
    },
    handler: (args) => toolTempoSearch(args),
  },
  {
    name: "tempo_trace",
    description: "按 traceID 获取完整链路（span 列表、耗时、状态）。日志中的 traceId=xxx 可直接跟进。",
    inputSchema: {
      type: "object",
      properties: { traceId: { type: "string", description: "Trace ID" } },
      required: ["traceId"],
    },
    handler: (args) => toolTempoTrace(args),
  },
];

// ── MCP stdio 协议层（JSON-RPC 2.0，newline-delimited） ─────────────────────

function log(msg: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

async function handleMessage(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    rpcError(null, -32700, "Parse error");
    return;
  }

  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? (params.protocolVersion as string) : "2024-11-05";
        ok(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case "notifications/initialized":
      case "initialized":
      case "notifications/cancelled":
      case "$/cancelRequest":
        return; // 通知，无需响应
      case "ping":
        if (isRequest) ok(id, {});
        return;
      case "tools/list":
        ok(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
        return;
      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        const args = asRecord(params?.arguments);
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) {
          rpcError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        try {
          const text = await tool.handler(args);
          ok(id, { content: [{ type: "text", text }] });
        } catch (err) {
          ok(id, {
            content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          });
        }
        return;
      }
      case "resources/list":
        if (isRequest) ok(id, { resources: [] });
        return;
      case "prompts/list":
        if (isRequest) ok(id, { prompts: [] });
        return;
      default:
        if (isRequest) rpcError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (err) {
    log(`处理 ${method} 时异常: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    if (isRequest) rpcError(id, -32603, "Internal error");
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  void handleMessage(line).catch((err) => log(`消息处理失败: ${err instanceof Error ? err.message : String(err)}`));
});
rl.on("close", () => process.exit(0));
process.on("uncaughtException", (err) => log(`uncaughtException: ${err.stack ?? err.message}`));
process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err instanceof Error ? err.stack : String(err)}`));

log(`started (env=${currentEnv}, project=${projectConfigPath ?? "none"}, available=[${availableEnvs().join(", ")}])`);

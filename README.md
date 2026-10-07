# grafana-mcp

[![CI](https://github.com/itzhouq/grafana-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/itzhouq/grafana-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/grafana-mcp)](https://www.npmjs.com/package/grafana-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/runtime-bun-f472b6)](https://bun.sh)

**Project-level Grafana MCP server** — give your AI coding agent read-only access to Loki logs, Prometheus metrics, Tempo traces and alerts, with per-project context and test/prod environment switching. 零依赖单文件 TypeScript，bun 直接运行。

```text
AI 编码 Agent（Claude Code / Cursor / …）
        │  MCP (stdio)
        ▼
   grafana-mcp ──读──▶ ~/.zshrc / ~/.zshenv / 项目 .grafana.json（凭据与项目上下文）
        │  HTTP（只读查询 API）
        ▼
   Grafana ──▶ Loki（日志）/ Prometheus（指标）/ Tempo（链路）/ Alerts（告警）
```

## 它解决什么问题

日常迭代业务系统时，测试阶段要快速定位 QA 反馈的问题，线上要快速排查功能 bug 与性能瓶颈——这些证据都在 Grafana 体系里（Loki 日志、Prometheus 指标、Tempo 链路）。让 agent 在写代码、修 bug 的同时能直接查到这些上下文，问题定位的效率和准确性会明显提升。但直接用通用 MCP 封装 Grafana API 会遇到三个实际障碍：

| 痛点 | 本实现的解法 |
|---|---|
| 每个项目会话都要口头告诉 agent "我们的应用在 Grafana 里叫什么"，容易跑偏 | 项目根放一个 `.grafana.json`（app、namespace、默认环境），agent 调 `project_context` 一次对齐方向 |
| test / prod 双环境凭据区分，而 MCP server 由客户端 spawn，是非交互 shell，**不会 source `.zshrc`**，环境变量读不到 | server 启动时直接**解析 `~/.zshrc` / `~/.zshenv` 文件文本**提取 `GRAFANA_{ENV}_*` 变量，完全不依赖 shell 环境 |
| 多数据源实例上"按类型取第一个"容易选错 | 优先使用显式配置的数据源 UID，支持按环境指定 |

## 声明

1. **非官方项目**：本仓库与 Grafana Labs 无隶属关系；Grafana、Loki、Prometheus、Tempo 是各自所有方的商标。
2. **免责**：软件按"现状"提供。使用者需自行确保对目标 Grafana 实例的访问已获授权，并遵守所在组织的数据安全与审计规定；日志与指标输出可能包含业务敏感信息，分享查询结果前请自行判断合规边界。作者不对违规使用及其后果负责。
3. **只读边界**：全部 10 个工具均为查询类，不含任何写操作。建议为 agent 配置 **Viewer 角色的专用账号**（最小权限），不要复用管理员凭据。

## 快速开始

前提：本机已安装 [bun](https://bun.sh)（`curl -fsSL https://bun.sh/install | bash`）。项目零 npm 依赖，无需 `npm install`。

### 1. 在项目的 `.mcp.json` 中接入

```json
{
  "mcpServers": {
    "grafana": {
      "command": "bunx",
      "args": ["grafana-mcp"],
      "env": {
        "GRAFANA_ENV": "test",
        "GRAFANA_APP": "my-app"
      }
    }
  }
}
```

- `GRAFANA_ENV`：该项目默认环境（省略则默认 `test`，安全兜底）
- `GRAFANA_APP`：该应用在 Grafana/Loki 中的 app 标签值（也可以放到 `.grafana.json`，见下）
- 重启会话后生效；Claude Code 也可用 `claude mcp add` 交互添加

偏好克隆使用的话：

```bash
git clone https://github.com/itzhouq/grafana-mcp.git && cd grafana-mcp
bun run index.ts          # stdio JSON-RPC，接入任意 MCP 客户端
```

`.mcp.json` 中对应写 `"command": "bun", "args": ["run", "/path/to/grafana-mcp/index.ts"]`。

### 2.（推荐）在项目根创建 `.grafana.json`

比 `.mcp.json` env 能承载更多信息，且对 agent 可见可解释：

```json
{
  "defaultEnv": "test",
  "app": "my-app",
  "appLabel": "app",
  "namespace": "my-namespace",
  "notes": "本项目日志标签 app=my-app；查指标时 pod 前缀为 my-app-"
}
```

| 字段 | 说明 |
|---|---|
| `defaultEnv` | 默认环境（`test` / `prod` / 自定义） |
| `app` | 应用在 Loki 中的 app 标签值，`loki_query` 会自动注入到查询 selector |
| `appLabel` | app 标签名，默认 `app` |
| `namespace` | 默认 namespace，供 agent 参考 |
| `notes` | 自由文本备注，`project_context` 会原样带给 agent |
| `environments.{env}.datasources` | 按环境指定数据源 UID（不配则按数据源类型自动发现） |

> ⚠️ `.grafana.json` 的 `notes` 是自由文本，可能包含内部信息——建议把它加进项目的 `.gitignore`。

## 环境配置从哪来

无需任何操作：server 启动时读取 `~/.zshenv` 和 `~/.zshrc` **文件内容**（而非 shell 环境），解析其中的：

```shell
export GRAFANA_TEST_URL=...        export GRAFANA_PROD_URL=...
export GRAFANA_TEST_USER=...       export GRAFANA_PROD_USER=...
export GRAFANA_TEST_PASSWORD=...   export GRAFANA_PROD_PASSWORD=...
export GRAFANA_TEST_LOKI_DATASOURCE=...      export GRAFANA_PROD_LOKI_DATASOURCE=...
export GRAFANA_TEST_PROMETHEUS_DATASOURCE=... export GRAFANA_PROD_PROMETHEUS_DATASOURCE=...
export GRAFANA_DEFAULT_ENV=test   # 可选：全局默认环境
```

修改 `.zshrc` 后重启会话即生效。环境切换用 `switch_environment` 工具，或 `.mcp.json` 里 `GRAFANA_ENV` 指定默认值。

字段级优先级（从低到高，逐字段合并）：

```
~/.zshenv + ~/.zshrc 文本解析
  → 全局配置 ~/.config/grafana-mcp/config.json（可选，适合无 .zshrc 的机器）
    → 项目 .grafana.json
      → 进程环境变量（.mcp.json env：GRAFANA_URL/USER/PASSWORD 直连，或 GRAFANA_{ENV}_URL 按环境覆盖）
```

## 工具列表

| 工具 | 说明 |
|---|---|
| `project_context` | **调查前必调**：激活环境、可用环境、项目 App/namespace、数据源 UID、配置来源（密码脱敏输出） |
| `switch_environment` | 切换 test/prod（仅影响当前会话），返回新环境上下文 |
| `loki_query` | LogQL 日志查询；项目配置了 app 时自动注入 selector（`injectApp=false` 可关） |
| `loki_labels` | 列 Loki 标签名，或查某标签全部取值（如确认 app 名称在当前环境是否存在） |
| `prom_query` | PromQL 区间查询 |
| `prom_instant` | PromQL 即时查询 |
| `tempo_search` | TraceQL 链路搜索 |
| `tempo_trace` | 按 traceID 查看完整链路 |
| `alerts` | 当前正在告警的规则 |
| `datasources` | 列出全部数据源 |

时间参数（loki/prom/tempo 通用）：`range`（默认 `1h`，如 `30m`/`6h`/`24h`）、`start`/`end`（ISO 8601 绝对时间）、`limit`。

## 与官方 mcp-grafana 的差异

[Grafana 官方](https://github.com/grafana/mcp-grafana)也提供 MCP server（Go 实现，面向全局单实例的完整工具集）。两者定位不同，可并存：

| | grafana-mcp（本仓库） | 官方 mcp-grafana |
|---|---|---|
| 使用粒度 | **项目级**：项目根 `.grafana.json` 声明上下文，`project_context` 一次对齐 | 全局实例，项目信息需每次口头提供 |
| 多环境 | **test/prod 双环境**一等公民，`switch_environment` 一键切换 | 面向单一实例配置 |
| 凭据来源 | 解析 `~/.zshrc`/`~/.zshenv` 文本（适配 MCP 客户端非交互 shell）+ 环境变量 + 配置文件 | 环境变量 |
| 形态 | 零依赖单文件 TypeScript，bun 直接运行 | Go 二进制 / Docker |

选型建议：要全量 Grafana 管理能力用官方；要"每个业务项目开箱即用的日志/指标排查上下文 + 双环境"，用本仓库。

## 安全提示

- Grafana 账号建议使用 **Viewer 角色**的专用账号，不要复用管理员凭据。
- 凭据明文存于 `~/.zshrc`（或进程环境），MCP server 仅在本机内存中使用，不落盘、不回显（`project_context` 输出对密码脱敏）。
- 如需集中管理，可把连接信息放到 `~/.config/grafana-mcp/config.json` 并 `chmod 600`，`~/.zshrc` 中的同名变量会被其覆盖。
- 支持 1Password 回退（可选）：设置 `GRAFANA_OP_VAULT` / `GRAFANA_OP_ITEM` 后，无账密时通过 `op` CLI 取凭据。

## FAQ

**为什么 agent 读不到 `.zshrc` 里的环境变量？**
MCP server 由客户端 spawn，是非交互、非登录 shell，不会 source rc 文件。本实现因此直接解析 rc 文件文本，这是特性而非 workaround。

**不想装 bun？**
当前运行时依赖 bun（单文件 TS 直跑是刻意的设计取舍）。Node 兼容的编译产物在 Roadmap 中，欢迎 issue 催更。

**查询结果太长被截断？**
超过 6 万字符自动截断并提示缩小范围；命中 limit 上限时也会明确提示可能还有更多。建议总是带 `range` 与 `limit`。

**数据源选错了？**
在 `GRAFANA_{ENV}_LOKI_DATASOURCE` 等变量或 `.grafana.json` 的 `environments.{env}.datasources` 中显式指定 UID。

## 本地开发

```bash
bun run smoke    # MCP 协议握手 + 工具清单 + project_context；本机配好凭据后自动追加真实查询
bun run test     # 冒烟 + 集成测试（项目上下文发现、app 注入、prod 切换；需要真实凭据，CI 跳过）
```

CI 只运行无凭据的协议级冒烟测试与敏感信息扫描；集成测试需要真实 Grafana 环境，请在本机运行。

## Roadmap

- [ ] Node 兼容编译产物（降低 bun 前提）
- [ ] 仪表盘面板数据读取
- [ ] 更多环境变量发现来源（direnv 等）

## 关于作者

itzhouq — 个人网站 [itzhouq.cn](https://itzhouq.cn)，在那里持续 build in public。其他开源工具：

- [archery-mcp](https://github.com/itzhouq/archery-mcp) — 让 AI 只读接入 Archery SQL 审计平台的 MCP server（生产表结构查询 + 上线 SQL 预检）

欢迎 issue / PR；安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道，不要开 public issue。

---

mcp-name: io.github.itzhouq/grafana-mcp

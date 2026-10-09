# Changelog

本项目的版本发布遵循 [Semantic Versioning](https://semver.org/)，发版为 tag 驱动：推送 `v*` tag 自动发布 npm 并同步 MCP Registry。

## [0.1.5] - 2026-10-09

- 新增**环境级 app 标签**：同一项目在 test/prod 的 app 命名往往不同，现支持按环境配置
  - `.mcp.json` env：`GRAFANA_{ENV}_APP`（app 标签值）与 `GRAFANA_{ENV}_APP_LABEL`（标签名，默认 `app`）
  - `.grafana.json`：`environments.{env}.app` / `environments.{env}.appLabel`
  - `~/.zshrc`：`GRAFANA_{ENV}_APP` / `GRAFANA_{ENV}_APP_LABEL`
- 环境级 app 优先于项目级 `GRAFANA_APP`；`switch_environment` 切换后 `loki_query` 自动改用该环境的 app，注入来源在输出中标注
- `project_context` 显示当前环境生效的 App 及其来源；当项目级默认 App 被环境级配置覆盖时明确提示
- README 新增环境级 app 配置说明；examples 双环境示例补充 `GRAFANA_{ENV}_APP`

## [0.1.4] - 2026-10-08

- 修复 `.mcp.json` env 中 `GRAFANA_APP` / `GRAFANA_NAMESPACE` / `GRAFANA_APP_LABEL` / `GRAFANA_NOTES` 不生效的问题（之前只从 `.grafana.json` 读取）
- 修复仅在进程环境变量（`.mcp.json` env）中配置 `GRAFANA_{ENV}_*` 时 `switch_environment` 报"未知环境"的问题（`availableEnvs()` 现扫描进程环境变量）
- `project_context` 输出增强：显示 `.mcp.json` env 已配置的环境列表，标注项目信息字段来源
- README 重写"快速开始"为两种方式：完全项目级配置（零全局依赖）和 zshrc 全局凭据 + 项目级上下文
- examples 更新为完整双环境配置示例

## [0.1.3] - 2026-10-07

- 发版链路切换为 GitHub Actions OIDC Trusted Publishing（首个由 CI 发布的版本）

## [0.1.2] - 2026-10-07

- serverInfo 版本号改为从 package.json 读取（单一来源，修复握手版本不一致）

## [0.1.1] - 2026-10-07

- package.json 增加 `mcpName` 字段（MCP 官方 Registry 对 npm 包的归属校验要求）

## [0.1.0] - 2026-10-07

首个公开发布版本。

- 10 个只读工具：`project_context` / `switch_environment` / `loki_query` / `loki_labels` / `prom_query` / `prom_instant` / `tempo_search` / `tempo_trace` / `alerts` / `datasources`
- 项目上下文：项目根 `.grafana.json` 声明 app / namespace / 默认环境 / 数据源 UID
- test / prod 双环境切换，字段级配置合并优先级（rc 文件 → 全局配置 → 项目配置 → 进程环境变量）
- 非交互 shell 兼容：直接解析 `~/.zshrc` / `~/.zshenv` 文本提取 `GRAFANA_{ENV}_*` 变量
- 可选 1Password 回退（`GRAFANA_OP_VAULT` / `GRAFANA_OP_ITEM`）
- 输出保护：超 6 万字符自动截断；命中 limit 上限明确提示

[0.1.0]: https://github.com/itzhouq/grafana-mcp/releases/tag/v0.1.0

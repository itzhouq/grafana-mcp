# Changelog

本项目的版本发布遵循 [Semantic Versioning](https://semver.org/)，发版为 tag 驱动：推送 `v*` tag 自动发布 npm 并同步 MCP Registry。

## [0.1.0] - 2026-10-07

首个公开发布版本。

- 10 个只读工具：`project_context` / `switch_environment` / `loki_query` / `loki_labels` / `prom_query` / `prom_instant` / `tempo_search` / `tempo_trace` / `alerts` / `datasources`
- 项目上下文：项目根 `.grafana.json` 声明 app / namespace / 默认环境 / 数据源 UID
- test / prod 双环境切换，字段级配置合并优先级（rc 文件 → 全局配置 → 项目配置 → 进程环境变量）
- 非交互 shell 兼容：直接解析 `~/.zshrc` / `~/.zshenv` 文本提取 `GRAFANA_{ENV}_*` 变量
- 可选 1Password 回退（`GRAFANA_OP_VAULT` / `GRAFANA_OP_ITEM`）
- 输出保护：超 6 万字符自动截断；命中 limit 上限明确提示

[0.1.0]: https://github.com/itzhouq/grafana-mcp/releases/tag/v0.1.0

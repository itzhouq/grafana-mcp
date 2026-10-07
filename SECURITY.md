# 安全策略

## 报告漏洞

如果你发现安全漏洞，请**不要**开 public issue，使用 GitHub 的 [私密安全报告](https://github.com/itzhouq/grafana-mcp/security/advisories/new)（Private Vulnerability Reporting）提交。

请在报告中包含：影响范围、复现步骤、可能的修复思路。会在 72 小时内确认，修复后发布补丁版本并致谢报告者。

## 安全模型说明

- 本项目全部工具为**只读查询**，不提供任何写操作能力。
- 凭据（Grafana 账号密码）仅在本机内存中使用，不落盘、不写入日志、不在工具输出中回显（`project_context` 对密码脱敏）。
- 建议始终使用 Viewer 角色的专用最小权限账号，遵守所在组织的数据安全与审计规定。

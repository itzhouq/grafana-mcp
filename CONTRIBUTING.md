# 贡献指南

感谢关注本项目！这是一个刻意的**零依赖单文件**实现（`index.ts`，bun 直接运行），贡献时请保持这一设计取向。

## 开发环境

```bash
# 安装 bun：https://bun.sh
bun run smoke    # 无凭据也可跑（协议级冒烟）；本机配好 GRAFANA_TEST_URL 后自动追加真实查询
bun run test     # 集成测试，需要真实 Grafana 环境，仅本机运行
```

## 提交前检查

1. `bun run smoke` 通过
2. `bash scripts/check_sensitive.sh` 通过——请勿提交任何真实 URL、凭据、内部网络信息
3. 新工具请同步更新 README 工具表与 CHANGELOG

## 约定

- 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` …）
- 新功能请先开 issue 讨论再动手
- 安全漏洞不要开 issue，走 [SECURITY.md](SECURITY.md) 私密渠道

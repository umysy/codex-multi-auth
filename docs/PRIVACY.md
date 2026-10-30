# 隐私与环境隔离

仓库只保存源码、示例配置和无账号测试夹具。真实账号文件、token、会话、额度日志和状态文件位于 `CODEX_HOME\multi-auth`，不属于 Git 工作树，也不应复制到仓库。

开发面板使用 `panel/dev-server.ps1` 创建独立的 `CODEX_HOME`。测试必须使用临时目录；开发环境不会自动覆盖正在使用的正式目录。

面板的 `/api/logs` 和 `/api/diagnostics` 返回脱敏内容。诊断快照不包含账号文件、凭据、邮箱或绝对路径，适合附在 issue 中；分享前仍应检查自己添加的备注和外部 CLI 输出。

运行时会定期限制日志、事件、路由退出记录和面板缓存的大小，并清理过期临时文件。清理只处理运行态目录，不删除会话或账号数据。

发布前检查：

1. `git status --ignored --short` 确认没有把运行态文件加入提交。
2. `npm run verify` 和 `npm run e2e` 通过。
3. 只分享 `/api/diagnostics` 的脱敏结果，不分享 `openai-codex-accounts*.json`、`auth.json`、完整日志或 `.codex` 目录。

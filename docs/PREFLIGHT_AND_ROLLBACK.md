# 真实环境预检与回滚

正式账号目录不应直接由开发工作树覆盖。发布前先在隔离输出目录执行 DryRun 预检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\policy-preflight.ps1 `
  -CodexHome "$env:USERPROFILE\.codex"
```

预检会读取真实 `CODEX_HOME` 的账号状态、额度和策略，但不会执行切号、暂停、恢复或角色变更。输出目录里会留下脱敏前的本地日志，只能在本机查看，不能上传到 GitHub。

确认预检正常后，再创建版本快照：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\snapshot.ps1 -Note "pre-release <commit>"
```

升级后验证路由、面板和策略状态。若出现 503、pin 残留或策略错误，先停止面板，再按快照 ID 回滚：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\revert.ps1 -Id <snapshot-id>
```

回滚不会覆盖账号额度、会话、token 或使用记录。回滚后重新启动面板，并确认 `quota-policy.state.json`、`quota-policy.log` 和 `/api/diagnostics` 的状态恢复正常。

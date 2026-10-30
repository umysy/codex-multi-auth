# 文件归属与清理约定

本项目同时包含源码、正式测试、开发脚本和桌面发布产物。文件是否保留，按归属判断，不按文件名猜测。

## 长期维护并提交 Git

- `panel/`：面板后端、策略核心、前端和桌面端源码。
- `panel/test/`：Node 单元、契约和集成测试；与源码一起回归。
- `panel/tests/`：需要真实浏览器/模拟服务的操作式 E2E 测试。
- `scripts/`：语法、编码、配置、依赖和测试入口检查。
- `docs/`：架构、隐私、部署、回滚和轮换策略文档。
- 根目录示例配置、启动脚本、CI 和锁定的审计记录。

## 只在开发或发布时生成

- `panel/app/bin/`：.NET 构建输出。唯一可交付的桌面文件是
  `panel/app/bin/Release/net8.0-windows/win-x64/publish/CodexQuota.exe`；其余 Debug、obj 和依赖缓存都可重新生成。
- `panel/app/obj/`：编译中间文件，禁止提交。
- `.scratch/`：按 SOP 保存可追踪 Ticket 或交接材料；一次性调试文件应放 `.tmp/`，不能把 `.scratch/` 当垃圾桶。
- `.audit/*.txt`：本地测试输出，不作为长期证据；需要保留的结论写入 Git 跟踪的审计记录或 CI 证据。

## 只属于使用环境

真实账号、令牌、日志、额度缓存、运行状态、备份和版本快照只允许出现在
`%USERPROFILE%\\.codex\\multi-auth`。它们不能复制到仓库，也不能用于开发测试。

## 清理原则

删除前先检查 Git 跟踪状态、引用和是否属于正式测试。只删除可重生成的构建输出、过期测试截图和本地报告；不删除测试源码、架构文档、Ticket、回滚备份或用户数据。

推荐清理命令：

```powershell
dotnet clean panel/app/CodexQuota.csproj
Remove-Item -Recurse -Force panel/app/bin/Debug, panel/app/obj
```

清理后如需桌面发布包，重新执行 `dotnet publish`，再把发布产物按部署清单复制到使用环境。

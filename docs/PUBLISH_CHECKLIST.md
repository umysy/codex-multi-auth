# GitHub 公开发布清单

这个仓库不能做到“下载后不需要准备就直接切号”。账号登录、Node.js、`codex-multi-auth` 和 Windows 计划任务都必须由使用者在自己的电脑上完成。仓库可以提供可重复的安装和验证步骤，但不能替别人登录账号，也不能把你的运行态复制给别人。

## 发布前

1. 在开发仓库执行 `npm run verify`。其中 `npm run privacy` 会检查 Git 跟踪文件里的运行态文件、绝对 Windows 用户路径、凭据样式和非示例邮箱。
2. 执行 `git status --ignored --short`，确认账号 JSON、`auth.json`、日志、状态、缓存、`versions/` 和构建目录都没有被跟踪。
3. 检查 `git diff --cached --stat` 和 `git diff --cached`，尤其不要使用 `git add -f` 添加运行目录。
4. 在干净的临时目录从当前提交重新 clone，按“首次使用”步骤走一遍。不要用正在使用的 `%USERPROFILE%\\.codex\\multi-auth` 代替这个验证目录。
5. 只发布源码和示例配置。桌面 exe 默认不进仓库，由 CI 编译；发布桌面包时单独提供经过校验的 Release artifact。
6. 检查 Git 历史，而不只是当前文件：`git log --all -p` 里可能保留旧版本的本机路径、进程号或个人用量记录。若历史包含任何个人信息，先从一个干净的公开起点发布，或使用经过备份和复核的历史重写；不要直接把旧历史推到公开仓库。

## 使用者首次安装

使用者需要 Windows 10/11、Node.js 20 或更高版本、PowerShell 5.1、.NET 8（只在自行编译桌面端时需要）以及 `codex-multi-auth`。安装者必须自己执行 `codex-multi-auth login` 完成账号授权。

```powershell
npm i -g codex-multi-auth
git clone https://github.com/umysy/codex-multi-auth.git "$env:USERPROFILE\\.codex\\multi-auth"
cd "$env:USERPROFILE\\.codex\\multi-auth"
Copy-Item panel-config.example.json panel-config.json
powershell -ExecutionPolicy Bypass -File panel/install.ps1
```

首次使用先把 `autoSwitch` 保持为 `false`，确认面板能读到账户和额度，再启用自动切换。轮转脚本需要由 Windows 计划任务每 5 分钟调用 `wscript.exe run-quota-policy.vbs`；路由看门狗使用 `run-ensure-router.vbs`。安装器不会替用户创建凭据，也不会默认打开自动切号。

## 隐私边界

真实账号文件、refresh/access token、Codex 会话、邮箱、额度日志、完整错误日志和本机路径只存在使用者自己的 `CODEX_HOME`。问题反馈只附 `/api/diagnostics` 的脱敏结果，并手动检查备注和外部 CLI 输出。不要上传 `auth.json`、`openai-codex-accounts*.json`、`.codex` 目录或完整 `quota-policy.log`。

## 扩展入口

- 改轮换判断：`panel/policy-core.js`，然后补 `panel/test/policy-core.test.js` 和冻结 fixture。
- 改默认配置或校验：`panel/lib/policy-config.js`、`panel/lib/config-schema.js` 和 `*.example.json`。
- 改 API：`panel/lib/routes.js`，同时补后端契约测试。
- 改网页界面：`panel/public/modules/`；改桌面界面：按 `NativeForm.Layout/Render/Actions/Refresh/Lifecycle/Utility` 的职责选择文件。
- 改启动方式：`panel/install.ps1` 和对应的 UTF-16LE VBS 启动器。

规则判断只保留在策略内核，PowerShell 只取数、执行和落盘。新增功能必须先补行为测试，再运行 `npm run verify`；CI 失败时不要发布。

## 发布方式建议

开发在私有仓库进行；公开仓库是另一个独立的 Git 仓库，只放一份份同步过来的快照，不共享历史。私有仓库永远不加为公开仓库的 remote，也不把私有分支推到公开仓库。

每次发布一版：

1. 在私有仓库提交所有改动，运行 `npm run verify`。
2. `node scripts/sync-public.js <公开仓库的本地目录>`：
   - 按私有仓库 HEAD 覆盖公开仓库的工作区，删除已不存在的文件，跳过 `.audit/`（内部决策记录）；
   - 再拿本机真实的敏感值逐个比对写出的文件：路由新旧 key（含 `versions/` 备份里的历史 key）、identity token、各账号的 token / id / 邮箱、Codex 登录 token。命中任何一个就失败。
3. 在公开仓库目录运行 `npm run verify`，看一遍 `git status` 和 `git diff --stat`。
4. 提交，说明写 `Sync from private <短哈希>`，推送 `main`。

不要把真实的 `CODEX_HOME`、部署备份或生产日志作为发布来源。

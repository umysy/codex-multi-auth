# 开发环境与使用环境分离

这个项目同时存在两份"看起来一样"的目录，**改动只允许落在开发环境**。改错地方会直接弄坏正在使用的 Codex。

| | 使用环境（生产） | 开发环境 |
| --- | --- | --- |
| 路径 | `%USERPROFILE%\.codex\multi-auth` | 本仓库（`<repo>` 或任意 clone） |
| 内容 | 真实账号 JSON、日志、state、`panel-config.json`、`versions/` 快照 | 只有源码、示例配置、测试 |
| 是否 git 仓库 | 否 | 是 |
| 谁写它 | 运行中的策略脚本 / 面板（`quota-policy.ps1`、`panel/server.js`） | 只有你（编辑器 / 命令） |
| 出现错误 | 你的 Codex 立刻中断 | CI 或本地测试失败 |

## 铁律

1. **开发只改仓库，不改 `%USERPROFILE%\.codex\multi-auth`。** 那个目录里的文件是运行态，不是源码；
   直接改它等于绕过测试和审查。
2. **任何会写盘的测试/脚本必须用沙箱 `CODEX_HOME`。**
   `panel/test/server.contract.test.js` 用 `mkdtemp` 建临时 `CODEX_HOME`；
   `panel/tests/e2e-mock.js` 起纯内存 mock（127.0.0.1:8799），都不碰真实环境。
3. **本地跑面板必须用沙箱启动器**（见下），不要直接 `node panel/server.js`——
   后者的数据目录默认指向真实 `~/.codex\multi-auth`。
4. **部署是一次显式动作，不是开发的副作用。** 见文末清单，先备份、再复制、再验证。

## 开发常用命令

账户规则行为通过 `npm run verify` 回归，其中真实策略执行器使用沙箱与假 CLI。桌面额外运行：

```
dotnet run --project panel/test/desktop-api/DesktopApiTests.csproj -c Release
dotnet run --project panel/test/desktop-rules/DesktopRuleTests.csproj -c Release
```

第二条只实例化规则编辑对话框并操作虚拟账户，不启动主面板、不写正式配置。界面设置和字段语义见 [轮换策略](ROTATION_POLICY.md)。

```powershell
cd <repo>

npm run verify    # 语法 + 编码 + 启动器语法 + 前端 id + 配置示例 + 依赖方向 + 当前测试集（不需要 npm install）
npm run e2e       # 端到端 mock（纯内存，14 项）
dotnet run --project panel/test/desktop-api/DesktopApiTests.csproj -c Release # 桌面 HTTP 响应校验（仅本地假服务）
npm run dev:panel # 沙箱面板：数据在 %LOCALAPPDATA%\CodexMultiAuth-dev，端口 18766
```

`dev:panel` 会打印沙箱路径；它不会读取或修改真实使用环境的配置和日志。
注意：面板上的"切换账号 / 刷新额度"等按钮最终仍会调用本机 `codex-multi-auth`
（CLI 本身没有沙箱模式），所以本地联调时**尽量只看不点**；要压测这些动作，用 `npm run e2e`。

## 现在的真实使用环境在跑什么

- 计划任务/VBS 定时拉起 `quota-policy.ps1`（现在是薄壳：取数 → `panel/policy-cli.js` 决策 → 执行；
  已部署版本还带运行时信号读取、窗口重置后清旧 429、pin 自动解除）。
- 面板后端 `panel/server.js` 读 `~/.codex\multi-auth` 下的配置与账号文件。
### 路由进程为什么重启面板后会消失（已修）

- 现象：每次 panel\\restart-app.ps1 之后约 1 分钟路由就不在了，Codex 一直「重连」。
- 根因：托盘退出走 Process.Kill(entireProcessTree: true)，而路由以前是面板 spawn 出来的子进程，被一起杀掉。
- 现在：路由由 pp-bind\\router-launch.vbs（wscript）脱壳启动——wscript 立刻退出，路由不在面板进程树里。
- 退出码：pp-bind\\runtime-rotation-app-router-launch.log 里会有 ROUTER-EXIT exit=<code>；路由 0 字节消失时先看它。
- 面板「事件」页也会出现 `ROUTER  路由进程退出（exit=<code>，发生在 …）`（看门狗下一轮 tick 读到新记录后补写，
  面板重启不会重复刷旧记录）。

- Codex 运行时会把当前账号 pin 住；**被 pin 的账号撞上 429 时，Codex 会缓存
  "rate-limited" 直到窗口重置，期间所有请求 503**，即使策略脚本看到的上限数据还是"有额度"。
根因是 pin 在已限流的账号上（"Pinned account N is currently unavailable"），与仓库代码改动无关。

**新版策略已把这件事自动化**：`autoSwitch` 模式每次运行开头解除遗留 pin（日志 `UNPIN 已解除账号固定`），
`Try-Switch` 成功切号后也立即 `unpin`；面板账号卡片上有「已固定 / 解除固定」。手动模式（`autoSwitch=false`）
保留用户自己的 pin，需要时按 `codex-multi-auth unpin` 解除。

如果 503 出现在"额度看起来还有"的时候，先看 `runtime-observability.json` 的 `accountSkipReasons`：
`cooling-down:*` 表示上游网络抖动/超时后运行时临时拉黑了该账号，`rate-limited` / `quota-exhausted` 表示上游已限流。
这三种都算硬阻塞，新策略当轮换号，看门狗也会在 1 分钟内踢一次策略；切走时额度健康的账号不会被暂停，留给运行时做即时故障转移。

如果 Codex 提示「额度用完，X 点重置」而面板显示其它账号还有额度：运行时把请求派给了 5h 已满的那个号，
429 被客户端翻译成"额度用完"。新版策略会自动暂停耗尽的日常号（日志 `PAUSE 日常号额度耗尽…`，
`state.exhaustedPaused` 记录是谁被暂停的），窗口重置后自动 `RESUME`；储备号不参与。
`-DryRun` 只输出 `DRYRUN 将暂停/将恢复`，不改账号状态。

## 部署到使用环境（显式清单）

只在"用户同意升级"时执行。整个过程不用改 `openai-codex-accounts*.json`、
`panel-config.json`、`account-policies.json`、日志和 `versions/`。

1. 开发环境全绿：`npm run verify`，改了桌面端再跑
   `dotnet build panel/app/CodexQuota.csproj -c Release`。
2. 备份使用环境的脚本与面板：
   `versions\deploy-<yyyyMMdd-HHmm>\`（复制 `quota-policy.ps1`、`panel\*.js`、
   `panel\public\`、`panel\lib\`）。
3. 复制白名单：
   - 根目录：`quota-policy.ps1`、`ensure-router.ps1`、`snapshot.ps1`、`revert.ps1`、`run-*.vbs`
   - `panel\`：`server.js`、`usage.js`（入口）、`lib\usage\`（用量分层）、`policy-core.js`、`policy-cli.js`、`lib\`、`public\`、
     `install.ps1`、`restart-app.ps1`、`start-*.vbs`
   - 桌面端只有重新 `dotnet publish` 后才替换 `panel\desktop\CodexQuota.exe`
4. 重启面板（`panel\restart-app.ps1` 或托盘退出重开），等一个策略周期。
5. 验证：`codex-multi-auth status --json` 正常、`quota-policy.log` 出现新记录、
   面板能打开且 `/api/state` 有数据；有问题用 `versions\` 里的备份回滚。

## Codex 喊"额度用完"但代理还有额度？

说明代理侧有号可用，**应用侧登录的却是另一个（已用满的）账号**。应用界面的额度横幅读的是
`~/.codex/auth.json` 里的登录账号，不读代理的轮转结果。

1. 面板顶部看「应用登录」pill：显示应用登录邮箱；与当前代理账号不一致时会标黄提示。
2. 点「同步应用登录」：把 `auth.json` 换成代理当前账号（自动备份 `auth.json.bak-<时间戳>`）。
3. 重启 Codex 应用（登录态只在启动时读）。

接口：`POST /api/app-login { email?: string, n?: number }`；不带参数 = 代理当前账号。

## 排查清单（Codex 突然不可用）

1. `codex-multi-auth status --json` → 看 `pinnedAccountIndex` / `activeIndex`；
2. `codex-multi-auth limits --json` → 哪个账号的 `primary/secondary` 打满；
3. `quota-policy.log` 尾部 20 行 + `quota-policy.state.json` → 策略最近一次决策；
4. 若 pinned 的账号已限流：等新版策略下一轮（≤5 分钟）自动 `unpin`；手动模式或未升级时自己执行 `codex-multi-auth unpin`，让运行时重新选号；
5. 仍不行：`panel\desktop\CodexQuota.exe` 面板里看额度，或 `codex-multi-auth switch <n>` 手动切到健康账号。
6. `GET /models` 返回 503 `account_catalog_unavailable` 时**不一定是故障**：代理需要 `client_version` 查询参数（如 `?client_version=0.164.0`）或 `version` 请求头才会返回目录，不带参数会 503；真实 Codex 客户端都会带。先按上面 1–5 查，再怀疑这个接口。

# Codex 额度面板（CodexMultiAuth）

[![CI](https://github.com/umysy/codex-multi-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/umysy/codex-multi-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给 **Codex CLI** 多账号用户用的额度轮转与监控套件：用一份策略脚本在多个账号之间自动切换，
配一个本地 Web/桌面控制台，随时看清每个账号的 5 小时窗口和 7 天窗口还剩多少。

> 本项目只是 `codex-multi-auth` 的**外围策略层与界面**，不修改、不重打包 Codex CLI 本身，
> 也不会绕过服务端的额度限制——它只在**账号之间**做调度。请自行遵守 OpenAI 的服务条款。
> 注意区分：本仓库 `umysy/codex-multi-auth` 是面板；同名的 npm 包 `codex-multi-auth` 是它依赖的 CLI，需要另外安装。

---

## 它解决什么问题

多账号 + 单一额度窗口 = 频繁手动 `codex login` 换号。本项目的做法：

1. `quota-policy.ps1` 周期性读取 `codex-multi-auth` 暴露的用量，算出「当前账号还能撑多久」；
2. 到阈值时调用 `codex-multi-auth` 切到下一个账号（可按优先级/权重/储备号规则）；
3. `ensure-router.ps1` 作为看门狗，保证本地路由进程活着；
4. `panel/` 提供一个只监听 `127.0.0.1` 的控制台，可视化当前状态、手动刷新/切换/暂停账号、改阈值、触发登录。

桌面端「策略」页（选「自定义账户规则」）及网页版策略区支持多个日常号/备用号、顺序、额度阈值、等待刷新、切换间隔和单号覆盖。详见 [账户规则设置](docs/ROTATION_POLICY.md)。

## 组件

| 路径 | 作用 |
| --- | --- |
| `quota-policy.ps1` | **策略执行器（薄壳）**。取数（status/limits/账号策略）→ 调 `panel/policy-cli.js` 拿决策 → 按决策落日志/状态/执行切号；由计划任务或 VBS 定时拉起。判断逻辑不在这里。 |
| `ensure-router.ps1` | **路由看门狗**。确保 Codex 运行时路由进程存在，异常时重启，避免 CLI 断连。 |
| `snapshot.ps1` / `revert.ps1` | 状态快照与回滚，方便改动策略前留一手。 |
| `run-quota-policy.vbs` / `run-ensure-router.vbs` / `run-router.vbs` | 无窗口启动器（给计划任务和自启项用）。 |
| `panel/server.js` | **本地控制台后端（装配层，约 80 行）**。Node HTTP 服务，仅绑定 `127.0.0.1`，负责分发与启动；其余逻辑在 `panel/lib/`。 |
| `panel/lib/` | 控制台后端的内部模块：`panel-http`（token/信封/静态）、`routes`（/api/* 路由表）、`dashboard`（状态读模型）、`router-control`、`login-flow`、`watchdogs`、`paths`、`app-auth`/`proxy-accounts`（应用登录）等；依赖单向，禁止循环 require。 |
| 应用登录同步 | Codex 应用自己的登录态（`~/.codex/auth.json`）决定界面显示哪个账号、额度横幅读谁的限额。面板顶部显示应用登录账号；与代理当前账号不一致时标黄提示，并可一键同步（自动备份，重启应用生效）。接口 `POST /api/app-login`。 |
| `panel/public/` | 前端（原生 HTML + CSS + ES 模块，无构建步骤）：`app.mjs` 只做装配，`modules/*.mjs` 分别负责格式化、API、DOM、渲染、动作。 |
| `panel/policy-core.js` | **纯函数策略内核**——决策规则的唯一实现，无 IO。 |
| `panel/policy-cli.js` | 决策的进程边界：`node panel/policy-cli.js decide --in in.json --out out.json`（PS1 与测试都走它）。 |
| `panel/lib/policy-config.js` / `policy-decision.js` | 配置默认值与钳位的唯一实现；`normalizePolicy → decide` 的单条链（HTTP 试算与脚本共用）。 |
| `panel/usage.js` + `panel/lib/usage/` | **用量分析**。入口只做 3 分钟缓存。“全部账号”来自 `~/.codex/sessions` 与 `state_5.sqlite`；按账号来自路由账本（`usage/usage-ledger.jsonl`，每个请求实际用的账号），并按 token 数配对回会话，拿到角色与会话排行。 |
| `panel/app/` | **桌面端**（C# WinForms，.NET 8）。原生窗口渲染同一份数据并负责拉起后端；主窗口 `NativeForm` 按职责拆成 7 个 partial 文件。 |
| `panel/install.ps1` | 安装器：创建桌面/开始菜单快捷方式、注册 `App Paths`（Win+R 输入 `CodexQuota`）、可选自启。 |
| `panel/test/`、`panel/tests/` | 单元测试（`node --test`）与端到端 mock（假后端 + 真实 DOM 断言）。 |
| `docs/使用说明.txt` | 面向使用者的操作手册（含常见故障处理）。 |

## 架构

```
┌────────────────┐   x-panel-token    ┌──────────────────┐
│ 浏览器 / 桌面端 │ ─────────────────► │ panel/server.js  │
└────────────────┘   127.0.0.1:8766   └────────┬─────────┘
                                               │ 读写
                       ┌───────────────────────┼──────────────────────┐
                       ▼                       ▼                      ▼
              panel-config.json      openai-codex-accounts.json   ~/.codex/sessions
              account-policies.json  （codex-multi-auth 维护）        state_5.sqlite
                       ▲
                       │ 每 5 分钟读配置并判定
                ┌──────┴─────────┐        ┌──────────────────┐
                │ quota-policy.ps1│ ──────►│ codex-multi-auth │  切号 / 登录
                └────────────────┘        └──────────────────┘
```

原则：**策略脚本是唯一会改账号状态的东西**，面板只写配置和状态文件，不直接动凭据。
这样即使面板挂了，轮转也不会失控。

判断本身也只有一份实现：`quota-policy.ps1` 只负责取数与执行，把输入交给
`node panel/policy-cli.js decide`，真正算 `action` 的是 `panel/policy-core.js`；
面板的 `POST /api/policy/preview` 走同一条链。所以改规则只改一个文件，
面板试算与脚本执行不可能悄悄分叉。

**关于 pin（固定）**：`codex-multi-auth switch` 会把目标账号写进 `pinnedAccountIndex`（钉住），
被钉住的账号一旦限流，Codex 运行时所有请求都会 503（"Pinned account N is currently unavailable"），
即使额度数据看起来还有余量。所以在 `autoSwitch` 模式下，`quota-policy.ps1` 每次运行开头会解除遗留 pin，
切号成功后也立刻 `unpin`，让运行时继续自动轮转；手动模式（`autoSwitch=false`）保留用户自己的 pin。
面板卡片对固定中的账号显示「已固定」，并给一个「解除固定」按钮；桌面端账号详情同样有「固定状态」与「解除固定」。

## 快速开始

### 0. 前置

- Windows 10/11、PowerShell 5.1
- Node.js ≥ 18（本仓库在 v24 上验证）
- `codex-multi-auth`（npm 全局包）

```powershell
npm i -g codex-multi-auth
codex-multi-auth login          # 依次登录你的各个账号
```

可选：给本机安装的 CLI 打补丁（模型繁忙时自动换号重试、记录实时额度），升级 CLI 后要重新执行，并重启路由：

```powershell
node scripts/patch-cli-head-retry.js
```

说明见 [docs/CLI_STREAM_HEAD_RETRY.md](docs/CLI_STREAM_HEAD_RETRY.md)。

### 1. 放进约定的安装位置

`panel/server.js` 把运行时数据目录**固定**为 `%USERPROFILE%\.codex\multi-auth`，因此推荐直接把仓库放在这里：

```powershell
git clone https://github.com/umysy/codex-multi-auth.git "$env:USERPROFILE\.codex\multi-auth"
cd "$env:USERPROFILE\.codex\multi-auth"
```

（脚本本身已全部改为基于 `$PSScriptRoot` / `os.homedir()` 定位，放在别处也能跑，
但运行时 JSON 仍会写回上面的目录。）

### 2. 生成配置

```powershell
Copy-Item panel-config.example.json      panel-config.json
Copy-Item account-policies.example.json  account-policies.json   # 可选
```

`panel-config.json` 至少要有：

```json
{ "autoSwitch": true, "minWaitMin": 60, "reserveIndex": 1, "allowFailover": true }
```

| 字段 | 含义 |
| --- | --- |
| `autoSwitch` | 总开关。`false` 时策略只观测不动手。 |
| `minWaitMin` | 距离窗口重置还剩多少分钟时允许提前切走（低于它才切）。 |
| `reserveIndex` | 保留号下标（1 起）；保留号只在其余账号全部耗尽时才启用。 |
| `allowFailover` | 切换失败时是否允许继续往下一个账号兜底。 |

### 3. 启动面板

```powershell
node panel/server.js
```

终端会打印 `Codex Quota Panel -> http://127.0.0.1:8766/`。**首次访问**会在控制台打印一次性 token，
或用快捷方式启动（自动把 token 带进 URL）。也可以双击 `panel/start-panel.vbs`（无窗口）。

更省事的做法：

```powershell
powershell -ExecutionPolicy Bypass -File panel/install.ps1
```

之后桌面/开始菜单就有「Codex 额度面板」了，Win+R 输入 `CodexQuota` 也能开。

### 4. 桌面端（可选）

需要 .NET 8 SDK：

```powershell
dotnet build panel/app/CodexQuota.csproj -c Release
# 产物：panel/app/bin/Release/net8.0-windows/win-x64/publish/CodexQuota.exe
```

单文件发布：

```powershell
dotnet publish panel/app/CodexQuota.csproj -c Release -r win-x64 --self-contained false
```

把 exe 放到 `panel\desktop\CodexQuota.exe`（`install.ps1` 和 `restart-app.ps1` 默认找这个位置）。
首次运行会在同目录生成 `app-config.json`（参考 `panel/desktop/app-config.example.json`）。

### 5. 让轮转自己跑

- 方式 A：Windows 计划任务调用 `wscript.exe run-quota-policy.vbs`，间隔 5 分钟；
- 方式 B：开启路由后由 `run-router.vbs` 挂到启动项，脚本内部自我节拍（`HEARTBEAT`）。

策略脚本每轮都会重读 `panel-config.json`，所以**面板里改阈值立刻生效**，不需要重启任何东西。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | Codex 数据根目录；会话、SQLite、账号文件都在这里。 |
| `PANEL_PORT` | `8766` | 控制台端口（只绑定回环地址）。 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 若你的网络需要代理，登录与刷新会透传这两个变量。 |
| `NO_PROXY` | `localhost,127.0.0.1,::1` | 追加到本地直连白名单。 |
| `PANEL_LOGIN_DRY` | 空 | 设为 `1` 时登录走演习模式，不真正拉起 CLI（调试用）。 |

隐私处理和开发/使用环境边界见 [docs/PRIVACY.md](docs/PRIVACY.md)。面板的「诊断快照」接口只返回脱敏状态，便于提交问题时定位错误；账号文件、token、会话和完整日志不会进入仓库。

公开发布前请按 [GitHub 公开发布清单](docs/PUBLISH_CHECKLIST.md) 检查隐私、干净 clone、首次安装和扩展入口。下载仓库后仍需安装依赖、登录自己的账号，并注册策略与路由计划任务；这些步骤无法安全地替用户自动完成。

## 测试与验收

一条命令跑完本地验收（零第三方依赖，不需要 `npm install`）：

```powershell
npm run verify
```

它依次执行：

| 命令 | 内容 | 项数 |
| --- | --- | --- |
| `npm run syntax` | 所有 `.js` / `.mjs` 过 `node --check` | 全仓库 |
| `npm run encodings` | `.vbs` 必须 UTF-16LE+BOM、含中文的 `.ps1/.cs` 必须 UTF-8+BOM、JSON 可解析 | 敏感文件 |
| `npm run privacy` | 发布前扫描 Git 跟踪文件，拦截运行态文件、绝对用户路径、凭据样式和非示例邮箱 | 公开发布闸门 |

单独的：

```powershell
node panel/tests/e2e-mock.js      # 端到端：假后端 + 真实 DOM 断言（需 Edge）
dotnet build panel/app/CodexQuota.csproj -c Release   # 桌面端编译
```

> 注意：Node 24 上 `node --test panel/test/`（传目录）会报 `MODULE_NOT_FOUND`，请给文件路径。

`panel/tests/` 里的 `mock-server.js` 提供一份纯内存假数据，不读真实账号、不发任何外网请求，
可以安全地在 CI 里跑。`panel/test/server.contract.test.js` 则会真的拉起 `panel/server.js`，
用临时 `CODEX_HOME` 隔离，验证鉴权、错误码、响应信封与配置字段名——**改坏接口它会立刻红**。

## 开发环境 ≠ 使用环境（重要）

仓库是开发环境，`%USERPROFILE%\.codex\multi-auth` 是正在运行的使用环境。
**不要在开发过程中直接改使用环境**；本地测试都用沙箱 `CODEX_HOME`，
`npm run dev:panel` 会在 `%LOCALAPPDATA%\CodexMultiAuth-dev` 起一个假数据面板。

部署是显式动作：先 `npm run verify`，备份使用环境的脚本与面板，再按
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的白名单复制、重启、验证。

## 维护性：改一个功能会不会弄坏别处

这个项目最怕的不是功能少，而是**改 A 坏 B 且不报错**。为此加了九道机械闸门和一份改动地图：

| 闸门 | 拦什么 |
| --- | --- |
| CI（`.github/workflows/ci.yml`） | push/PR 自动跑完整 `npm run verify`（语法、编码、启动器、前端 id、配置、依赖方向、当前测试集），并在 Windows 上编译桌面端；红了不许合并 |
| 契约测试（`panel/test/server.contract.test.js`） | 起真后端，锁死 `/api/*` 的鉴权、错误码、响应信封、`panel-config.json` 字段名、试算接口 |
| 决策 fixture（`panel/test/fixtures/policy-decisions.json`） | 11 个冻结场景的输入/期望动作；规则一改，测试立刻指出哪些场景变了 |
| 编码检查（`scripts/check-encodings.js`） | `.vbs` 被存成 UTF-8、含中文的 `.ps1/.cs` 丢了 BOM——这类问题 diff 里看不出来，运行时才炸 |
| 启动器语法（`scripts/check-vbs.js`） | `.vbs` 引号/语法错误——编码对但引号多一个时，计划任务只会静默退出码 1，看起来像"策略没跑" |
| 前端 id（`scripts/check-frontend-ids.js`） | 改了 `index.html` 的 id、前端模块还按旧名字 `$('#x')` 取值——浏览器不报错，只是安静地拿到 null |
| 静态资源清单（`panel/test/static-manifest.test.js`） | 新加前端模块却忘了改两个服务器的 `STATIC` 表、或 `app.mjs` 的 import 路径写错——浏览器 404 直接白屏 |
| 配置示例（`scripts/check-config-examples.js`） | `*.example.json` 与代码里的字段定义漂移——用户照 README 复制出来的配置从第一步就是坏的 |
| 依赖方向（`scripts/check-imports.js`） | 下层模块 import 上层、后端依赖前端、纯模块引入 IO、依赖成环、新模块没登记分层表——运行时都正常，坏的是可维护性 |

**要加/改功能，先看 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**，里面有：模块边界与依赖方向、
五条不变式、**改动矩阵**（想做什么 → 动哪几个文件 → 怎么验证）、扩展配方、以及按严重度排序的技术债清单。

三条最容易踩的铁律，也写在 [CONTRIBUTING.md](CONTRIBUTING.md)：

1. **决策只有一份实现**：规则只写在 `panel/policy-core.js` 的 `decide()` 里；`quota-policy.ps1` 只取数、执行、落盘。
   改规则时同步改 `panel/test/fixtures/policy-decisions.json` 里受影响的期望值——`npm test` 会告诉你哪些场景变了。
2. **配置归一化只有一份**：默认值与钳位在 `panel/lib/policy-config.js`，面板（`server.js`）和脚本（`policy-cli.js`）共用。
3. **API 字段名是三端契约**：`panel/lib/routes.js`（后端）写、`public/app.mjs` 与 `public/modules/*.mjs` 读、`app/Api.cs` 读；改名会静默变空白。

如果你要加一个"面板上试算新规则"的功能，不需要动 PowerShell：
`POST /api/policy/preview` 已经复用同一条决策链，前端把额度数据传进去就能拿到决策与理由。

## 安全边界

这个项目会接触**账号凭据**，所以边界写死：

- 控制台**只监听 `127.0.0.1`**，不做端口转发、不开 CORS；
- 每次启动生成随机 `x-panel-token`，缺失即 403；
- `.gitignore` 硬排除 `openai-codex-accounts*.json`、`auth.json`、各类日志与缓存——
  **这些文件里是 refresh/access token，永远不要提交**；
- 仓库内所有示例配置均为占位符（`example.com`、`sha256:<account-key-sha256>`），无真实账号信息；
- 不收集遥测，不往任何第三方端点发数据。

如果你 fork 后要公开，请先 `git log -p | Select-String "access_token|refresh_token"` 自查历史。

## 目录结构

```
.
├── quota-policy.ps1            策略执行器（薄壳；判断走 panel/policy-cli.js）
├── ensure-router.ps1           路由看门狗
├── snapshot.ps1 / revert.ps1   快照与回滚
├── run-*.vbs                   无窗口启动器（UTF-16LE）
├── panel-config.example.json
├── account-policies.example.json
├── package.json                npm run verify / test / e2e
├── scripts/                    闸门脚本（语法、编码、启动器、前端 id、配置示例、依赖方向）
├── .github/workflows/ci.yml    CI：九道闸门 + 桌面端编译
├── docs/
│   ├── 使用说明.txt            面向使用者
│   ├── ARCHITECTURE.md         面向维护者：边界、不变式、改动矩阵、技术债
│   └── DEVELOPMENT.md          开发/使用环境分离、沙箱命令、部署清单
├── CONTRIBUTING.md             提交规范、编码要求、两条铁律
├── CHANGELOG.md
└── panel/
    ├── server.js               控制台后端（装配层：HTTP + 路由分发）
    ├── usage.js                用量分析
    ├── lib/usage/             用量统计分层实现（paths / threads / accounts / sessions / buckets / collect / index）
    ├── policy-core.js          纯函数策略内核（决策的唯一实现）
    ├── policy-cli.js           决策的进程边界（PS1 调它）
    ├── lib/                    后端内部模块（paths/http/routes/dashboard/…）+ 策略与配置 schema，17 个文件
    ├── install.ps1             安装器（快捷方式 / App Paths / 自启）
    ├── restart-app.ps1
    ├── start-panel.vbs / start-server.vbs
    ├── public/                 前端入口与样式（无构建）
    │   ├── app.mjs              装配层：读状态 / 渲染 / 事件 / 轮询
    │   ├── modules/             ES 模块：format / api / dom / render-* / actions
    ├── app/                    WinForms 桌面端（NativeForm 按职责拆成 7 个 partial）
    │   ├── NativeForm.cs            字段 + 构造（装配）
    │   ├── NativeForm.Layout.cs     搭界面（429 行）
    │   ├── NativeForm.Refresh.cs    刷新流程（137 行）
    │   ├── NativeForm.Render.cs     渲染（360 行）
    │   ├── NativeForm.Actions.cs    按钮动作（173 行）
    │   ├── NativeForm.Lifecycle.cs  托盘 / 窗口生命周期（147 行）
    │   ├── NativeForm.Utility.cs    时间 / 数字格式化（50 行）
    │   ├── Api.cs / Infra.cs / AppLog.cs / IconFactory.cs
    │   ├── UsageView.cs / LoginPromptDialog.cs / Program.cs
    │   └── CodexQuota.csproj / app.manifest
    ├── test/                   单元测试 + fixture 回归 + 读模型 + 真实后端契约测试
    │   └── fixtures/           冻结的决策行为表（改规则时同步改）
    └── tests/                  端到端 mock
```

## 已知限制

- 仅 Windows：依赖计划任务、`wscript.exe`、WinForms 与注册表 `App Paths`。
- 决策只有一份实现；`panel/test/fixtures/policy-decisions.json` 是冻结的行为表——
  改规则时要同步改受影响的期望值，否则测试会红（这是故意的，避免「改了却不知道哪些场景变了」）。
- 策略脚本依赖 `codex-multi-auth` CLI 的 `status --json` / `limits --json` / `account policy list --json`
  输出形状；上游改字段时需要同步改 `quota-policy.ps1` 的取数段（决策本身不受影响）。
- 面板保存策略只归一化 UI 认识的三项；`panel-config.json` 里其它字段（如 `allowFailover`）原样保留。
- 三个 `*.example.json` 由 `npm run config` 按 `panel/lib/config-schema.js` 校验，示例与代码字段一漂移就红。
- 用量统计依赖 `codex-multi-auth` 的文件结构与 `state_5.sqlite` 的 schema，上游变动可能失效。
- 仓库初始版本从作者本机工程裁剪而来，不含构建产物；`desktop/CodexQuota.exe` 需自行 `dotnet publish`。

## License

[MIT](LICENSE)

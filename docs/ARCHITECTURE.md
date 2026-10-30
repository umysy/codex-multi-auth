# 架构与维护指南

> 这份文档回答一个问题：**我要加/改一个功能，应该动哪里，怎样保证不弄坏别的地方。**
> 首次阅读建议先看「模块边界」和「不变式」，再看「改动矩阵」。

文件归属、构建产物、运行数据和清理边界统一见 [`FILE_CONVENTIONS.md`](FILE_CONVENTIONS.md)。

## 1. 模块边界

```
┌──────────────────────────── 进程/语言边界 ─────────────────────────────┐
│                                                                        │
│  quota-policy.ps1        ← 唯一会改动账号状态的进程（PowerShell 5.1）   │
│    ├─ 读状态：$cma status --json / limits --json（codex-multi-auth）    │
│    ├─ 读配置：panel-config.json（原样读，不钳位）                       │
│    ├─ 判断：写 decision-input.json → node panel/policy-cli.js decide    │
│    ├─ 落盘：quota-policy.state.json / quota-policy.log                  │
│    └─ 执行：$cma switch / unpin（只有 SWITCH 且非 -DryRun 才动手）      │
│                                                                        │
│  ensure-router.ps1       ← 保证路由进程存活，只重启、不决策             │
│                                                                        │
│  panel/server.js         ← 只做装配：HTTP 服务 + 分发 + 启动（~80 行）   │
│    ├─ lib/panel-http.js  → 一次性 token / 信封 / 静态文件 / 本机来源    │
│    ├─ lib/routes.js      → /api/* 路由表（state/usage/logs/policy/      │
│    │                        preview/account/router/login）             │
│    ├─ lib/dashboard.js   → 状态快照读模型（60s TTL + 并发 CLI 聚合）    │
│    ├─ lib/router-control.js → 路由进程观察/启停/自愈                    │
│    ├─ lib/login-flow.js  → 「添加账号」窗口生命周期                     │
│    ├─ lib/watchdogs.js   → 登录窗口 15 分钟 / 路由卡死 2 分钟看门狗     │
│    ├─ lib/paths.js       → 唯一路径/端口/代理来源                       │
│    ├─ lib/fs-json.js / cli.js / events.js → 文件、CLI、事件日志小工具    │
│    ├─ lib/policy-store.js / config-schema.js → 配置读写与形状校验       │
│    ├─ lib/usage-logs.js  → /api/usage、/api/logs、告警                  │
│    └─ lib/account-actions.js → /api/account 的 CLI 动作                │
│                                                                        │
│  panel/policy-core.js    ← 纯函数：决策语义的唯一实现，无 IO            │
│  panel/lib/policy-config.js ← 纯函数：配置默认值/钳位的唯一实现         │
│  panel/lib/policy-decision.js ← 把"归一化 + 决策"拼成一条链             │
│  panel/policy-cli.js     ← 这条链的进程边界（JSON in / JSON out）       │
│  panel/public/*.mjs      ← 前端：只依赖 /api/* 与 meta[panel-token]     │
│  panel/app/*.cs          ← 桌面端：WebView 宿主 + 少量原生增强          │
└────────────────────────────────────────────────────────────────────────┘
```

**依赖方向（只允许单向）**

```
public/app.mjs ─┐
app/*.cs ──────┼─► HTTP /api/*  ─► server.js（装配）─► lib/routes.js
               │                                        ├─► lib/dashboard.js ─► lib/{paths,fs-json,cli,policy-store,usage-logs}、lib/usage/*
               │                                        ├─► lib/router-control.js / lib/login-flow.js
               │                                        └─► lib/policy-decision.js ─► policy-core.js
               │
               └──────────── /api/policy/preview ─────────────────────┘

quota-policy.ps1 ─► policy-cli.js ─► policy-decision.js ─► policy-core.js + policy-config.js
                 └► 文件系统（配置、状态、日志）+ CLI
```
规则：**纯函数层不知道进程/IO 存在**。`policy-core.js`、`policy-config.js` 不得 `require` 任何有 IO 的东西；
`policy-cli.js` 是唯一允许读 stdin/文件的地方；`server.js` 不得 `require` 前端；PowerShell 脚本之间不互相调用。
HTTP 层只能单向依赖：`server.js → lib/*`，`lib/routes.js` 可以 require `lib/dashboard.js` 等，反向或同层循环 require 一律禁止。
以上方向由 `scripts/check-imports.js` 机械校验（`npm run imports`）：分层表之外的新模块、下层依赖上层、后端/前端互依、纯模块引入 IO、成环，全部直接失败。

> 执行层补充：决策带 `targetIsReserve: true` 时，PS1 必须先 `account emergency-only <n> off` 才能切进储备号——
> 运行时会把仍带该标记的账号当成"不可路由"，否则切进去也会 503（见 CHANGELOG 事故条）。回切或切换失败时恢复标记。

### 1.1 应用登录（auth.json）与代理账号是两件事

面板的「切换账号」只改代理路由（activeIndex/pin/pause）；Codex 应用界面上的额度和
"额度用完"横幅读的是应用自己的登录态（`~/.codex/auth.json`）。两者不一致时会出现
"代理明明有额度、Codex 却喊额度用完"。

- `panel/lib/app-auth.js`：解 token 身份（只读，不校验签名）、读应用登录、把某个账号写成应用登录（先备份 `auth.json.bak-*` 再原子替换）。
- `panel/lib/proxy-accounts.js`：代理账号库（`openai-codex-accounts.json`）的只读视图 + 与应用登录比对。
- `/api/state` 暴露 `app` 摘要（email / plan / currentEmail / matchesCurrent），**不含任何 token**；`POST /api/app-login` 执行同步。
- Codex 侧栏底部的账号文字：应用不是 ChatGPT 登录时显示 `model_providers.<当前 provider>.name`。`binding-guard.js` 的 `ensureProviderLabel()` 把它同步成当前代理账号（看门狗 + `panel/sync-label.js`，后者由 `quota-policy.ps1` 每轮调用）。

## 2. 不变式（改代码前请确认不破坏）

| # | 不变式 | 破坏后的症状 | 守它的东西 |
| --- | --- | --- | --- |
| 1 | **决策只有一份实现**：规则在 `panel/policy-core.js` 的 `decide()`，PS1 只取数/执行/落盘，不再有内联分支 | 面板显示"该切号"但脚本不动，或反之——线上行为与预期不符，且不报错 | `panel/test/policy-core.test.js`（32 项）+ `panel/test/policy-cli.test.js`（fixture 回归 17 项）+ `panel/test/policy-ps1.test.js`（执行层 13 项）+ `panel/test/policy-runtime.test.js`（运行时信号 4 项） |
| 2 | **配置只有一份归一化**：默认值/钳位在 `panel/lib/policy-config.js`，server 与 PS1 共用 | 面板写入 600、脚本读到别的值，或两边默认值分叉 | `panel/test/policy-cli.test.js` 的 `normalize-config` 用例 + `server.contract.test.js` 的字段断言 |
| 3 | **API 字段名是三端契约**：`{ ok, state|logs|policy|usage|decision, error }`，`panel-config.json` 固定 `autoSwitch / minWaitMin / reserveIndex` | 前端静默显示空数据（JS 读 undefined 不报错）；C# 端 `GetProperty` 抛异常 | `panel/test/server.contract.test.js` + `panel/test/usage.contract.test.js`（真实后端用量契约 11 项）+ `panel/test/app-login.contract.test.js`（`/api/state.app` 与 `/api/app-login` 4 项） |
| 4 | **编码是运行前提**：`.vbs` = UTF-16LE+BOM；含中文的 `.ps1/.cs` = UTF-8+BOM | 脚本"能打开、运行报错"，中文全变问号；这类问题极难从 diff 看出 | `scripts/check-encodings.js` + `scripts/check-vbs.js`（CI 必跑） |
| 5 | **凭据永不入库**：`openai-codex-accounts*.json` / `auth.json` / 日志 | 别人的 refresh token 被公开，属于安全事故 | `.gitignore` + PR 清单 |

## 3. 决策链路（为什么改规则只改一个文件）

```
quota-policy.ps1 取数（status / limits / account policy list）
        │  组装 decision-input.json（纯数据，无逻辑）
        ▼
node panel/policy-cli.js decide --in … --out …
        ▼
panel/lib/policy-decision.js: normalizePolicy(input) → decide(input)
        ▼
panel/policy-core.js: 返回 { action, reason, targetIndex, nextLogAtMs, details }
        ▼
quota-policy.ps1: 按 action 落日志/写状态；只有 SWITCH 且 details.dryRun=false 才执行账号变更
```

同一套 `decide()` 也被 `POST /api/policy/preview` 调用，所以"面板试算的结果"和"脚本真正执行的结果"不可能分叉。
`panel/test/fixtures/policy-decisions.json` 是冻结的行为表：改规则 = 改 `policy-core.js` + 改 fixture 里受影响的期望值，
`npm test` 会立刻告诉你哪些场景变了。**fixture 的输入形状与 PS1 传给 CLI 的 JSON 完全一致**，所以它同时是 CLI 契约。

`plan-pauses` 是同一份核心的另一条出口：策略在决策之后调用它计算「哪些日常号额度已耗尽要暂停、
哪些窗口已重置要恢复」，PS1 只负责执行与落盘（`state.exhaustedPaused`）——"暂停谁"同样只有一个实现。

### pin（固定）与 503

`codex-multi-auth switch` 会把目标账号写进 `pinnedAccountIndex`；被钉住的账号一旦限流，运行时的请求会直接 503
（"Pinned account N is currently unavailable"），与额度数据是否还有余量无关。所以 `quota-policy.ps1` 在
`autoSwitch` 模式里做两件事：每次运行开头解除遗留 pin（日志 `UNPIN ...`）、`Try-Switch` 成功切号后立即 `unpin`；
`autoSwitch=false` 的手动模式不动用户的 pin。面板卡片上的「已固定 / 解除固定」按钮走
`POST /api/account { action: "unpin" }`，与脚本是同一个 CLI 动作。

运行时还会给账号打「网络冷却」标签：上游 60 秒超时 / `fetch failed` 时，账号进入 `cooling-down:*`，这段时间它同样
不可路由，而额度缓存里可能还写着"有额度"。`policy-core` 把 `cooling-down:*` 与 `rate-limited` / `quota-exhausted`
一样当硬阻塞（`isHardRuntimeReason`），策略当轮就换号；`panel/lib/watchdogs.js` 每 60 秒读一次
`runtime-observability.json`，90 秒内看到「池耗尽 / 账号冷却」就立即踢一次 `quota-policy.ps1`（两次间隔 ≥60 秒），
把原来 5 分钟的计划任务空窗压到 1 分钟级。切走时如果原账号额度还健康就**不暂停**它（日志 `KEEP ... 仍有额度`），
留给运行时做即时故障转移。

运行时原因由 `panel/lib/runtime-health.js` 统一分类为 quota、capacity、auth、network、model 或 other。
面板状态和 `/api/diagnostics` 会标出观测是否新鲜；多个账号同时出现同一类新鲜阻塞时显示全局故障，
避免把共享上游/网络问题误判成单账号额度问题。原生面板会对新的全局故障或策略错误显示一次托盘通知，
重复刷新不会反复打扰。

## 4. 改动矩阵：想做什么 → 动哪里

### 策略心跳自动恢复

`panel/lib/watchdogs.js` 每分钟读取 `quota-policy.state.json`。如果策略超过 12 分钟没有更新，
看门狗会按 10 分钟节流重新启动一次策略；策略自身的互斥锁负责避免与计划任务重叠。
这覆盖计划任务停止、单轮异常退出和策略进程卡死等情况，减少人工打开电脑查看的需要。

| 需求 | 必改 | 可能连带改 | 验证方式 |
| --- | --- | --- | --- |
| 改切号规则（阈值、优先级） | `panel/policy-core.js` | `panel/test/fixtures/policy-decisions.json`（受影响的期望）、`panel/test/policy-core.test.js` | `npm test`；必要时 `quota-policy.ps1 -DryRun` 观察日志 |
| 加一个配置项 | `panel/lib/policy-config.js`（默认值/钳位）、`panel/lib/config-schema.js`（示例形状） | `panel/server.js`（读写）、`quota-policy.ps1`（原样读同一份 json）、`*.example.json`、前端策略面板 | `npm test`；契约测试锁字段名 |
| 加一个 API 端点 | `panel/lib/routes.js` 的 `handleApi()` 里加分支 | `panel/test/server.contract.test.js`（路由表/断言；`/api/usage` 的字段口径在 `panel/test/usage.contract.test.js`，`POST /api/refresh` 的“立即返回 + 后台刷新”在 `panel/test/refresh-async.contract.test.js`、`panel/test/router-login.contract.test.js`（`/api/router` 起停进程与 `/api/login` 单飞/cancel））、`Api.cs`（若桌面端要用） | `npm test` |
| 改前端交互 | `panel/public/modules/render-*.mjs`（纯渲染）、`actions.mjs`（动作）、`app.mjs`（装配） | `panel/public/style.css`、`index.html` 的 id、两个服务器的 `STATIC` 表 | `npm run frontend`（id 闸门）；`npm test`（渲染单测 + 静态清单）；`npm run e2e` |
| 改 pin / 自动解除逻辑 | `quota-policy.ps1`（运行开头 + `Try-Switch` 成功后）、`panel/public/modules/render-accounts.mjs` / `actions.mjs`（卡片按钮） | 无（动作已挂在 `/api/account` 的 `unpin` 上） | `panel/test/policy-ps1.test.js`（9 项：储备号 / pin / 运行时信号 / 网络冷却）、`panel/test/frontend-{render,actions}.test.js`、`npm run e2e` 第 9 项 |
| 改运行时故障转移 / 限流兜底 | `panel/policy-core.js`（`isHardRuntimeReason`、`runtimeBlocked` → `unavailable`）、`quota-policy.ps1`（读 `runtime-observability.json`、窗口重置后 `rotation reset-rate-limits`、`pauseFrom`） | `panel/lib/watchdogs.js`（`shouldKickPolicy` 踢策略）、`panel/lib/paths.js`（观测文件路径） | `panel/test/policy-runtime.test.js`、`panel/test/watchdogs.test.js`、`panel/test/policy-ps1.test.js` |
| 改应用登录同步（auth.json） | `panel/lib/app-auth.js`（读/写/备份）、`panel/lib/proxy-accounts.js`（账号库视图）、`panel/lib/routes.js`（`/api/app-login`） | 前端 `render-overview.mjs`（pill）、`render-panels.mjs` + `actions.mjs`（同步按钮） | `panel/test/app-auth.test.js`（6 项）、`panel/test/app-login.contract.test.js`（4 项） |
| 改额度耗尽暂停 / 恢复 | `panel/policy-core.js`（`planExhaustionPauses`）、`panel/policy-cli.js`（`plan-pauses`）、`quota-policy.ps1`（执行 + `state.exhaustedPaused`） | 无（阈值复用 `describeAccount` 的 exh5/exh7） | `panel/test/policy-pauses.test.js`（11 项）、`panel/test/policy-ps1.test.js`（+3） |
| 加桌面端功能 | 按职责选 `panel/app/NativeForm.*.cs`：Layout=搭界面、Render=渲染、Actions=按钮动作、Refresh=刷新流程、Lifecycle=托盘/窗口、Utility=格式化 | `Api.cs`（新接口）、`Infra.cs`（路径/配置） | `dotnet build`（CI 有编译任务） |
| 加启动方式/快捷方式 | `panel/install.ps1` | 对应 `.vbs`（注意 UTF-16LE） | 真机双击 |
| 改用量统计口径 | `panel/lib/usage/`（入口 `panel/usage.js` 只做缓存） | `/api/usage` 的响应字段（前端图表依赖） | 对比 `codex` 自身统计 |

## 5. 扩展要点（照着做就不会踩坑）

### 加一条策略规则（不需要碰 PowerShell）

1. 在 `panel/policy-core.js` 的 `decide()` 分支链里插入你的判断，`details` 里补上 `stoppedBy` 等字段；
2. 在 `panel/test/policy-core.test.js` 补单测；
3. 如果新分支会产生新的终端状态，在 `panel/test/fixtures/policy-decisions.json` 加一个 case，并补一行 `expect`；
4. 如果 PS1 需要"执行"这个新动作（例如新增一种账号变更），才需要在 `quota-policy.ps1` 的 `switch ($action)` 加分支——
   这是**唯一**需要动 PS 的场景，且只加"执行"，不加"判断"。

### 加一个 HTTP 接口

`panel/lib/routes.js` 的 `handleApi()` 是唯一的 API 路由表；`server.js` 只做鉴权前的 Host/Origin/静态/401，然后交给它：

```js
if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
// ↓ 在这里插入新分支，务必保持 { ok, ... } 信封
if (req.method === 'GET' && pathname === '/api/foo') {
  send(res, 200, { ok: true, foo: await getFoo() });
  return true; // true = 已处理；false = 交给 404
}
```

注意三点：① 分支要在 `authed()` 之后；② 失败也返回 `{ ok:false, error }`，不要裸文本；
③ 新端点要写进 `panel/test/server.contract.test.js` 的路由表，否则"删掉了都没人发现"。

### 加一个前端区块

`index.html` 加带 `id` 的容器 → 在 `public/modules/render-*.mjs` 里用同一个 `id` 渲染 → 样式进 `style.css`。
前端模块用 `$('id')` / 注入的 `query('id')` 取值，**改名会静默得到 null**；`npm run frontend` 会扫描全部模块（两种写法都认），漏改直接红。

要加可测试的业务动作：把依赖写进 `initActions()` 的注入表（`api` / `toast` / `confirmModal` / `refresh` / `schedule` …），再到 `panel/test/frontend-actions.test.js` 用假实现覆盖成功、取消、失败、忙碌四条路径——不需要浏览器。

## 6. 已知技术债（按"咬人概率"排序）

| 严重度 | 债务 | 现在为什么能忍 | 建议的解法 |
| --- | --- | --- | --- |
| **已解决** | `panel/lib/` 生产模块之间的依赖方向靠约定（没有静态检查） | 已加 `scripts/check-imports.js`：分层表 + 单向校验 + 环检测，新模块不登记就红 | — |
| **低** | 桌面端仍是手绘 WinForms，与网页版是两套 UI 实现 | 已按职责拆成 7 个 partial 文件（最大 429 行），改动面小；核心功能在网页版 | 长期可改用 WebView 承载，与网页版共用前端 |
| **低** | 前端动态注入的节点无法静态验证"注入顺序"（闸门只验证 id 集合存在） | 动态片段集中在弹窗/策略面板少数几个函数里，e2e mock 兜底 | 需要时给每个注入点加注释，并在 e2e 里断言元素可见 |
| **已解决** | 死代码 `MainForm.webview.legacy` 与从未读取的 `_loading` 字段已删除 | 历史留在 git；桌面端只剩一个窗口实现，CS0414 警告消失 | — |
| **已解决** | 配置 json 形状收进 `panel/lib/config-schema.js`：示例由 `npm run config` 校验；保存策略时保留 UI 不认识的字段 | 新增配置项只需改 schema + 示例 | 若将来需要运行时严格校验，再在读盘处接 `validateConfig` |
| **已解决** | `NativeForm` 双 BOM + 混行尾 | 拆分时统一为单个 BOM + LF，编码闸门覆盖 | — |

## 7. 验收命令（提交前跑一遍）

```powershell
npm run verify                                   # 语法 + 编码 + 启动器语法 + 前端 id + 配置示例 + 依赖方向 + 当前测试集
node panel/tests/e2e-mock.js                     # 可选：前端交互回归（14 项）
dotnet build panel/app/CodexQuota.csproj -c Release
```

CI（`.github/workflows/ci.yml`）在每次 push / PR 上跑同样内容，并在 Windows 上编译桌面端。
**CI 红 = 不许合并**，这是保证"别人改一下不会崩"的机械手段。

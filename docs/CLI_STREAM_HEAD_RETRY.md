# 流内 SSE 过载重试补丁（scripts/patch-cli-head-retry.js）

## 问题

Codex 客户端会反复弹出：

    Selected model is at capacity. Please try a different model.

但账号额度正常、router 也健康，`scripts/model-probe.js` 对同一模型重复探测约有 20% 失败。

## 根因

上游模型过载时返回的不是 429/503，而是 **HTTP 200 + SSE 事件**：

    data: {"type":"error","error":{"message":"Our servers are currently overloaded. Please try again later.","type":"service_unavailable_error","code":"server_is_overloaded","headers":{"retry-after":"6"}}}

CLI 现有的 `withStreamingFailover()` 只在读流**抛错**时换账号，而且一旦向客户端发出过字节就不再重试。`response.created` 等事件先到，随后才是 `error`，于是：

1. 错误以普通 SSE 字节转给客户端；
2. failover 不触发（读取本身没失败、且已发出字节）；
3. 客户端把 `server_is_overloaded` 映射成 “Selected model is at capacity”，用户只能手动重试。

## 补丁（v2 闸门 + v4 钩子，2026-10-28/29）

`scripts/patch-cli-head-retry.js` 给已安装的 `codex-multi-auth` CLI 做四件事：

1. 安装 `dist/lib/request/sse-head-retry.js`（`inspectResponseHead()`），两层：
   - **流头闸门**：写客户端字节前，按完整 SSE 事件（空行分隔）解析上游流，只扣留不含可见内容的事件（`response.created / in_progress / queued / metadata` 与结构性的 `output_item.added / content_part.added / reasoning_summary_part.added`）；扣留期间出现容量类 `error` / `response.failed`（`server_is_overloaded`、`slow_down`、`capacity_exceeded`… 嵌套或顶层形状都认）就返回 `retryable:true`；见到第一个内容事件（delta、`*.done`、`response.completed` 等）就放行，已读字节与同批后续事件原样重放。空闲超时（默认 30s）或总扣留时间（默认 60s）到了也放行，**从不截断**。按字节识别 SSE（上游 200 响应常常没有 `content-type`）。
   - **尾部守卫**：放行之后再出现的容量错误不转给客户端，而是让流以错误结束。Codex 对“流断开”会自动重试这一轮，而对转发过来的容量错误不重试、直接结束这一轮。
2. 在 `dist/lib/runtime-rotation-proxy.js` 的 responses 流式分支、`writeHead` 之前插入带版本标记的钩子（`// >>> codex-multi-auth-panel stream-head-retry vN`）。`retryable` 时：清掉成功分支刚记下的会话亲和；先把其它账号各试一次（不占瞬时重试预算）；都试过后交给 CLI 自带的 `waitOutModelCapacity`（退还 token、按 retry-after 或退避表等待再重发）；预算用完才计入瞬时预算并最终 503。中途容量错误记录在 `lastError=model-capacity-midstream:<reason>` 与 `lastMidstreamCapacity.after`（之前转发的事件类型）。
3. 对拿不到 HTTP 响应的传输错误做安全分类：超时、连接被拒绝、连接重置、DNS/网络不可达和未知 `fetch failed` 会分别记录为 `upstream-transport:<kind>`。不会记录 URL、令牌、邮箱或请求正文。
4. （钩子 v4，2026-10-29）安装 `dist/lib/request/live-quota.js`：钩子把每个真实 responses 请求响应头里的额度（`x-codex-primary-*`/`x-codex-secondary-*`）按 workspace accountId 写进 `<multi-auth>/live-quota.json`，形状与 `quota-cache.json` 的条目相同。合并写、原子替换，写失败不影响请求。面板取它和探测快照里更新的那份，路由在用的账号几秒内就能看到额度变化，不需要额外的 “quota ping” 探测（每次 `limits --refresh` 都会给每个账号发一条真实请求）。设置 `CODEX_MULTI_AUTH_LIVE_QUOTA=0` 可关闭。

### v1 的问题（为什么装了补丁还会报容量错误）

- 按网络分块逐行扫描：首块恰好断在行尾、没有完整 `data:` 行时（`: keepalive`、单独的 `event:` 行）被误判为“不是 SSE”，整条流不检查就转发。
- 空闲超时会关掉重放流（截断响应）；零字节超时时返回已上锁的原始流。
- 只认嵌套形状和两个错误码。
- 每次容量命中都占一次瞬时预算，3 个账号 3 次就 503；不清会话亲和。

## 使用

    node scripts/patch-cli-head-retry.js          # 安装/升级补丁（幂等）
    node scripts/patch-cli-head-retry.js --check  # 查看是否已安装
    node scripts/patch-cli-head-retry.js --revert # 还原（用最近的 .bak-headretry-* 备份）

npm 升级 `codex-multi-auth` 会覆盖 `dist/`，升级后重新执行一次即可。
**补丁只在路由进程重启后生效**（输出里 `restartRouter: true` 时）：面板「重启路由」，或
`panel/lib/router-control.js` 的 `stopRouter()` + `startRouter()`。`--check` 在未完整安装时退出码为 2。
临时关闭：设置环境变量 `CODEX_MULTI_AUTH_STREAM_HEAD_RETRY=0` 后重启 router。

## 验证

    node scripts/model-probe.js --model gpt-6.1-sol --repeat 10 --timeout 90000

补丁前同一模型 10 次里约 2 次 `server_is_overloaded`；补丁后 10/10 成功，router 状态里能看到
`lastError=model-capacity:server_is_overloaded` 的重试记录。

## 注意

- 补丁只作用于本机 npm 全局安装目录，不进入 git；仓库里保存的是脚本与负载（`scripts/cli-patch/sse-head-retry.js`）。
- 上游过载本身不会被消除，只是被透明地换账号重试掉；如果所有账号都过载，仍会看到错误。
- 如果所有账号都在建立上游连接前失败，客户端以前可能把最终 503 显示成容量不足；现在路由状态会显示为“上游连接失败”，并保留具体分类。
- 补丁有 `.bak-headretry-<时间戳>` 备份，`--revert` 可回到官方 dist。

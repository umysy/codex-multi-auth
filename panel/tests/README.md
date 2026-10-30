# tests/ — mock 后端 + 无人值守 E2E

用**假的**后端把额度面板跑起来，再用 Edge headless 真的点一遍。全程隔离：

- 不读不写 `~/.codex` 里的真实账号 / router / policy；
- 不碰生产面板 `8766`、也不碰 `panel/__e2e.js` 用的调试口 `9223`；
- 不写注册表、不建计划任务，不修改 `panel/public/`、`panel/server.js`。

## 跑起来

```powershell
node panel/tests/e2e-mock.js            # 预期输出 PASS 14/14
node panel/tests/e2e-mock.js --verbose  # 多打一点细节
```

前置条件：

- Node ≥ 18（用到内置 `fetch` / `WebSocket`）；
- Edge 在 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；
- 端口 `8799`（mock）和 `9224`（CDP）空闲。

一次约 5 秒。脚本自己 spawn mock、自己拉起 Edge，结束时 `Browser.close` + 杀掉 Edge 与 mock 子进程 + 删临时 profile，不留残留。

**退出码**：`0` 全过；`1` 有断言失败（并截图 `tests\e2e-fail.png`）；`2` 环境问题（如端口被占用）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `fixtures.js` | 内存 fixture：3 个账号（daily.1 / daily.2 / reserve）、totals、policy、router、8 条日志，`now` 每次现算 |
| `mock-server.js` | 零依赖 `http` mock，复刻 `server.js` 的路由表、`<meta name="panel-token">` 注入与 `x-panel-token` 校验，状态可变 |
| `e2e-mock.js` | 驱动 Edge + CDP，用 `Input.dispatchMouseEvent` 真实点击，跑 14 条断言 |

## 只想看页面（手动点）

```powershell
node panel/tests/mock-server.js --port 8799
```

启动后打印四行：

```
MOCK LISTENING 8799
MOCK URL http://127.0.0.1:8799/
MOCK TOKEN 3f9c…（每次启动随机）
MOCK PUBLIC …\panel\public
```

打开 `MOCK URL` 即可（`index.html` 里已经内联了同一个 token，页面自己会带上）。要手搓 `curl` 打 API，就把 `MOCK TOKEN` 那个值放进 `x-panel-token` 头。`--fixture <path>` 可读一个 JSON 浅合并进内置数据（数组整体替换；读不到会打 `MOCK FIXTURE WARN` 并回退内置数据）。

## 覆盖的 14 条

1. 标题含 `Codex Quota`
2. 恰好 3 张账号卡，邮箱都是 example.com 占位地址
3. 4 个 KPI 都不为 `—`
4. 点「刷新额度」→ `totals.weekRemaining` +1（KPI 跟着变）
5. 第 3 张卡「暂停」→ 确认弹窗 → 卡片显示「已暂停」+ mock `paused=true`
6. 「恢复使用」→ mock `paused=false`
7. 「备注」→ 输入中文「测试备注」→ 保存 → 卡片与 mock 都显示
8. 「切到此号」→ 风险确认 → 「使用中」移到该卡
9. 再切到账号 2 + unpin 路径（mock `selection.pinned` 清空）
10. 策略页阈值 65 分钟 → 保存 → mock `policy.minWaitMin=65`
11. 策略页「自动切号」off → on → 保存 → mock `policy.autoSwitch=true`
12. 路由页「重启路由」→ toast 含「路由已重启 · PID 9999」
13. 事件时间线 ≥ 5 条
14. 无未捕获 JS 异常、无 4xx/5xx 请求（同时收集 `Log.entryAdded` 与 console error）

不计入断言、但每次顺带自检的 mock 契约：无 token / 错 token 访问 `/api/state` 必须 401，`POST /api/refresh` 必须 +1，`POST /api/login` 必须回 mock 文案。

## 注意与已知限制

- **刷新语义**：生产前端点「刷新额度」只发 `GET /api/state?force=1`，从不 `POST /api/refresh`，所以 mock 把 force 读取也当成一次刷新（+1），`POST /api/refresh` 同样 +1。这是为了对齐前端真实行为，不是 mock 的 bug。
- **选择器以 `public/` 实际 DOM 为准**：卡片是 `.account`（不是 `.acc`），时间线行是 `.tl-row`（不是 `.ev`）。
- e2e 开始时先用真实点击关掉「自动刷新」，否则 15 秒一次的轮询会在「拖滑块 → 点保存」之间重渲染策略区，造成时序偶发失败。刷新按钮本身仍用真实点击验证（第 4 条）。
- 只支持 Windows + Edge（`Input.dispatchMouseEvent` 走 CDP）。不验证真实 OAuth 登录（`/api/login` 只返回 mock 文案），也不校验真实账号文件的写入。
- 唯一副作用：`os.tmpdir()` 下的临时 Edge profile（跑完删除），以及**失败时**的 `tests/e2e-fail.png`（成功不产生）。

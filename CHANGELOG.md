# 更新日志

本项目从作者本机工程整理而来，版本号从 2.0.0 起（与桌面端程序集版本对齐）。

## [未发布]

### 发布（公开仓库改为独立快照 `umysy/codex-multi-auth`）

- 原仓库改为私有，继续作为开发仓库。公开版放在新仓库 `umysy/codex-multi-auth`，从一个干净的初始提交开始，不带任何旧历史。
- 新增 `scripts/sync-public.js`：
  - 把私有仓库 HEAD 同步到公开仓库的工作区，跳过 `.audit/`，删掉已不存在的文件；用 `git cat-file` 逐个写文件，中文文件名不会被 tar 解码错乱；
  - 写完后拿本机真实敏感值逐个比对：路由新旧 key，包括 `versions/` 备份里的历史 key；还有 identity token，以及各账号的 token、id、邮箱和 Codex 登录 token。命中就以退出码 2 失败；
  - 私有仓库有未提交改动、或公开仓库把私有仓库加成 remote 时，拒绝执行。
- 测试 `sync-public.test.js` 4 条，全部用临时仓库和临时 `CODEX_HOME`。
- README、CONTRIBUTING、发布清单里的仓库地址改成新仓库。README 注明本仓库是面板，同名 npm 包 `codex-multi-auth` 是它依赖的 CLI。发布清单写明每次发布的步骤。

### 安全（公开发布扫描漏掉了转义过的 Windows 路径）

- 准备 squash 合并到 main 前，对合并后的全部内容做了一次扫描：没有新旧路由 key、账号 token、账号 id、真实邮箱。
- 但发现 3 个测试夹具里写着本机真实的 Windows 用户目录和项目目录。原因是旧规则只认单反斜杠，JS 字符串里转义过的 `C:\\Users\\<name>` 没被抓到。
- 修复：
  - 规则改成认一到两个反斜杠，占位名（`<…>`、`%…%`、`me`、`example`）不算；
  - 夹具改用占位路径；
  - 已验证新规则能抓到旧夹具。

### 安全（面板只能调用白名单里的 CLI 子命令）

- 排查范围：桌面端所有菜单和按钮、网页面板所有按钮、计划任务、部署目录里的脚本。
- 桌面端和网页面板都不直接起 CLI，统一走面板接口；面板里调用 CLI 的地方实际只用到这几个子命令：`status`、`limits`、`account …`、`switch`、`login --preserve-selection`。
- CLI 里会改写 Codex 配置或路由启动项的不止 `bind-app` / `unbind-app`，还有 `rotation enable`、`rotation disable`、`rotation reset-runtime`（先解绑再按 `nativeOpenai` 重新绑定）、`uninstall`，以及首次运行时的自动绑定。
  - 首次运行的自动绑定：本机已有完成标记，不会再触发。
  - 计划任务里的策略脚本会调用 `rotation reset-rate-limits`：只清账号冷却时间，不碰绑定。
- `panel/lib/cli.js` 新增白名单：子命令不在 `status / limits / account / switch / login` 里就直接拒绝（`CLI_FORBIDDEN`），不启动进程。
- 新测试 `cli-allowlist.test.js`：
  - 上面那些危险子命令全部被拒，且不起进程；
  - 绕开 `runCli` 直接起 CLI 的文件必须在已审核清单里（登录 launcher、用量的 `status --json` 等），也不能出现危险子命令。
- 公开发布扫描抓到新测试里的占位邮箱 `example.invalid`，已改成 `example.com`。

### 修复（「重新绑定桌面版」不再调用 bind-app --native）

- 调用链：
  - 桌面端按钮 / 菜单「路由 → 重新绑定桌面版」/ 网页面板「重新绑定」
  - → `POST /api/router {action:"rebind"}`
  - → 原来是 `runCli(['rotation','bind-app','--native'])`。
- 为什么会破坏当前配置（读 CLI `dist/lib/runtime/app-bind.js` 确认）：
  - 把 Codex config 里的 `[model_providers.codex-multi-auth-runtime-proxy]` 整段删掉，顶层改成 `model_provider = "openai"` 的原生模式块；
  - 顶层的 `model_provider` 等几行还会从 10-25 的旧备份里取值；
  - 用 CLI 自带模板重写启动项 cmd，丢掉代理和两个超时环境变量，路由下次重启就连不上上游；
  - 需要时自己停/起路由，不走 keeper；10-29 那次还中途崩溃，留下半改状态。
  - 另外，app-bind 状态里早就写着 `nativeOpenai: true`，和实际在用的自定义 provider 不一致，所以 CLI 每次都会按原生模式改。
- 新做法（`panel/lib/safe-rebind.js`）：
  - 以 app-bind 状态为准，只改四行的值：顶层 `model_provider`、`openai_base_url`，provider 段的 `base_url` 和 `experimental_bearer_token`。
  - 先备份，再原子写入，写完读回复查；已经一致时不写。
  - 不碰 app-bind、启动项、路由进程、账号、策略、额度，也不生成新密钥。
  - 以下情况一律拒绝并给出中文说明，不插入、不猜：provider 段不存在、有 CLI 原生模式块、缺行、重复段、路由没在监听。
- 确认框和路由页说明改成上面的实际行为。
- 回归测试：
  - `safe-rebind.test.js` 14 条，覆盖：只改四行；其它段的同名键、显示名、CRLF 都不变；各种拒绝情况；消息不含密钥；落盘时 app-bind、启动项、账号、策略文件的哈希不变；
  - 结构性检查：面板代码里出现 `'bind-app'` / `'unbind-app'` 字面量就失败（已验证能抓到旧的 routes.js）；
  - 契约测试换成真实 `POST /api/router rebind`：沙箱 config、假 CLI 记录调用参数、假路由监听端口。
- 测试全部在临时目录里跑，没有动真实 Codex 配置和运行中的路由。部署前后对比：真实 `config.toml`、app-bind、启动项的哈希都没变。

### 安全（10-30 已更换本机路由 key）

- 泄露的旧 key 已作废：只改了两处——路由绑定文件里的 `clientApiKey` 字段和 Codex `config.toml` 里的 `experimental_bearer_token` 那一行；端口、身份令牌、账号、策略、额度数据都没动。新 key 由系统安全随机数生成（32 字节）。
- 没有用上面建议的 `bind-app --native` / `unbind-app`：10-29 试过一次，`bind-app --native` 会把 Codex 配置改成原生模式，还中途崩溃，当时已从备份恢复。改为先写绑定状态、再写 Codex 配置。面板的绑定守护只按状态同步配置，所以不会把旧值写回来。
- 换之前先完全退出 Codex，再通过 keeper 计划任务重启路由。用不耗额度的 `/models` 接口验证：新 key 200，旧 key 401，不带 key 401；20 秒后复查结果相同。
- 重开 Codex 后：真实请求全部经过路由，没有 401；账号 2、3 都有在用（账号 1 按策略留作应急）；`live-quota.json` 在更新；面板和 keeper 正常。期间有 2 次 `und_err_socket` 上游网络错误，和换 key 无关（10-29 一天有 158 次）。
- 扫描本机约 6.3 万个文件：新 key 只在路由绑定文件和 Codex `config.toml` 两处，不在仓库、日志或测试里。旧 key 还留在本机备份和旧会话记录里，已经失效。
- 注意：面板上的「重新绑定桌面版」按钮会调用 `bind-app --native`，现在还没改，别点。

### 安全（推送前检查）

- 当时的开发仓库是公开的。推送前把要推的 33 个提交（代码、文档、提交说明）和整个当前文件树都扫了一遍：邮箱、账号 id、令牌、长随机串、用户路径。
- 发现 `panel/test/binding-guard.test.js` 的测试夹具里写着**本机路由真实的 clientApiKey**（与 `app-bind/runtime-rotation-app-bind.json` 一致）。它在 10-27 的提交 `fa9e596` 里就已经推到了公开分支 `codex/rotation-reliability`。这个 key 只保护监听 127.0.0.1 的本机路由，外网访问不到；但本机任何程序拿到它都能借路由用这些账号。
- 处理：
  - 测试夹具改成明显的假值；
  - `scripts/check-publication.js` 新增规则：40 位以上的随机十六进制串（排除 `sha256:` 账号指纹和全相同字符的占位值）算疑似密钥。已验证新规则能抓到原来那个文件。
- 历史提交里的 key 已经公开，改写公开历史代价大，建议换一个新 key：先 `codex-multi-auth rotation unbind-app`，再 `codex-multi-auth rotation bind-app --native`，然后重启路由和 Codex。需要用户同意后再做。
- 其它扫描结果：没有邮箱、令牌、用户路径；`app.manifest` 里的 GUID 是 Windows 标准的 supportedOS 标识，测试里的 `127.0.0.1:7897` 是通用代理端口示例。`origin/main` 的历史里还有一个真实的 ChatGPT 账号 id（旧用量测试），它是标识不是凭据；这个分支已经删掉了。
- README：桌面端账户规则入口、用量统计的数据来源改为当前实现；快速开始里补充了可选的 CLI 补丁步骤。
- 与 `.tmp/public-release`（另一个代理 10-27 做的公开版快照，从未推送）对比：当前分支包含它的全部文件（只少了已删除的 `RotationEditorDialog.cs`），且多出 21 个新文件，本身就是完整、可公开的项目。

### 修复（用量页单个账号的「角色分布」「会话排行」是空的）

- 用户 10-29 截图：按单个账号看时，「角色分布」下面只有一行“看全部账号”，其余全空。原因是路由账本没有会话标题，上一版只能把这两块留空。
- 做法：把每条账本请求按“输入 / 缓存输入”token 数配对回会话记录里的 token_count 事件（取时间最近、还没被占用的一条，最多差 30 分钟）。输出 token 不参与配对：被取消的请求两边记的输出不一样。实测配对率：
  - 按请求：88%；按 token：97.7%；
  - 时间差中位数：0.6 秒；
  - 各账号按 token：账号 1 为 97.1%，账号 2 为 97.9%，账号 3 为 97.7%。
  配对上的请求带上会话的角色、项目和会话 id。没配上的按模型推角色（codex-auto-review 算“自动 review”，其余算“未配对到会话”），不进会话排行。
- 修改：`ledger.js` 新增 `tokenKey` / `matchSession`；`collect.js` 在扫描会话时建索引，账本请求按时间顺序配对；账号视图新增 `matchedShare`。桌面端单个账号也显示「会话排行」和「角色分布」，底部写明配对率。另外：
  - 页面滚动容器加了底部余量，最后一行说明不会贴着底边；
  - 「本周额度窗口」下面的小字缩短，不再挤成一行。
- 测试：新增 `matchSession` 单测（同 token 取最近、已占用不重复配、超时不配、token 不同不配）；集成测试改为断言单个账号也有角色与会话排行、配对率 100%。
- 部署：备份在 `versions\deploy-20261029T223630-usage-match\`（`panel\lib\usage`、`CodexQuota.exe`）。

### 修复（页面滚动）

- 用户 10-29 反馈：滚动逻辑有问题，尤其是鼠标停在页面里的列表上时。滚动页面（用量、账号详情、路由、策略）原来只是普通的 AutoScroll 面板，有三个 WinForms 默认行为：
  1. 指针停在列表上，列表有自己的滚动条时滚的是列表；列表没有滚动条或已经滚到头时，滚轮直接没反应，页面不动；
  2. 指针停在下拉框、数字框上时，滚轮改的是它的值。在策略页滚动会悄悄改掉阈值和储备号，在用量页会切换账号范围；
  3. 点一下列表或下拉框，页面会跳一下，把整个控件滚进视野。
- 修改：
  - 新增 `PageScroller`（替换 `ScrollPage` 和策略页里的滚动面板）：
    - 滚轮经过下拉框（未展开时）、数字框，或者经过已经滚到头 / 没有滚动条的列表、表格时，改为滚动整页；
    - 获得焦点的控件不再把页面滚过去。
  - 用量页的三个列表按行数撑开（行高跟着字体和 DPI 走），不再有内部滚动条，指针停在哪里滚的都是整页。
- 测试：`desktop-rules` 新增：
  - 滚轮不改下拉框和数字框的值；
  - 没有滚动条的列表把滚轮交给页面；长列表先滚自己，滚到顶后交给页面；
  - 聚焦控件不跳页；
  - 用量页三个列表都没有内部滚动条。
- 部署：旧 exe 备份在 `versions\deploy-20261029T222504-scroll\desktop\`。

### 重做（桌面端「用量」页的布局）

- 用户 10-29 反馈：用量页下半部分太窄。原因是整页挤在一屏里，三个表格并排，各只有三分之一宽，会话标题、项目名、模型名和 token 数都被截成“gpt-6.1-...”“13.07...”。
- 修改：`UsageView` 改为可竖向滚动的单列页面（基于 `ScrollPage`），每块占满宽度：
  - 账号范围（说明在下方换行显示）；
  - 四个数字；
  - 每日 / 今日分布图；
  - 每个账号一行的周窗口小结（自动换行，不再写死行高）；
  - 会话排行（整宽，列为日期 / 项目 / 会话 / token，悬停看完整标题）；
  - 角色分布与模型 / 项目（并排各占一半）；
  - 数据来源说明。

  页面只按 96 DPI 写尺寸，由主窗口统一缩放，去掉了构造时传入、实际总是 1 的缩放系数。新增 `ShowData()`，桌面规则测试可以用示例数据截图检查布局。
- 部署：旧 exe 备份在 `versions\deploy-20261029T221334-usage-ui\desktop\`。

### 修复（「用量」页的统计口径）

- 用户 10-29 反馈：用量页的统计“不符合直觉”。用会话文件和路由账本各自重新数了一遍，发现这些问题：
  1. **按账号拆分是错的**：会话文件没有账号信息，以前按“周窗口重置时刻”去猜，对不上的整个文件按多数票归到一个号。跨好几个账号的长会话（Trading 那个 7 天会话 13 亿 token）被整体算到账号 3。界面显示账号 3 为 14.8 亿、账号 2 为 2.45 亿、“未归属”5.03 亿；路由账本（每个请求实际用的账号）里是账号 3 约 8.3 亿、账号 2 约 8.1 亿、账号 1 约 1.9 亿。
  2. **“窗口内消耗”其实是近 7 天合计**，跟额度窗口无关。
  3. **“每 1% 周额度约 N token”没有参考价值**：它把缓存输入也算进去，同一账号不同窗口能差好几倍。按 5 小时窗口拟合“已用百分比 ~ 各类 token”，离散系数 0.93，R² 小于 0。
  4. **总 token 里约 97% 是缓存输入**（例：10-29 共 1.87 亿 token，新输入加输出只有约 900 万）。缓存输入占的额度远少于新输入和输出，只看总数会觉得“烧了这么多，额度怎么没怎么动”。
  5. Codex 只更新额度时会把同一条 token_count 再写一遍（每天约 40 条），这些都被重复计数（约 3%）。
  6. 默认显示的是策略首选账号，不是路由在用的账号；柱状图标题写“近 8 天”，实际画的是 7 天。
  另外核对过：会话文件逐日合计与路由账本相差约 3%，“全部账号”的总量本身是对的。
- 修改：
  - 新增 `panel/lib/usage/ledger.js`：读路由账本（含轮转出去的旧文件），只取路由请求，带账号序号、模型、项目和 token。
  - `collect.js`：“全部账号”来自会话文件（总量、按天、按小时、角色、模型、项目、会话排行）；单个账号来自账本（总量、按天、按小时、模型、项目），并给出当前周窗口小结：起止、已用百分比（快照与实时额度取新的）、窗口开始以来这个号消耗的 token。默认账号改为路由在用的账号。
  - `sessions.js`：不再猜账号；跳过只有额度的事件和累计用量没变的重复事件。`accounts.js` 简化为序号 / 邮箱 / 额度快照 / 首选与在用账号。删除窗口归属投票、`windowsOf`、`mergeQuota` 和“每 1% 周额度”。
  - 桌面端用量页：四个数字改为「今日 token」「近 N 天 token」「缓存命中率」「本周额度窗口」，每个数字下面拆出“新输入 / 输出”。单个账号显示“已用 43%”加本窗口 token，全部账号显示各号已用百分比。图下每个账号一行周窗口小结。单个账号不拆角色和会话（账本没有会话标题，一个会话也会跨账号），给出提示。模型 / 项目用分组代替前缀。底部写明数据来源。图表标题按实际天数显示，悬停提示带新输入 / 输出。
- 测试：重写 `usage-units.test.js`，覆盖状态解析、账本解析与轮转文件、重复事件跳过、周窗口小结，以及集成测试：同一会话跨两个账号时按请求拆开、窗口 token 包含统计范围之前的请求、实时额度优先、默认取在用账号。`usage.contract.test.js` 改为“读不到账号清单时不编造账号”，并断言已没有“每 1% 周额度”。
- 现场核对：账号 1 / 2 / 3 近 7 天分别为 1.87 亿 / 8.12 亿 / 8.34 亿，与账本逐日合计一致；账号 3 本窗口已用 43%，与账号列表“7 天剩 57%”一致。
- 部署：备份在 `versions\deploy-20261029T214032-usage\`（`panel\lib\usage`、`CodexQuota.exe`）。

### 重做（桌面端「账号详情」「路由」页；修「事件」页、标题栏、状态栏与「策略」页的问题）

- 用户 10-29 要求把其它不好的页面也重做。逐页在真实窗口里截图检查后，发现这些问题：
  - **账号详情**：“状态说明”直接显示 CLI 的英文原因（“secondary quota 33% used”），而且是旧快照，和下面“7 天 60% 剩余”的额度条对不上；看不出账号是否正在被路由使用、额度是实时的还是几小时前的；按钮固定宽度，「刷新额度」被窗口裁掉。
  - **路由**：说明里写死了旧端口 56014（实际是 53742），还有一条过时的策略说明；「重新绑定桌面版」按钮文字被截断；最近错误只有一行，长了看不全。
  - **事件**：每行内容重复了类型（“RESUME RESUME …”），末尾带 `run=` 编号；ROUTER、SWITCH 都加粗，重要的反而不突出。
  - **标题栏、工具栏、状态栏**：“当前”显示的是策略首选（账号 2），实际在扣额度的是账号 3；“本周剩余 238%”其实是 3 个号的和，没有说明；“预算 1.5%/天”的单位其实是每小时；状态栏太长，和右侧的路由信息叠在一起。
  - **策略**：什么都没改就显示“有未保存的修改”（控件第一次显示时补发的选择事件被当成了修改）；“策略暂停了账号 1、2”来自过期的记账，两个号其实都没暂停；储备号的说明被裁掉。
  - **用量**页能用，只是部分表格列被截断，这次没动。
- 修改：
  - 新增 `AccountDetailView`：标题；一行状态（使用中 / 首选 / 储备号 / 已暂停 / 可用）；翻译过的运行时原因（CLI 的“quota N% used”和储备号的“emergency backup reserved”与其它信息重复，不显示）；扁平额度条按剩余着色（≥30% 绿、10–30% 橙、<10% 红，已重置的窗口为灰色并说明）；额度来源（实时请求还是几小时前的快照）；账号信息；按钮会换行。
  - 新增 `RouterView`：状态、地址（端口取自状态）、正在使用的账号、请求统计；最近错误会换行，已恢复的显示为灰色；按钮宽度自适应；说明改为当前的行为。
  - 新增 `UiKit`（标题、字段表、按钮、时间文案、原因翻译、日志清理、`QuotaBar`）和 `ScrollPage`（内容宽度钉在可见宽度，标签按宽度换行）。
  - 事件：去掉重复的类型前缀和 `run=` 编号；只有 SWITCH、ERROR、DEAD 加粗；整行内容作为提示。
  - 标题栏、托盘、工具栏显示“使用中”的账号；首选不同时，工具栏补“（首选：…）”。状态栏改为“7 天额度合计剩余 N%（3 个号）· 按当前速度某天用完”，消耗与预算（%/小时）放进提示。
  - 策略：是否“有未保存的修改”改为与载入时的值比较（改了再改回不算）；运行状态只列真的处于暂停的账号；储备号下拉框变窄，说明改短。
- 测试：`desktop-rules` 新增显示页面不算修改、改回不算修改、账号详情（使用中 / 首选 / 原因翻译 / 已重置窗口 / 额度来源 / 按钮状态）、路由端口取自状态、事件文案清理；截图另存账号详情与路由页。
- 部署：旧 exe 备份在 `versions\deploy-20261029T211636-tabs\desktop\`；部署后在真实窗口里逐页截图核对。

### 重做（桌面端「策略」页）

- 用户 10-29 要求修复并重做「策略」页。原来的问题：
  1. **改动会丢**：自定义规则要先点「应用到草稿」再点「保存策略」。只点保存时，表格和阈值的改动被静默丢掉。
  2. **规则对话框不能用**：账号详情的「编辑角色规则…」打开的对话框没有确定/取消按钮（按钮被挪到了策略页底部），什么也应用不了。`desktop-rules` 测试一直报 `Sequence contains no elements` 就是因为这个。
  3. **175% 缩放下文字被裁**：编辑器在每次刷新时重建，重建出来的控件没经过窗口的 DPI 缩放，固定的行高（42/190/84/480 像素）装不下放大后的字。
  4. 底部六个按钮（保存策略、放弃草稿、上移、下移、应用到草稿、取消）里有两对意思重复；基础规则和自定义规则同时显示，靠“仅作参考”的说明区分。
- 新页面（`panel/app/PolicyView.cs`）：
  - 「运行状态」（上次运行、结果、出错原因、累计次数）和「自动切号」开关；
  - 「切换规则」用单选在「基础规则 / 自定义账户规则」之间切换，只显示当前模式的设置；
  - 底部只有「保存策略」「放弃修改」，以及“有未保存的修改”提示。保存一次读完整页，没有中间的“应用”步骤；有未保存修改时，定时刷新不会覆盖它。
- 自定义规则编辑器（`RotationEditorControl`）只构建一次，用 `LoadConfig()` 换数据、`Build()` 读回；表格按行数撑开、不出内部滚动条；上移/下移放在表格旁边；说明紧跟输入框；选中行用浅色。
- 删除 `RotationEditorDialog`。自定义规则下「编辑角色规则…」直接跳到「策略」页。
- 测试：重写 `panel/test/desktop-rules`，覆盖编辑器的顺序、剩余/已用换算、边界和非法输入，基础规则迁移，策略页一次保存就带上表格改动（旧行为的回归），定时刷新不覆盖未保存修改，切回基础规则。传目录参数时，另外存 175% 缩放下两种模式的截图供人工检查。
- 部署：旧 exe 备份在 `versions\deploy-20261029T204847-policyview\desktop\`。10-29 用户确认新「策略」页可以。

### 变更（额度只在点「刷新额度」时探测）

- 用户 10-29 要求：每次探测都花约 5k token，只在用户按「刷新额度」时才刷新。
- 以前自动探测的有两处：
  - 策略计划任务每 5 分钟 `limits --json --refresh`，每次给 3 个账号各发一条真实请求；
  - 桌面端每次启动都在后台深度刷新一次。
  其它地方（网页面板、路由本身）都不会自动探测。实测路由的探测计数在两次策略运行之间不变。
- 修改：
  - `quota-policy.ps1` 改成 `limits --json`，只读缓存。路由在用的账号用 `live-quota.json` 覆盖，比缓存新才覆盖，窗口字段按缺失沿用缓存。没在用的账号额度只会在窗口重置时恢复，重置时刻本来就在快照里。
  - 桌面端去掉启动时的深度刷新，删掉不再使用的 `ApiClient.RefreshQuotaAsync`。
  - 快照超过 30 分钟时的提示改成说明原因：没在用的账号不自动探测，要看最新数字就点「刷新额度」。
- 测试：
  - 假 CLI 新增 `forbidRefresh`（收到 `--refresh` 就失败）；
  - 新增两条策略端到端测试：缓存说没满、实时额度说用满时，策略会切走；没有实时额度时照常运行，不调用 `--refresh`。
  - 把合并那一行改回只用缓存，第一条测试就会失败（已验证）。
- 部署：备份在 `versions\deploy-20261029T201045-manualrefresh\`。
- 现场验证：新脚本在 20:11、20:16 两次运行都是 OK，`quota-cache.json` 停在 19:48 没动；重新启动的桌面端也没有触发探测。

### 修复（额度“不会自己刷新”、点「刷新额度」后界面像卡住、额度看起来扣得比以前慢）

- 现象（10-29 用户反馈）：面板额度只有点「刷新额度」才变；点了之后整个窗口转圈、像不能操作；额度“扣得比以前慢”。
- 查证：
  - 额度获取本身没坏。策略计划任务每 5 分钟跑一次 `limits --refresh`，`quota-cache.json` 与当场 `limits --json --refresh` 的结果一致；面板每 15 秒取状态、60 秒重建一次，所以策略刷新后最多约 6 分钟就会显示新额度。
  - “扣得慢”的真正原因：面板把策略的首选账号（`activeIndex`，账号 2）标成“使用中”，但路由因为会话亲和，实际一直用账号 3（`status --json` 的 `runtimeInUseIndex=2`；账本里 16–19 点的请求几乎全在账号 3）。用户盯着的那一行基本不动，扣的是另一行。账号 3 的 5 小时用量实时是 64%，而 19:33 的探测快照还是 44%。
  - 每次 `limits --refresh` 都会给每个账号发一条真实的 `/codex/responses` “quota ping” 请求（带约 21 KB 的 instructions），所以不能靠加快探测频率来“自动刷新”，那样本身就在花额度。
  - 转圈：手动刷新把 `_busy` 和等待光标一直占到后台刷新结束（最长 60 秒）。这段时间定时刷新暂停，切号后的界面更新也要排在它后面。
- 修复：
  - CLI 补丁钩子 v4 + 新模块 `scripts/cli-patch/live-quota.js`：路由把每个真实请求响应头里的额度（`x-codex-primary-*`/`x-codex-secondary-*`）写进 `live-quota.json`。合并写、原子替换、写失败不影响请求，不增加任何请求。
  - 面板 `lib/live-quota.js`：探测快照与实时快照取更新的一份，窗口长度缺失时沿用探测值。`/api/state` 的账号多了 `inUse`（路由实际在用的账号）和 `quotaSource`（`live`/`probe`）。
  - 桌面端：状态列“使用中”改为显示路由实际在用的账号；策略首选但没在用的账号显示“首选”；加粗/绿色跟随“使用中”；详情说明额度是否实时。
  - 桌面端「刷新额度」不再占 `_busy`、不显示等待光标，只把两个刷新按钮置灰。进度（“额度刷新中… N 秒”）和收尾交给原有的定时轮询（刷新中每秒一次）；刷新期间可以照常切号、编辑、看日志。
- 顺带修复（路由被看门狗误杀）：10-28/29 一天十几次“上游传输失败超过 2 分钟无进展（router not running），已自动重启路由”。每次都是路由进程活着、只是状态文件超过 15 秒没更新（多半是电脑刚从睡眠唤醒，路由每秒写状态的定时器还没跑），面板看门狗就把它杀掉重启，正在输出的对话全被掐断。现在进程还在时要连续两个 tick（约 1 分钟）都过期才重启；进程真没了照旧立即拉起。现场连续 5 分钟采样状态文件，最大延迟 1.0 秒，平时不会误判。
- 部署：备份在 `versions\deploy-20261029T195124-livequota\`（`panel\lib`、`CodexQuota.exe`、补丁前的 `runtime-rotation-proxy.js`）；补丁 v3→v4 后经计划任务重启路由（1 秒内监听）；桌面端重新发布后用一次性计划任务启动。
- 现场验证：一次探测请求后 `live-quota.json` 立即出现账号 3 的实时额度；部署后的面板显示账号 3 “使用中”、5 小时剩 36%（`live`，9 秒前），账号 2 “首选”。10-29 用户确认：面板会自己更新额度，点「刷新额度」不再卡住界面。

### 修复（路由与面板服务死掉后不能自愈：Codex 05:48–07:39 没有路由，面板一直“刷新失败 … actively refused”）

- 现象：10-29 早上面板显示 `刷新失败：No connection could be made because the target machine actively refused it. (127.0.0.1:8766)`；同时 53742 上也没有路由，Codex 无法请求。
- 经过：05:27 由 Claude 会话的 shell 拉起了面板服务，05:42 面板看门狗把路由作为自己的子进程重启；05:48:31 Claude 应用退出，Windows 把它拉起的整棵进程树一起结束，面板服务与路由同时消失（路由状态文件同一秒写 `stopped`）。用户 05:28 打开的 CodexQuota.exe 不在这棵树里，留了下来。
- 根因一（路由不自愈）：计划任务 `CodexMultiAuthRouterWatchdog` 的 `ensure-router.ps1` 用 WMI `Win32_Process.Create` 拉起路由。本机上 WMI 创建的进程会被静默拦掉——返回 rc=0，但 wscript 连第一行都不执行（用一个只写文件的 cmd 复现）。于是日志每 5 分钟写一条“已重启”，路由却一直没起来。改为由计划任务的进程直接 `Start-Process`（不属于任何前台应用），并等端口真的监听后再记日志，日志写的是结果而不是“已发起”。验证：停掉路由后手动触发该计划任务，1 秒内监听，进程祖先是计划任务而不是会话。
- 根因二（面板不自愈）：CodexQuota.exe 只在启动时 `EnsureUpAsync` 拉起服务；启动时服务恰好已在（别的进程起的），那个进程退出后面板只会每 15 秒报一次拒绝连接。现在刷新失败且端口不通时自动重启服务（30 秒内最多一次）。验证：部署后杀掉面板服务，20 秒后自动恢复（app.log：`server down -> restarting` / `server restart ok`）。
- 部署：旧 exe 备份为 `versions\deploy-20261028T225555-0dfc520\CodexQuota.exe.before-autorecover`；新 exe 用一次性计划任务启动（启动后即删除），保证它不属于 Claude 会话。
- 教训：不要从 Claude 会话的 shell 拉起需要长期运行的服务；需要时交给计划任务。
- 已知问题（与本次无关，未修）：`panel/test/desktop-rules` 在改动前后都抛 `Sequence contains no elements`（Program.cs:13 找不到规则编辑器的某个控件），需另行排查。

### 决定（储备号保护）

- 用户 10-29 确认：账号 1 保持储备号保护（`emergencyOnly` 开），只有账号 2、3 都用尽时才动用。

### 修复（仍然反复出现 “Selected model is at capacity”：v1 流头闸门漏判 + 截断）

- 现象：装了 v1 补丁后 Codex 仍反复报 `Selected model is at capacity. Please try a different model.`，普通对话轮直接失败（Codex 对这个错误不重试）。路由账本里有 58 条 `upstream_response_failed`，都原样转给了客户端，没有换号重试；10-28 21:57 那次请求在路由里耗了 34 秒，最后仍以容量错误结束。
- 根因（`scripts/cli-patch/sse-head-retry.js` v1）：
  1. 按网络分块逐行扫描。首块恰好断在行尾、没有完整 `data:` 行时（`: keepalive`、单独的 `event:` 行），被误判为“不是 SSE”，整条流不检查就转发；
  2. 首个正文前空闲超时会把重放流直接关掉（截断响应）；一个字节都没有就超时时返回已上锁的原始流；
  3. 只认嵌套 `{"error":{"code"}}` 和两个错误码，顶层形状、`slow_down`、`capacity_exceeded` 漏判；
  4. 容量错误出现在第一个正文事件之后就无能为力，只能原样转发。
  另外 v1 钩子每次容量命中都消耗一次瞬时重试预算（3 个账号 3 次就 503），没用 CLI 自带的 `waitOutModelCapacity` 退避；成功分支已把会话亲和记到这个失败账号上，下一次请求还会选它。
- 修复：
  - 闸门 v2 按完整 SSE 事件解析，只扣留不含可见内容的事件（`response.created / in_progress / queued / metadata`，以及结构性的 `output_item.added / content_part.added / reasoning_summary_part.added`），见到第一个真正的内容事件（delta、`*.done`、`response.completed` 等）才放行，后续字节一个不丢（含随机切分 300 轮的逐字节对照测试）；超时保留正在进行的读取，不截断、不丢块；
  - 放行之后再出现的容量错误不再转给客户端，而是让流以错误结束：Codex 把“流断开”当成可重试并自动重发这一轮；
  - 钩子 v2/v3：失败账号的会话亲和被清掉；先把其它账号各试一次（不占瞬时预算），都不行再走 CLI 的 `waitOutModelCapacity`（退还 token、按 retry-after/退避表等待后重发），预算耗尽才回落到 503；`state.status.lastMidstreamCapacity` 记录中途容量错误发生前转发了哪些事件；
  - `patch-cli-head-retry.js` 会把已安装的 v1 钩子原地升级，钩子带版本标记，以后升级不再依赖备份还原；
  - 面板“最近错误”把 `model-capacity:*` 翻成人话。
- 部署时发现并修掉一个新闸门自身的问题：首个正文事件与后续事件在同一分块里时，同批剩下的事件被丢掉（短回答的 `response.completed` 丢失 → `upstream_missing_terminal`，8 次探测里 2 次）。已加回归测试，修复后重新部署。

### 新增（Codex 侧栏底部显示当前账号，而不是 “codex-multi-auth”）

- 原因：Codex 桌面版设置菜单标题只在应用本身是 ChatGPT 登录时显示账号；否则显示 `model_providers.<model_provider>.name`（应用包里 `CNn()` 的逻辑）。本工具通过路由的 bearer token 鉴权（`requires_openai_auth = false`），所以那里一直是 `codex-multi-auth`。下面两条旧记录说“面板无法直接改写”，并不成立：改的是本机 config.toml 里的这个显示名。
- 实现：`panel/lib/binding-guard.js` 的 `ensureProviderLabel()` 只改本工具 provider 段里 `name = "..."` 这一行为 `账号N · 邮箱`；名字没变不写盘，写入用临时文件 + 改名并在写前复核 Codex 没改过文件，不产生备份。面板开着时看门狗在启动、账号库变化（3 秒 watchFile）和每分钟兜底时同步；面板没开时 `quota-policy.ps1` 每轮结束调用 `panel/sync-label.js` 同步。Codex 下一次读配置（每轮对话后都会读）就会显示新账号。

### 修复（切号策略复查）

- 旧运行时原因被当成永远新鲜：PS1 以 `runtime-observability.json` 的 `updatedAt` 判断新鲜度，但这个文件被诊断探测每几秒刷新；`accountSkipReasons` 却只在池耗尽时写、该账号成功一次才清。被避开的账号会一直挂着旧的 `cooling-down:*`，策略每 5 分钟据此再换一次号（10-27 13:37–13:42 的日志）。`decide()` 现在记录每个原因的首次出现时间（`state.runtimeSeen`），冷却 / 模型容量这类瞬时原因刚出现时照常换号，超过 4 分钟不再据此换号。
- 瞬时原因不再绕过 600 秒切号护栏，只有限流 / 额度耗尽 / 认证失效这类持久原因可以绕过，避免网络抖动或全模型容量波动导致来回切号。
- 储备号保留归还：以前只有策略自己从储备号回切时才恢复 `emergency-only`；被手动切走或故障转移离开后，储备号会一直被运行时当日常号消耗。现在策略记下自己解除过（`state.reserveReleased`），储备号不在用时就恢复；用户手动“取消备用”的账号不会被改回去。
- 现场备注：当前账号 1（reserveIndex=1）的 `emergencyOnly` 在 10-28 12:28 被关掉，日志里没有策略操作记录，按“用户手动”处理，本次没有改动它。
  （10-29 更正：配置 `reserveIndex: 1` 与该账号备注“储备号……平时暂停”都表明它应受保护，12:28 的改动在策略与面板日志里都查不到来源；按配置执行 `account emergency-only 1 on` 恢复。之后策略 `OK`，请求由账号 2/3 承担。若确实想让它日常参与，面板上对账号 1 点「取消备用」即可。）

### 修复（测试套件会改写本机真实 Codex 配置 → Codex 连到已死的临时路由）

- 现象：10-28 23:12 跑完测试后，真实 `~/.codex/config.toml` 的 provider `base_url` 被改成 `127.0.0.1:56861`、token 也换了，Codex 整夜指向一个临时路由，直到 10-29 05:28 面板启动时绑定守卫才修回；05:28 守卫一次清掉 5 个泄漏的临时路由（每跑一次测试留下一个）。CHANGELOG 里此前多次的“app-login 泄漏的临时 router 改写 config.toml”事故，测试套件本身就是来源之一。
- 复现：对真实 config.toml、路由启动项和路由进程做快照，跑一次 `npm test`，config.toml 被改、多出一个 `%TEMP%\cma-app-login-*` 下的路由进程。
- 根因：`app-login.contract.test.js`（以及 `server.contract.test.js`）起面板时只重定向了 `CODEX_HOME`；面板通过 `APPDATA` 找到真实 CLI，CLI 在空 CODEX_HOME 里做首次绑定，起临时路由并改写真实 Codex 配置。`router-login.contract.test.js` 早就同时重定向了 `USERPROFILE`/`APPDATA`，这两个没有。
- 修复：两个测试同时重定向 `USERPROFILE`、`APPDATA`；app-login 测试的临时目录前缀改掉（`cma-app-login-` 是真实登录流程的前缀，会被守卫当成泄漏）。`scripts/test.js` 加了绊线：测试前后对真实 `config.toml` 与路由启动项做指纹比对，一变就让整次测试失败。
- 同类问题：`binding-guard.test.js` 每次运行都往真实 `panel-events.log` 写假的 GUARD 记录，并把编出来的 pid 111 交给真实 `taskkill /T /F`（会杀掉本机碰巧占用该 pid 的进程树）。`ensureProviderConfig` / `sweepOrphanRouters` 现在可注入 `log` / `kill`，测试只用替身；已删掉日志里 12 条测试写入的假记录（有对应 config 备份的真实修复记录保留）。
- 验证：修复后跑全套 350 项，真实 config.toml 指纹前后一致、只剩生产路由一个进程。Codex 自己的日志：修复上线后 25 次请求 0 次轮次错误、0 次容量错误；05:29 新会话加载的 provider 为 `账号2 · <邮箱> → http://127.0.0.1:53742`，侧栏显示名已生效。
- 10-29 追加核验：①连续 60 次探测 60/60 完整返回、客户端 0 次容量错误；同期路由遇到 2 次上游 `server_is_overloaded`，均被透明重试（上游请求 132 次 / 客户端 130 次）。②Codex 自身日志：修复上线后 68 次请求，0 次轮次错误、0 次容量错误。③运行中的面板看门狗：把 config.toml 的 name 手动改回 `codex-multi-auth`，两次都在 2 秒内被面板改回当前账号，文件其它内容逐字节不变（期间策略任务没有运行，确认是面板）。④侧栏文字本身未目视确认：Codex 窗口底部在屏幕外且正在执行任务，没有去操作它。（10-29 用户确认：设置菜单标题已显示账号邮箱，不再是 codex-multi-auth。）

### 新增（切换账号时右下角提示 + 托盘显示当前账号）

- 面板托盘图标提示与右键菜单首行显示当前账号（账号 N · 邮箱）。
- 切换账号时在屏幕右下角弹出自绘提示窗（不依赖 Windows 通知设置），约 4 秒后自动消失，并写 ccount-toast 日志便于排查。
- Codex 应用自身托盘的标题由该应用生成（model_provider 显示名），面板无法直接改写，因此把提示做在面板侧。


### 新增（托盘显示当前账号与切换提示）

- 桌面版托盘图标的 tooltip 现在会显示「Codex 额度面板 · 账号N · 邮箱」，托盘右键菜单首行也显示当前账号。
- 运行中检测到当前账号变化（策略自动切号或手动切换）时，弹一次气泡「已切换到账号N」，内容为账号与邮箱。
- 说明：Windows 通知区域里那个 codex-multi-auth 标题来自 OpenAI Codex 应用自身的托盘菜单，由上游程序生成，无法注入账号文字；账号提示放在本面板托盘。

### 修复（流内 SSE 过载错误：Selected model is at capacity）

- 现象：Codex 客户端反复弹出 `Selected model is at capacity. Please try a different model.`，重试无效。
- 根因：上游模型过载时返回 **HTTP 200 + SSE `{"type":"error","code":"server_is_overloaded"}`**；现有 stream failover 只在读流出错时触发，SSE 里的 error 是普通字节，且 `response.created` 已发给客户端，因此不会换账号，客户端只能看到容量错误。
- 修复：给已安装 CLI 打本地补丁 `scripts/patch-cli-head-retry.js`——在写客户端字节前先用 `inspectResponseHead()` 读一小段上游 SSE；识别到容量类错误就退还 token、换账号重试；同时按字节识别 SSE（上游 200 响应常常没有 content-type）。
- 验证：同一模型 `gpt-6.1-sol` 由打补丁前 2/10 失败变为打补丁后 10/10 成功，router 状态出现 `lastError=model-capacity:server_is_overloaded` 的重试记录。
- 注意：补丁作用于 `%APPDATA%\npm\node_modules\codex-multi-auth\dist`，**npm 升级后需重新执行** `node scripts/patch-cli-head-retry.js`；`--check` 查看状态，`--revert` 还原；`CODEX_MULTI_AUTH_STREAM_HEAD_RETRY=0` 可临时关闭。

### 修复（Codex 反复报容量/503：app-login 泄漏的临时 router 会持续改写 config.toml）

- app-login 绑定流程会用临时 CODEX_HOME 起一个隔离 router 并改写真实 `config.toml`；绑定中断后该 router 仍存活，于是面板守卫每分钟修好配置、它下一分钟又改回去，Codex 客户端缓存的 base_url 也停在临时端口上，表现为持续数小时的 “Selected model is at capacity” / 503。
- 面板守卫（`panel/lib/binding-guard.js`）此前只清理“自报已死”的临时 router；现在把“存活超过 15 分钟”或“父进程已退出”的临时 router 也按泄漏处理，`panel/lib/watchdogs.js` 的路由看门狗每分钟清扫一次，配置被改写后一分钟内即可修复。
- 新增 2 条守卫测试（共 327 项）。

### 新增（模型探测脚本 model-probe）

- 用途：怀疑「模型被降智 / 请求打到了别的模型」时，用 `node scripts/model-probe.js` 走 Codex 同一条链路（config.toml → 本地 router）发一次流式请求，把上游真实回执打印出来。
- 输出：上游回显的模型名（`response.created` / `response.completed` 的 `model`）、`access_programs`、`x-codex-plan-type`、`x-codex-active-limit`、`x-codex-safety-buffering-*`、5H/7D 用量百分比、`reasoning_tokens`、端到端延迟。
- 判定：请求模型与回显模型不一致会显式告警；上游过载（`service_unavailable_error` / `server_is_overloaded`）与安全缓冲降级会被单独标注，避免和账号额度问题混淆。
### 修复（策略页窗口一小就把底部按钮裁掉）

- 现象：窗口高度不足时，策略页的「上移 / 下移 / 应用到草稿 / 取消」被挤出可视区，用户只能改分辨率或手动拉大窗口。
- 原因：策略页用固定行高的 TableLayoutPanel，编辑器占位行是 Percent(100)，窗口一变矮该行就被压到 0，底部按钮随之裁掉。
- 修复：策略页拆成「可滚动内容 + 固定在底部的操作栏」——`保存策略 / 放弃草稿 / 上移 / 下移 / 应用到草稿 / 取消` 永远贴在窗口底部，内容再长也不会被裁；中间内容仍可用滚轮/滚动条浏览；编辑器内部表格改为固定高度不再被压扁；OnLoad 设置窗口最小尺寸，避免左右分栏被挤扁。175% 缩放下同样生效。
### 修复（刷新额度一直不更新：面板派生的 CLI 探测没走代理）

现象：点「刷新额度」后 5 小时 / 7 天额度长时间不变，后台只留 `CLI_TIMEOUT` 记录。

根因：面板进程由桌面端拉起，自身没有 `HTTP(S)_PROXY`；`runCli` 只把 `paths.PROXY_ENV`（来自进程环境）传给 CLI 子进程，也没有 `NODE_USE_ENV_PROXY=1`，于是 CLI 内的额度探测直连 chatgpt.com 被墙 → 45 秒超时 → CLI 静默保留旧缓存，界面上看起来“刷新没反应”。

修复：
- 新增 `panel/lib/proxy.js`：按「进程环境 → panel-config.json 的 proxy → Windows 系统代理（ProxyEnable + ProxyServer）」解析代理，60 秒缓存；`proxyEnv()` 同时注入 `NODE_USE_ENV_PROXY=1`。
- `panel/lib/cli.js`：`runCli` 改为带代理兜底环境；登录窗口/路由启动脚本的 `processEnvLines()` 在无代理时不再硬写环境变量。
- `panel/lib/dashboard.js`：`--refresh` 的超时 45s → 90s（实测单次 7–15s，代理慢时更久）。
- 新增 `panel/test/proxy.test.js`（8 项）并把 `panel/lib/proxy.js` 登记进 imports 分层表。

验证：清空代理环境跑 `npm test` 325/325、`npm run verify` 全绿；部署后点「刷新额度」，quota-cache 三个账号 updatedAt 前进到 01:41、status 200，桌面端 5 小时显示 93% / 2%，7 天 57% / 43%（此前长期停在 01:04 的旧值）。

### 按剩余额度设置切换阈值

- 桌面和网页规则编辑器改为直接填写 5H、7 天「剩余 ≤ X%」，支持全局默认和单号覆盖；0% 表示用完再切，允许 0–99%。
- 读取、保存时自动与原有已用比例配置换算，已有策略无需迁移。任一窗口达到阈值即进入切换判断，继续遵守等待刷新、切换间隔与候选账户健康检查。
- 验证：317 项 Node 测试、桌面 API 与实际规则表单控件测试通过；隔离目录 Release 编译通过（NU1900 网络警告仍存在）。已随 `3588dbf` 部署，62 个发布文件校验一致，账户和轮换规则保持不变。

### 可视化自定义账户规则

- 桌面端新增规则编辑对话框，网页版用表单替换 JSON 编辑框。支持多个日常/备用号、组内顺序、循环或优先选择、5H/周已用阈值、等待刷新、切换间隔、自动回切及单号覆盖。
- 规则按稳定账户标识绑定。保存时核对完整账户池，失败保留原配置与草稿；旧角色按钮不会与自定义角色相互覆盖。支持关闭自定义模式和放弃草稿。
- 保存响应回显已接受规则，额度快照附带当前策略；保存期间禁用表单编辑。WAIT/GUARD 不会因软阈值暂停仍有额度的当前账户。
- 新增规则编辑、HTTP 保存与故障保护、真实 PS 执行、桌面 API 序列化及实际表单控件测试。已随 `b0a1f82` 部署，62 个发布文件校验一致，7 个账号及配置文件保持不变。
- 验证：315 项 Node 测试通过；桌面 API、实际规则表单控件测试及隔离目录 Release 编译通过。虚拟账户网页操作验证了顺序、覆盖值保存回显及无效输入保护；审查子 agent 修复后复核未发现新的 P1/P2 问题。NU1900 仍提示无法在线获取 NuGet 漏洞数据。

### 按钮操作与策略草稿保护

- 桌面策略表单记录未保存的修改，自动刷新不覆盖草稿；只有保存成功才清除草稿标记，保存失败保留输入。
- 桌面 HTTP 客户端把 HTTP 200 中的 `ok:false` 视为失败；新增调用实际 C# 客户端与本地假服务的测试，并加入桌面 CI。
- 操作返回后立即恢复按钮，状态回查在后台串行合并。操作前发出的旧查询不能覆盖操作后的界面，也不会覆盖新的操作提示。
- 设为备用/取消备用前读取原角色与暂停状态；配套暂停操作失败时尝试恢复并读回核对，不能确认时明确报告部分失败。所有已开始的角色变更都会使缓存失效。
- 重新绑定与配置守卫、账号操作共享操作锁，锁被占用时返回 409；新增备用号恢复与绑定互斥回归测试。以上改动已随 `d650dad` 部署，发布校验记录见 `.audit/hotfix-maintainability.tsv`。
- 验证：`npm run verify` 299 项通过；实际 C# API 客户端的四种响应检查通过，桌面 Release publish 成功（NuGet 漏洞数据检查仍有网络不可达警告）。原生界面草稿保持和按钮恢复的实机操作验收尚未执行。

### 刷新请求与桌面刷新开销

- 普通状态查询期间点击刷新额度会排队一次深度查询；重复点击合并，等待期间返回旧快照并标记正在刷新。
- 账号列表复用原有行，只修改变化的字段；日志内容不变时不重建列表，刷新不再强制聚焦第一行。
- 账号和日志列表复用加粗字体，窗口释放时一并释放；用量页隐藏时不触发统计，切换页签遵守已有三分钟缓存。
- 新增真实 HTTP 服务与假上游的并发刷新回归测试。`npm run verify` 295 项通过；桌面 Release 编译和 publish 成功。NuGet 漏洞数据检查因网络不可达产生 NU1900 警告；原生窗口闪烁和资源使用尚未做实机验收。未部署到正式运行目录。

### 修复（Codex 503：app-login 中途打断把 Codex 配置留在临时 router 上）

- 现象：Codex 客户端持续 `unexpected status 503 Service Unavailable: All managed Codex accounts are temporarily unavailable`，报错 URL 是 `http://127.0.0.1:58932/responses`，而生产路由应监听 53742；本地用 `~/.codex/config.toml` 的 bearer token 探测 53742 直接 401。
- 根因：app-login（`rotation bind-app`）会改写真实 `~/.codex/config.toml` 的 `openai_base_url`、`[model_providers.codex-multi-auth-runtime-proxy] base_url` 与 `experimental_bearer_token`，指向它临时起的隔离 router；流程被中途打断（关窗口 / 进程被杀 / 面板重启）时配置不会回滚，临时 router 又变成 `%TEMP%\cma-app-login-*` 下的孤儿进程，于是 Codex 一直连到那个已经不该再用的端口，token 也与当前 app-bind 的 `clientApiKey` 不匹配。
- 修复：新增 `panel/lib/binding-guard.js`：①`ensureProviderConfig()` 以 `app-bind/runtime-rotation-app-bind.json` 为唯一可信来源，发现配置里这三行与它不一致（且 app-bind 端口确实在监听）时先备份 `config.toml.bak-*` 再回写；②`sweepOrphanRouters()` 只清理「命令行同时含 `codex-app-router.js` 与临时 `cma-app-login-` 目录」的孤儿 router，并删除对应的临时 home（没有 router 状态文件或 router 仍存活的 home 一律不动）。面板启动时跑一次，路由看门狗每分钟复检。测试套件里由 `CMA_TEST_MODE=1` 自动跳过，单测用 `deps.force` 覆盖。
- 测试：新增 `panel/test/binding-guard.test.js`（4 项：不一致判定、只回写那三行、孤儿 router 识别、端口不在监听时不写配置），`scripts/check-imports.js` 登记新模块分层；现在 294 项。
- 运维：本轮已手动把配置指回 53742 并清理 24 个临时 home；Codex 桌面端需要重启一次才会重新读取 `config.toml`。
### 修复（面板把过期窗口显示成 0% 剩余、陈旧快照无任何标注）

- 现象：桌面端 5 小时列与详情同时出现「0% 剩余 · 10:57（已重置）」，旁边还挂着「额度接口返回 429（通常代表该账号当前被限流）」和「状态说明 model-not-supported」，用户无法判断是真被限流还是数据过期。
- 根因：①`quota-cache.json` 的快照 `updatedAt` 仍停在 09:09——CLI 的额度探测失败时会静默保留旧值（上游额度接口超时，旧快照未被错误地当成新数据）；②`panel/lib/dashboard.js` 的 `pickWindows()` 只回 `usedPercent`/`resetAt`，没有“窗口已过”和“快照新鲜度”概念，桌面端与网页端于是把上一窗口的旧百分比和“已重置”并排显示，陈旧的 429 与 runtime skip reason 也无从区分。
- 修复：`panel/lib/dashboard.js` 的 `pickWindows(quota, now)` 增加 `expired`（`resetAt <= now`），账号对象增加 `quotaUpdatedAt` 与 `quotaStale`（超过 `STALE_QUOTA_MS`=30 分钟视为陈旧）；`panel/app/Api.cs` 的 `AccountState`/`QuotaWindow` 同步字段；桌面端与网页端继续显示百分比（5 小时/7 天列与额度环），但过期窗口的进度条/额度环置灰，重置行标注「（已重置）· 额度快照 X 前」，提示条区分「没有可用快照」/「快照陈旧（接口 N）/ 请检查代理后刷新」/ 429。
- 测试：`dashboard-units.test.js` 增加 `pickWindows` 过期标记用例，`frontend-render.test.js` 增加「已重置仍显示百分比（灰环）+ 陈旧提示」用例；现在 290 项。
- 说明：本次只改显示口径，不改变探测/缓存策略——额度真正刷新仍取决于代理出口是否恢复。

### 修复（5h 窗口已重置但缓存仍报 100% → 运行时池空、Codex 503）

- 现象：策略持续输出 `WAIT  账号3 有周额度但 5h 打满，仅需等 -145.4 分钟 (<60)，暂不动用储备号`（负数越来越大），`quota-policy.state.json` 的 `exhaustedPaused:[2,3]` 一直保留，账号 2/3 被永久 pause；随后账号 1 运行时 `cooling-down:network-error`，整个池子为空，Codex 请求返回 503 `All managed Codex accounts are temporarily unavailable`。
- 根因：策略读的是 `limits --json` 的**缓存**额度（cached 模式不请求上游，只有面板手动刷新/`--refresh` 才更新，`quota-cache.json` 已滞后数小时）。`describeAccount()` 只看 `usedPercent`，窗口 `resetAtMs` 过去后仍判为耗尽 → ①`planExhaustionPauses()` 永不给账号 2/3 resume（手动恢复也会被重新 pause）；②`decide()` 的自身/候选 WAIT 用负数 `wait5 < minWaitMin` 永远成立，策略一直“等 -145 分钟”；③切换目标被 `exh5` 过滤，储备号也进不去。
- 修复：`panel/policy-core.js` 给 `describeAccount()` 增加派生标记 `expired5/expired7`（`wait5/wait7 <= 0`，即重置时刻已过）；新增 `shortExhausted/weeklyExhausted/anyExhausted`，把决策里的“耗尽”判断改为“耗尽且窗口未重置”；自身 WAIT 与候选 WAIT 都要求 `wait5 > 0`；DEAD 的最早重置估算跳过已过期窗口；`fmtUsage/fmtWhyUsage` 显示 `5h 已重置`。`quota-policy.ps1` 的 `pauseFrom` 与 failover unpin 同样改用“耗尽且未重置”，避免切离已重置账号时把它 pause 掉。rotation 模式（`rotation-policy.js`）不动（已有 `wait5 > 0` 保护）。
- 测试：`policy-core.test.js` 的负 wait 用例改为“窗口已重置→按可用处理”，新增 5 项（过期→OK/回切/不误判周额度、`planExhaustionPauses` 过期→resume）；现在 288 项。

### 修复（恢复账号按钮 25s 静默超时 → 只显示“账号操作失败”）

- 现象：面板点「恢复账号」偶发 25 秒后弹 `失败：账号操作失败`；`panel-errors.jsonl` 记录 4 条 `CLI_TIMEOUT`（多个时段），operationId 与点击时刻吻合。同机手工执行 `account unpause N` 均为毫秒级（live 实测 357ms），面板内并发/隔离复现也 ~400ms。
- 根因：`panel/lib/cli.js` 用 `execFile` 调 CLI，stdin 管道一直保持打开；一旦 CLI 里某个路径读 stdin，子进程会静默挂到 25s 超时（stdout 为空，面板拿不到错误信息，只能落固定兜底文案）。具体触发路径未能复现，属外部环境偶发阻塞。
- 修复：`panel/lib/cli.js` 改为 `spawn` + `stdio:['ignore','pipe','pipe']`，显式关闭 stdin；自行实现超时（SIGKILL）与输出上限（16 MB），超时/退出码/输出过长分别映射为 `CLI_TIMEOUT`/`CLI_FAILED`/`CLI_OUTPUT_LIMIT`，并把可读 `error` 带回上层。`panel/lib/account-actions.js` 对 `CLI_TIMEOUT` 短暂延迟后**重试一次**（账号操作幂等），两次都失败时返回「CLI 超时（25000ms）且重试一次仍超时：…」，面板不再只有固定兜底文案。
- 顺手修掉契约测试偶发失败：`panel/lib/login-flow.js` 的 `loginStateAge()` 在“刚写完状态文件就再点一次”时可能算出亚毫秒负数年龄，被当作“没有登录窗口”，导致 `POST /api/login` 单飞失效（`router-login.contract.test.js` 偶发 200≠409）。负数现在按 0 处理。
- 测试：新增 `panel/test/account-actions.test.js` 4 项（超时重试一次成功 / 两次超时原因可读 / 非超时失败不重试 / stdin 未关闭会挂起），现在 288 项。

### 修复（计划任务里策略每轮 ERROR：CLI 输出按 GBK 解码）

- 现象：`quota-policy.log` 从 22:26 起每 5 分钟一条 `ERROR account policy list JSON 解析失败`，策略每轮空转（暂停/切号/额度维护全部停摆），但计划任务 `LastTaskResult` 仍然是 0。
- 定位：手工在终端跑同一条 CLI 完全正常；把 live 脚本复制成 `quota-policy.diag.ps1` 用 `wscript //B` 复现后抓到 `$polText` —— JSON 结构正确，但 note 的中文全是乱码，尾字节还吃掉了后面的引号。
- 根因：PowerShell 5.1 解码原生命令的 stdout 用 `[Console]::OutputEncoding`。计划任务/无控制台进程里它是 936(GBK)，而 CLI 输出是 UTF-8 → 中文乱码、偶发吃掉 JSON 引号。交互终端里 DSH 已设 UTF-8，所以“手工跑永远正常”。
- 修复：`quota-policy.ps1` 新增 `Capture-Cli`（`cmd.exe /d /s /c` + 显式 `StandardOutputEncoding/StandardErrorEncoding = UTF8`），所有需要解析输出的调用统一走它（status / limits / policy list / switch 校验 / unpin / emergency-only / 暂停恢复 / 清限流标记）；`Invoke-CliTimed` 也补了 UTF-8 解码。
- 顺手：`WARN`（日常号池空）原来每轮都写一条日志，改为与 `OK`/`GUARD` 一样只在状态变化时写（`policy-core.js` 的 WARN details 增加 `fresh`），+1 项单测。
- 测试：+2 项 PS1 测试（`936` 编码下冒烟跑完一轮；**静态守卫**：文件里不允许再出现 `& $cma ... | Out-String`，并要求存在 `Capture-Cli` 与 UTF-8 解码行，已反证），现在 241 项。

### 新增（应用登录可见 + 一键同步）
- 现象：代理已经在用有额度的号，Codex 界面却仍显示 "You're out of Codex and Work usage — resets on X"，而且 X 正好是应用登录账号的 5h 重置点。
- 根因：面板「切换账号」只改代理路由（activeIndex/pin/pause）；Codex 应用的额度横幅读的是自己的登录态 `~/.codex/auth.json`。两者不一致时，界面显示的是应用登录账号的限额。
- 新增：`panel/lib/app-auth.js`（解 token 身份 / 读应用登录 / 写 auth.json + 备份）、`panel/lib/proxy-accounts.js`（代理账号库只读视图 + 比对）、`POST /api/app-login`（把应用登录同步为指定邮箱或序号）；`/api/state` 增加 `app` 摘要（只含 email/plan/是否一致，绝不含 token）。
- 前端：顶部新增「应用登录」pill（不一致标黄提示），路由操作区新增「同步应用登录」按钮。
- 测试：`panel/test/app-auth.test.js` 6 项单元 + `panel/test/app-login.contract.test.js` 4 项真实后端契约（含"响应不得出现 token"断言），现在 241 项。

### 修复（CLI 输出夹带警告行 → 策略整轮 ERROR 空转）

- 现象：22:12 真实事故，`quota-policy.ps1` 报 `ERROR account policy list JSON 解析失败`，
  tick 只 +1、不做任何决策（暂停/切换/额度维护全部停摆）。
- 根因：CLI 的 stdout 前多了一行警告，PS1 直接 `| ConvertFrom-Json` 就失败；
  status / limits / account policy list 三类输入都有同样风险。
- 修复：新增 `Get-JsonText`（截取第一个 `{` 到最后一个 `}`），五处 CLI 文本解析统一包住；
  假 CLI 增加 `noise: true` 场景，`policy-ps1.test.js` +1 项回归（去掉修复会失败，已反证）。
- 现在 241 项测试。

### 修复（5h 已用满的日常号仍在派单 → Codex 显示“额度用完”）

- 现象：某个日常号的 5h 已经打满、其它账号还有额度，但 Codex 界面弹「You're out of Codex and Work usage —
  resets on X」，提示的重置时间正好是这个 5h 窗口的重置点。
- 根因：运行时会按**缓存额度**判断账号可用性，把 5h 已满的号当成可用派单；上游返回 429 后客户端把它翻译成
  “额度用完”。策略侧虽然知道它耗尽，但只在“当前号耗尽”时切走，拦不住运行时继续派给**其它**已耗尽的号。
- 修复：新增 `planExhaustionPauses()`（`panel/policy-core.js`）与 `policy-cli.js plan-pauses`；策略每轮在决策之后
  执行一次维护：暂停 5h/周额度已耗尽的**日常号**，额度窗口重置后自动恢复。储备号不参与（由储备号分支负责），
  `-DryRun` 只报告不动手。被暂停的账号记在 `quota-policy.state.json` 的 `exhaustedPaused`，只恢复自己暂停过的；
  用户手动解除但账号仍耗尽时会被重新暂停。
- 可观测：`PAUSE 日常号额度耗尽，自动暂停（账号N）` / `RESUME 额度窗口已重置，自动恢复可用（账号N）`
  进策略日志与面板事件页；DryRun 输出 `DRYRUN 将暂停/将恢复` 便于先验证。
- 测试：`panel/test/policy-pauses.test.js`（11 项）+ `panel/test/policy-ps1.test.js` +3（真实脚本暂停 / 恢复 /
  DryRun 不动手），现在 241 项测试。
### 新增（路由退出直接进面板事件页）

- 路由退出后，除了写进 `app-bind\runtime-rotation-app-router-launch.log` 的 `ROUTER-EXIT exit=<code>`，
  面板的「事件」页现在也会多一条 `ROUTER  路由进程退出（exit=0，发生在 …）`，不用再翻 app-bind 目录。
- 分工：launcher（`.cmd`，ASCII）只负责落文件；中文事件由 `panel/lib/watchdogs.js` 在下一轮 tick 读到新退出记录后
  用 `appendPolicyLine()` 补写。面板刚启动时会把已有记录标记为「已上报」，不会刷旧账。
- 纯函数 `readLaunchExit()`（router-control）、`describeRouterExit()` / `nextLaunchExitSeen()`（watchdogs），
  +3 项测试（router-control 1、watchdogs 2），现在 210 项测试。
### 修复（重启面板把路由一起杀掉 → Codex 一直重连；路由退出没有退出码）

- 托盘退出用 `Process.Kill(entireProcessTree: true)`，而路由是面板 spawn 的子进程 → 每次重启面板都顺手杀掉路由，
  之后要等看门狗 60 秒才发现（多次运行均可复现）。
- 改为 `app-bind\router-launch.vbs` 脱壳启动：wscript 拉起 launcher 后立即退出，路由不再挂在面板进程树下，
  面板重启不影响它。
- launcher 在路由退出时把 `%ERRORLEVEL%` 与时间写进 `app-bind\runtime-rotation-app-router-launch.log`
  （`ROUTER-EXIT exit=<code>`），下次“路由自己没了”能直接看退出码。
- `panel/test/router-control.test.js` +2 项（launcher/VBS 文本、引号与不等待语义），现在 210 项测试。

### 修复（重复 BOM 让 `powershell -File` 的首行 `param` 失效）
- **`quota-policy.ps1` 开头出现两个 UTF-8 BOM**：Windows PowerShell 5.1 只吃掉第一个 BOM，第二个被当成命令名的一部分，
  于是首行 `param([switch]$DryRun)` 报 `CommandNotFoundException`——脚本看起来还在跑（后面的语句继续执行），但参数全丢、
  日志里也没有这条错误（输出被启动器吞掉）。已把 `quota-policy.ps1` 与 `panel/app/Api.cs` 规范成单个 BOM。
- **闸门补上这类"能跑"的坏编码**：`scripts/check-encodings.js` 现在拒绝开头重复的 UTF-8 BOM（`EF BB BF ×2`），
  反证：手工加第二个 BOM → `npm run encodings` 立即 exit 1 并指出文件。

### 修复（踢策略仍然过频：网络冷却不该触发、账号轮换改签名）

- 上一版只看「有没有硬阻塞」，但 `cooling-down:*`（网络/上游抖动）也算硬阻塞，策略换号治不了网络；
  且签名里带了 `lastAccountIndex`，路由每次重试/轮换都会改它 → 等于没去重（会持续重复触发）。
- 触发条件收紧为**只有配额类**（`rate-limited` / `quota-exhausted`）才踢；签名只保留「池耗尽原因 + 跳过原因」；
  节流从 60 秒提到 **5 分钟**，与策略自身节奏对齐。
- `panel/test/watchdogs.test.js` 同步改写断言（网络冷却不踢、5 分钟节流、账号轮换不改变签名）。

### 修复（路由静默退出后 5 分钟没人管 + 存活判定会被 PID 复用骗过）

- 侦察发现：路由进程会在上游 `fetch failed` 后消失，而面板仍显示「运行中」——`readRouter` 只用
  `process.kill(pid, 0)` 判活，Windows 的 PID 会被系统复用，就命中了别的进程；真正能拉起它的
  只有 5 分钟一次的计划任务，这段时间里 Codex 每个请求都失败。
- `describeRouterStatus` 增加「状态文件新鲜度」：路由活着时每秒重写状态文件，`updatedAt` 超过 15 秒
  未刷新即判定不在运行（`STATUS_FRESH_MS`），单测 +1 锁住。
- 看门狗 `nextRouterWatch` 遇到「不在运行」直接按 60 秒冷却拉起（`DOWN_RESTART_COOLDOWN_MS`），
  不再干等计划任务；拉起时把路由 stdout/stderr 追加到 `panel-router.log`，静默退出才有证据可查。

### 修复（看门狗重复踢策略：sticky 的「池耗尽」原因让它每分钟跑一次）

- `shouldKickPolicy` 只看 `lastPoolExhaustionReason` 非空，但该字段会长期挂着（池子恢复前一直是上次的 `no-account`），
  于是看门狗每 60 秒就踢一次策略、`panel-events.log` 每分钟一条 POLICY 记录。
- 新增 `kickSignature(obs)`：把「跳过原因 + 池耗尽原因 + 重试时长 + 上次账号」压成一行签名；
  `shouldKickNow()` 在 `shouldKickPolicy` 之外再要求签名与上次踢时不同——同一张画像只踢一次，出现新阻塞立刻踢。
- `panel/test/watchdogs.test.js` +3（签名与原因顺序无关、sticky 不重复踢、签名变化才踢且 60 秒节流仍生效）。

### 修复（网络抖动 → 运行时冷却 → 503 空窗）
- **运行时的 `cooling-down:*` 也算硬阻塞**：上游超时或 `fetch failed` 会让运行时把当前账号标成
  `cooling-down:network-error` 并暂时不可路由，而额度缓存里它可能还写着"有额度"。现在
  `panel/policy-core.js` 的 `isHardRuntimeReason()` 把 `rate-limited` / `quota-exhausted` / `cooling-down:*`
  统一视为硬阻塞（判据集中在 `HARD_RUNTIME_REASONS` + `COOLDOWN_RUNTIME_PREFIX`），`quota-policy.ps1` 的
  `accountSkipReasons` 过滤同步放宽——网络冷却当轮换号，不再等额度缓存更新。
- **看门狗把 5 分钟盲区压到 1 分钟**：`panel/lib/watchdogs.js` 新增 `shouldKickPolicy()` / `kickPolicy()`，
  每 60 秒读一次 `runtime-observability.json`，90 秒内看到「池耗尽 / 账号冷却」就立刻踢一次 `quota-policy.ps1`
  （两次至少间隔 60 秒，策略自己的互斥体兜底）。
- **切走不等于暂停**：`Try-Switch` 新增 `pauseFrom` 参数——原账号额度仍健康时只切号、不 `account pause`
  （日志 `KEEP 账号N 仍有额度，保持可用（作为运行时即时故障转移目标）`），避免把运行时唯一的备用号锁死成 503。
- 新增 6 项测试（`policy-runtime` +2、`watchdogs` +3、`policy-ps1` +1：网络冷却换号、健康号不暂停、
  踢策略的时效与去重），现在 210 项测试。

### 修复（大上下文请求 60 秒超时 → 503）
- **上游超时从 CLI 默认 60s/45s 提高到 300s/90s**：巨量上下文（单会话超大上下文、远程压缩）的请求经常超过默认的 `CODEX_AUTH_FETCH_TIMEOUT_MS=60000`，运行时把它记成失败并短暂冷却账号，池子瞬间「无可用账号」→ Codex 界面 503。现在 `panel/lib/router-control.js` 生成的启动项与 `startRouter()` 的进程环境都注入 `CODEX_AUTH_FETCH_TIMEOUT_MS=300000`、`CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=90000`。
- **旧的启动项会被自动重写**：`needsStartRepair` 把「缺少上面两个超时设置」也算作需要修复，下次面板启动/重启路由时按 app-bind 重新生成，不需要手动改 Startup 目录里的 .cmd。
- `panel/test/router-control.test.js` +2 项（缺超时设置要修、`routerEnv()` 注入正确且不丢父环境），现在 210 项测试。

### 修复（运行时已 429、额度缓存还写着 12% → 立即换号）
- **策略开始听运行时的信号**：额度快照比真实限流慢（事故里缓存写 12%，运行时已 429，中间空窗约 3 分钟持续 503）。`quota-policy.ps1` 现在每轮读 `runtime-observability.json`（10 分钟内有效），把 `accountSkipReasons` / `lastPoolExhaustionSkipReasons` 里的 `rate-limited`、`quota-exhausted` 作为硬阻塞传给决策核心；`panel/policy-core.js` 的 `decide()` 收到 `runtimeBlocked` 后，该账号立刻按「不可用」处理——当前号被限流就同轮换号，候选号被限流就不选它。
- **旧 429 标记自动清理**：窗口已重置、运行时还带着旧限流标记时，自动 `rotation reset-rate-limits --account N` 清掉，让它重新参与轮转（日志里是 `RATELIMIT-RESET`）。
- **策略卡死不再静默**：`limits --refresh` 现在带 150 秒超时（`Invoke-CliTimed`）；以前上游卡住会让进程一直占着单飞锁，之后每 5 分钟的运行都 `WaitOne(0)` 失败直接 `exit 0`，策略停摆但没人知道。超时后按「ERROR limits 刷新失败」落盘并释放锁。
- 单飞锁名可用 `CMA_POLICY_MUTEX` 覆盖：测试用独立锁，不再和真机计划任务抢同一把锁（之前会导致测试随机失败/真机运行被跳过）。
- 新增 `panel/test/policy-runtime.test.js`（4 项：缓存 12% 但运行时限流必须换号、quota-exhausted 同权、候选被阻塞则跳过、model-not-supported 不算额度不可用）+ `panel/test/policy-ps1.test.js` +2（真实脚本同场景；窗口重置后清标记），现在 210 项测试。

### 修复（用量统计口径核对）
- **用量角色统计曾因标题关键词误判**：会话标题存的是整段首个提示词，长提示词里写到“交叉复核”就会被关键词匹配成审查会话。`roleOf` 现在只看标题第一行前 80 字（自动 review 仍按模型名判定），主开发/审查/自动 review 三类各归各位。
- **窗口首末采样按时间戳取**：`recordWeekly` 原来按文件遍历顺序记 first/last `used_percent`，多文件并行时可能算出负增长或错的“1% 额度≈多少 token”。现在按事件时间取最早/最晚采样。
- **`/api/usage` 缓存按 `?days` 分开**：原来 1 天和 7 天共用一份 3 分钟缓存，先请求 1 天再请求 7 天会拿到错窗口的数据。
- 核对结论（真实数据 7 天）：`tokens` = 每次请求 `last_token_usage` 的累加（含缓存输入），与按天序列合计一致；97.5% 是缓存命中率（cached/input）；14,274 个采样里只有 98 个 `total_tokens ≠ input+output`（0.7%），无重复事件、无同一会话多文件重复计数。
- 新增 3 项单测（角色判定、窗口采样时序、按天数缓存隔离），现在 210 项测试。

### 修复（pin 卡死 → 503，自动解除）
- **策略脚本自动解除遗留 pin**：`codex-multi-auth switch` 会把目标账号写进 `pinnedAccountIndex`，被钉账号限流时运行时直接 503。`quota-policy.ps1` 现在在 `autoSwitch` 模式每次运行开头解除遗留 pin，`Try-Switch` 成功切号后也立即 `unpin`；手动模式（`autoSwitch=false`）保留用户 pin。
- 面板账号卡片：「已固定」chip + 「解除固定」按钮（`POST /api/account { action: "unpin" }`），确认框提示"被固定账号一旦限流，请求会直接 503"；e2e 第 9 项改为真实点按钮。
- `panel/test/policy-ps1.test.js` 扩到 6 项：新增「自动模式清遗留 pin」「手动模式不碰 pin」「切号后解除 pin」；`panel/test/fixtures/fake-cma.js` 支持 `CMA_PIN`，模拟 `switch` 钉住、`unpin` 解除。
- `panel/test/frontend-render.test.js` / `frontend-actions.test.js` 各 +1 项（已固定渲染、unpin 动作）。
- 桌面端同步：账号表「状态」列显示「已固定 / 使用中·已固定」，账号详情新增「固定状态」一行与「解除固定」按钮（确认框带 503 提示）；未固定时按钮置灰，不再需要记着去命令行 `unpin`。

### 重构（控制台后端拆分：改一处不再牵动全文件）
- **`panel/server.js` 从 801 行拆成 15 个模块**：`server.js` 只剩装配（约 80 行）；`/api/*` 路由进 `panel/lib/routes.js`，状态读模型进 `panel/lib/dashboard.js`，HTTP 细节（token/信封/静态/本机校验）进 `panel/lib/panel-http.js`，另有 `paths / fs-json / cli / events / login-flow / policy-store / usage-logs / state-cache / router-control / account-actions / watchdogs`。**API 契约、前端与桌面端调用完全不变**（契约测试 9 项照旧通过）。
- 路由看门狗与登录窗口看门狗移入 `panel/lib/watchdogs.js`，两个模块级"忙"标记不再散落在 server.js。
- 新增 `panel/test/dashboard-units.test.js`（5 项）：锁住 `pickWindows` 的窗口归类与 `paceFor` 的消耗速度计算。
- **配置 schema 收成一处**：新增 `panel/lib/config-schema.js`（`panel-config.json` / `app-config.json` / `account-policies.json` 的字段形状与校验，纯函数）+ `scripts/check-config-examples.js` 闸门（`npm run config`）；三个 `*.example.json` 与代码字段一漂移就红。
- 删除死代码：`panel/app/MainForm.webview.legacy`（早期 WebView 存档，不参与编译）与从未读取的 `NativeForm._loading` 字段（`dotnet build` 的 CS0414 警告消失）。
- **桌面端 `panel/app/NativeForm.cs`（1324 行）按职责拆成 7 个 partial 文件**：主文件只留字段 + 构造（124 行），其余为 Layout（429）、Render（360）、Actions（173）、Lifecycle（147）、Refresh（137）、Utility（50）。纯搬家——逐行比对原文件 898 行正文完全一致，`dotnet build` 0 error；顺带统一为单 BOM + LF。
- **前端 `panel/public/app.js`（518 行）拆成入口 + 7 个 ES 模块**：`app.mjs` 只做装配（读状态/渲染/事件/轮询）；`modules/format.mjs`（纯格式化）、`api.mjs`（token + fetch）、`dom.mjs`（元素表/toast/弹窗）、`render-overview.mjs`、`render-accounts.mjs`、`render-panels.mjs`（纯 state → HTML）、`actions.mjs`（账号/策略/路由动作）。行为不变：E2E 14/14，id 闸门统计（引用 20 / HTML 14 / 模板 8）不变。
- 新增 `panel/test/frontend-render.test.js`（12 项）与 `panel/test/static-manifest.test.js`（5 项）：前者在 Node 里直接 import `.mjs` 测纯格式化与渲染；后者保证 `panel/public` 每个文件都被生产/ mock 两个 `STATIC` 表登记、`PUBLIC_MODULES` 清单与磁盘一致、`app.mjs` 的 import 路径可解析。
- `scripts/check-syntax.js` 同时校验 `.mjs`；`scripts/check-frontend-ids.js` 扫描全部前端模块；`index.html` 改用 `<script type="module" src="/app.mjs">`。
- **前端动作层改成依赖注入**：`actions.mjs` 不再直接 import DOM 与 api，改由 `initActions()` 注入 `api / query / toast / setBusy / isBusy / confirmModal / promptModal / refresh / refreshManual / getState / schedule`；`app.mjs` 的调用方式与页面行为不变。
- 新增 `panel/test/frontend-actions.test.js`（12 项）：在 Node 里跑完账号动作、备注、策略保存、路由动作、手动刷新的成功 / 取消 / 失败 / 忙碌分支——这些以前只有 E2E 覆盖。
- `check-frontend-ids` 识别注入写法 `query('#id')`，id 闸门引用统计保持 20，没有放松标准。
- **用量统计拆成 7 个模块**：`panel/usage.js` 只留入口缓存（3 分钟 TTL），`panel/lib/usage/` 下分 `paths / threads / accounts / sessions / buckets / collect / index`；`/api/usage` 响应字段不变，旧实现与新实现用同一份假数据对比 `rangeDays=1/7` 输出完全一致。
- 新增 `panel/test/usage-units.test.js`（11 项）：账号清单解析、窗口归属容差、按天/小时聚合、窗口 token/百分点换算、跨账号合并，以及一次临时目录内的完整 collect（含未归属桶）。
- 闸门修正：`.gitignore` 的运行时 `usage/` 改为只锚定仓库根（`/usage/`），避免把 `panel/lib/usage` 源码一起忽略；`scripts/check-syntax.js` 同样只跳过仓库根目录下的运行时目录。

### 重构（可维护性：决策只有一份）
- **决策逻辑从两处收成一处**：`quota-policy.ps1` 里 120 行内联分支全部删除（339 行 → 233 行），改为组装输入 JSON 调 `panel/policy-cli.js decide`；规则只存在于 `panel/policy-core.js`。改动一条规则不再需要"PS1 和 JS 各改一遍"。
- 新增 `panel/lib/policy-config.js`：`panel-config.json` 的默认值与钳位（`minWaitMin` 5–600、`reserveIndex` ≥1）唯一实现，server 与 CLI 共用。
- 新增 `panel/lib/policy-decision.js`：`normalizePolicy → decide` 的单条链，HTTP 试算与脚本执行共用。
- 新增 `panel/policy-cli.js`：决策的进程边界（`--in/--out` 文件模式，避免 PowerShell 控制台编码问题）。
- 新增 `POST /api/policy/preview`：按传入的账号额度干跑一次策略，返回与脚本同源的决策（只读，不改配置）。
- 新增 `panel/test/policy-cli.test.js` + `panel/test/fixtures/policy-decisions.json`：11 个冻结行为场景 + 3 个配置归一化用例，改规则时 fixture 会告诉你哪些场景变了。

### 修复
- `panel/app/NativeForm.cs:1114`：`MessageOf(...)` 未加 `ApiClient.` 前缀导致 **桌面端编译失败**（`error CS0103`）。这是源码里既有的错误——发布用的 exe 由更早的版本编译，源码本身无法构建。现已修正，`dotnet build` 通过。
- **`-DryRun` 保护漏了一个分支**：储备号回切分支原来不判干跑标记，`quota-policy.ps1 -DryRun` 仍可能真的切号。现在所有执行都收口到 `SWITCH` 且 `details.dryRun` 为真时不动账号。
- 储备号回切的 `GUARD` 日志补 `fresh` 标记，不再每轮重复写同一条记录。
- **启动器 VBS 引号错位**：路径脱敏时把 `...quota-policy.ps1""""` 多留了一个引号，计划任务静默以退出码 1 结束、策略看起来"没跑"。已修正为 `"""`，并加 `scripts/check-vbs.js` 闸门防止回归。
- **面板保存策略会抹掉脚本侧配置**：`savePolicy` 以前只按 UI 三项重写 `panel-config.json`，`allowFailover` 等字段会被静默丢弃。现在只归一化三项、保留文件里的其它字段（契约测试断言保存后 `allowFailover` 与未知字段原样保留）。
- **储备号 503 事故（运行时修复已固化为代码）**：策略启用储备号时没有解除储备号的 `emergency-only`，运行时把唯一可用的储备号当成"不可路由"，导致 `503 All managed Codex accounts are temporarily unavailable`。现在切储备号前自动 `account emergency-only <n> off`，回切或切换失败时恢复标记。

### 重构（运维模块可单测）

- `panel/lib/router-control.js`：把路由状态映射、陈旧错误判定、启动项是否需要修复抽成纯函数（`describeRouterStatus` / `nextErrorCache` / `errorMetaOf` / `needsStartRepair`），进程操作留在外层；新增 14 项单测。
- `panel/lib/watchdogs.js`：把“是否该重启路由”“登录窗口是否该杀”抽成纯函数（`nextRouterWatch` / `isTransportError` / `shouldKillLogin`），60 秒 tick 只是调用方；新增 13 项单测。
- 修掉一个真实边界：`app-bind` 配置缺 `port`/`statusPath` 时不再猜着改写启动项，直接报错返回。

### 修复（登录窗口可能被重复打开 + 路由重复启动）

- `POST /api/login` 的单飞判定改为以 launcher 自己写的 `panel-login.state`（90 秒新鲜度）为准，而不是只靠进程探测：进程探测在窗口刚起来/非交互环境下会漏，连点会开出多个登录窗口。
- `startRouter()` 改为幂等：路由已在运行时直接返回当前 PID，不再 spawn 第二个抢端口、覆盖状态文件。
- `POST /api/router rebind` 失败时给出可读消息（以前 `message` 为空，前端 toast 只剩 “HTTP 200”）。
- 测试专用开关 `PANEL_LOGIN_SPAWN=skip`：只写 launcher/state 不弹窗，防止测试在开发机上刷窗口。

### 新增（可维护性护栏）
- 面板动作不再等上游：`POST /api/refresh` 与 `GET /api/state?force=1` 改成“立即返回当前数据 + 后台刷新”（`meta.refreshing` 标记进行中），`refreshState()` single-flight 合并连点；前端 toast 改为「额度刷新已开始（后台进行，几秒后自动更新）」。实测 `limits --json --refresh` 约 **7 秒**，是按钮卡顿的唯一大头（其余三个 CLI 各约 0.4 秒）。
- `panel/test/refresh-async.contract.test.js`（5 项）：用会慢 2.5 秒的假 CLI 锁住新语义——刷新接口 <1.2s 返回、刷新中读状态不阻塞、后台完成后看到新数字、`force=1` 不打上游、连点只触发一次深度查询。（现在 184 项测试）
- `scripts/check-imports.js`（`npm run imports`）：把 ARCHITECTURE 里"lib 依赖方向靠约定"变成机械检查——分层表覆盖后端 28 个、前端 8 个生产模块；下层依赖上层、后端依赖前端、纯模块引入 IO、依赖成环、新模块未登记都会直接失败，自带 10 项单测（现在 184 项测试）。
- `.github/workflows/ci.yml`：push / PR 自动跑「语法 + 编码 + 测试」并在 Windows 上编译桌面端。
- `panel/test/usage.contract.test.js`（11 项）：启动真实 `panel/server.js`，用临时 `CODEX_HOME`（2 个会话文件 + `state_5.sqlite` 的 threads 表）锁住 `/api/usage` 的统计口径——totals/today/days/hours 的累加、`?days` 过滤与 1..14 钳位、无 CLI 时账号归属回落 unknown、扫描前后会话文件字节不变（只读）。
- `package.json` + `npm run verify`：一条命令完成本地验收（无第三方依赖；现在 184 项测试）。
- `scripts/check-syntax.js`：所有 `.js` 过 `node --check`。
- `scripts/check-encodings.js`：强制 `.vbs` = UTF-16LE+BOM、含中文的 `.ps1/.cs` = UTF-8+BOM、JSON 可解析。
- `panel/test/server.contract.test.js`：启动**真实** `panel/server.js`，锁定鉴权、错误码、响应信封、`panel-config.json` 字段名与试算接口（9 项）。
- `panel/test/policy-ps1.test.js`：把真实 `quota-policy.ps1` 复制进临时目录、用假 CLI 跑固定场景，锁住执行层三条行为——切储备号前解除 `emergency-only`、回切后恢复、切换失败回滚恢复，以及 pin 自动解除三条（共 6 项）。
- `scripts/check-vbs.js`：用 cscript 对启动器做纯语法编译检查（替换 `.Run`/`MsgBox` 后不产生真实动作），`npm run verify` 自动跑。
- `scripts/check-frontend-ids.js`：扫描全部前端 ES 模块（`app.mjs` + `modules/*.mjs`）的 `$('id')` / `getElementById` 与 `index.html`、模块模板、`style.css` 的 id 集合，改 id 漏改引用会直接失败；自带 4 项单测。（现在 184 项测试）
- `docs/ARCHITECTURE.md`、`CONTRIBUTING.md`、`.editorconfig`、`.gitattributes`。

### 行为提示
- 日志/面板文案改由 JS 决策核心统一生成：切换类文案由"已切换"变为"切换"，5h 耗尽文案由"即将耗尽（剩余 x%）"变为"额度耗尽"（数值仍附在 reason 里）。语义不变，文本有差异。
- 5h 与 7d 的提前切号阈值改由命名常量表达（`SHORT_PREEMPT_REMAINING_PERCENT = 5`、`WEEKLY_PREEMPT_USED_PERCENT = 97`），数值与旧实现一致。

## [2.0.0] - 2026-10-25

首个公开版本。

### 功能
- 多账号额度轮转策略引擎：`quota-policy.ps1`（5h/7d 窗口判定、储备号、冷却、干跑）。
- 路由看门狗：`ensure-router.ps1`。
- 本地控制台：`panel/server.js` + 原生前端（账号卡片、事件时间线、策略开关、一键登录）。
- 桌面端：WinForms + WebView2 宿主（`panel/app`），含托盘、自动重连、安装器。
- 用量统计：`panel/usage.js`（会话 + SQLite）。
- 策略内核：`panel/policy-core.js` + 32 项单元测试、端到端 mock（`panel/tests`）。

### 说明
- 仓库不含任何凭据、日志、快照与构建产物；首次使用请按 README 生成 `panel-config.json`。

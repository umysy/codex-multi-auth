# 贡献指南

## 快速上手

```powershell
git clone https://github.com/umysy/codex-multi-auth.git
cd codex-multi-auth
npm run verify          # 语法 + 编码 + 单元/契约测试（无第三方依赖，不用 npm install）
```

需要：Windows、Node.js ≥ 20、PowerShell 5.1；改桌面端另需 .NET 8 SDK。

> 开发与使用环境是分开的：仓库只放源码，运行态在 `%USERPROFILE%\.codex\multi-auth`。
> 跑面板用 `npm run dev:panel`（沙箱数据），不要直接 `node panel/server.js`，更不要手改使用环境。详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 提交前必须通过

```powershell
npm run verify
dotnet build panel/app/CodexQuota.csproj -c Release   # 只有改了 panel/app/ 才需要
npm run privacy                                      # 发布前隐私扫描
```

CI 会重复这两步，**红的 PR 不会被合并**。

## 编码规则（最容易踩的坑，务必读）

| 文件 | 编码 | 原因 |
| --- | --- | --- |
| `*.vbs` | UTF-16LE + BOM | `wscript.exe` 不认无 BOM 的 UTF-16 / UTF-8，中文注释会导致脚本无法运行 |
| 含中文的 `*.ps1` / `*.cs` / `*.csproj` | UTF-8 **带 BOM** | Windows PowerShell 5.1 与 csc 默认按 ANSI 解码，无 BOM 会乱码 |
| 其他（`.js/.json/.md/.yml`） | UTF-8 无 BOM，LF 换行 | 跨平台一致性 |
| `*.png` 等 | 二进制 | 不要用文本编辑器打开保存 |

`.editorconfig` 已按扩展名设好默认值（VS Code / VS 会自动遵守）；
`scripts/check-encodings.js` 会在 CI 里强制校验，**先在本地跑一次**比等 CI 快。

## 三条铁律

### 1. 决策规则只写在 `panel/policy-core.js`

规则只有一份实现：`decide()` 在 `panel/policy-core.js`，PS1 通过 `panel/policy-cli.js` 调它，
面板通过 `POST /api/policy/preview` 调它。**不要再往 `quota-policy.ps1` 里写判断分支**。

改规则的流程：

1. 改 `panel/policy-core.js` 的 `decide()`；
2. 改 `panel/test/policy-core.test.js`（纯函数单测）；
3. 改 `panel/test/fixtures/policy-decisions.json` 里受影响的场景期望值（改完跑 `npm test`，
   它会告诉你哪些场景的行为变了——有差异就必须解释清楚）；
4. 只有新增了"要对账号执行的动作"时，才去 `quota-policy.ps1` 的 `switch ($action)` 加执行分支。

### 2. 配置默认值/钳位只写在 `panel/lib/policy-config.js`

面板保存配置和脚本读配置都经过 `normalizePolicy()`。新增字段时：在 `policy-config.js` 加默认值与钳位 →
更新 `*.example.json` → 在 `panel/test/policy-cli.test.js` 的 `normalize-config` 用例里加一条。

### 3. API 字段名是三端契约

`server.js` 写、`public/app.mjs` 与 `public/modules/*.mjs` 读、`app/Api.cs` 读。**改名 = 破坏**，且前端不会报错，
只会显示空白。加字段可以，删/改字段请同步三端 + `panel/test/server.contract.test.js`。

## 绝不提交

- `openai-codex-accounts*.json`、`auth.json`：里面是 refresh/access token；
- 任何 `*.log`、`*.state`、`panel-cache.json`：含账号邮箱、额度、本机路径；
- `versions/`、`usage/`、`app-bind/`、`cache/`、`tmp/`：运行时数据；
- 构建产物：`panel/app/bin|obj`、`*.exe`。

`.gitignore` 已覆盖，但 **`git add -f` 能绕过**，所以提交前请扫一眼
`git diff --cached --stat`。

## 提交信息

```
<范围>: <一句话说明>

<可选：为什么这么改 / 影响面 / 验证方式>
```

范围用路径或模块名：`panel:`、`desktop:`、`policy:`、`docs:`、`ci:`。
示例：`policy: 储备号回切增加 60s 冷却`。

## 报告问题

请附：Windows 版本、Node 版本、`panel-config.json`（**删掉账号相关字段**）、
`quota-policy.log` 尾部 20 行、以及复现步骤。

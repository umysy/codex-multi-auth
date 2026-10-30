param(
  [switch]$AutoStart,
  [switch]$NoDesktop
)

$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $PSScriptRoot
$panel = Join-Path $base "panel"
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$cfg = Join-Path $base "panel-config.json"

Write-Host ""
Write-Host "Codex Quota Panel · 安装" -ForegroundColor Cyan
Write-Host ("=" * 52)

# 1. 依赖检查
$missing = @()
if (-not (Test-Path $node)) { $missing += "Node.js ($node)" }
if (-not (Test-Path (Join-Path $panel "server.js"))) { $missing += "panel\server.js" }
foreach ($f in @("index.html", "app.mjs", "style.css")) {
  if (-not (Test-Path (Join-Path $panel "public\$f"))) { $missing += "panel\public\$f" }
}
if (-not (Test-Path (Join-Path $env:APPDATA "npm\node_modules\codex-multi-auth\scripts\codex-multi-auth.js"))) {
  $missing += "codex-multi-auth (npm i -g codex-multi-auth)"
}
if ($missing.Count -gt 0) {
  Write-Host "缺少依赖：" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "[ok] 依赖齐全" -ForegroundColor Green

# 2. 配置文件
if (-not (Test-Path $cfg)) {
  @{ autoSwitch = $true; minWaitMin = 60; reserveIndex = 1 } | ConvertTo-Json | Set-Content -LiteralPath $cfg -Encoding utf8
  Write-Host "[ok] 写入默认策略配置 panel-config.json" -ForegroundColor Green
} else {
  Write-Host "[ok] 策略配置已存在，保持不变" -ForegroundColor Green
}

# 3. 快捷方式
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$ws = New-Object -ComObject WScript.Shell

$appExe = Join-Path $panel "desktop\CodexQuota.exe"

function New-PanelShortcut([string]$linkPath) {
  $sc = $ws.CreateShortcut($linkPath)
  if (Test-Path $appExe) {
    # 桌面版优先（原生窗口，自动拉起服务）
    $sc.TargetPath = $appExe
    $sc.Arguments = ""
    $sc.WorkingDirectory = (Split-Path $appExe)
    $sc.IconLocation = "$appExe,0"
    $sc.Description = "Codex 多账号额度控制台（桌面版）"
  } else {
    $sc.TargetPath = $wscript
    $sc.Arguments = "`"$(Join-Path $panel 'start-panel.vbs')`""
    $sc.WorkingDirectory = $panel
    if (Test-Path $edge) { $sc.IconLocation = "$edge,0" }
    $sc.Description = "Codex 多账号额度控制台（网页版）"
  }
  $sc.WindowStyle = 1
  $sc.Save()
}

function New-WebPanelShortcut([string]$linkPath) {
  $sc = $ws.CreateShortcut($linkPath)
  $sc.TargetPath = $wscript
  $sc.Arguments = "`"$(Join-Path $panel 'start-panel.vbs')`""
  $sc.WorkingDirectory = $panel
  if (Test-Path $edge) { $sc.IconLocation = "$edge,0" }
  $sc.Description = "Codex 额度面板（网页版，兜底）"
  $sc.WindowStyle = 1
  $sc.Save()
}

$desktop = [Environment]::GetFolderPath("Desktop")
if (-not $NoDesktop) {
  New-PanelShortcut (Join-Path $desktop "Codex 额度面板.lnk")
  Write-Host "[ok] 桌面快捷方式：Codex 额度面板（桌面版优先）" -ForegroundColor Green
  New-WebPanelShortcut (Join-Path $desktop "Codex 额度面板（网页版）.lnk")
  Write-Host "[ok] 桌面快捷方式：Codex 额度面板（网页版）" -ForegroundColor Green
}
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-PanelShortcut (Join-Path $startMenu "Codex 额度面板.lnk")
# 英文名用于 Windows 搜索（搜 codex / quota 都能命中）
New-PanelShortcut (Join-Path $startMenu "Codex Quota Panel.lnk")
New-WebPanelShortcut (Join-Path $startMenu "Codex 额度面板（网页版）.lnk")
Write-Host "[ok] 开始菜单快捷方式（桌面版 / 英文名 / 网页版），可被系统搜索" -ForegroundColor Green

# App Paths：Win+R 输入 CodexQuota 直接启动
if (Test-Path $appExe) {
  $ap = "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\CodexQuota.exe"
  if (-not (Test-Path $ap)) { New-Item -Path $ap -Force | Out-Null }
  Set-ItemProperty -Path $ap -Name "(default)" -Value $appExe
  Set-ItemProperty -Path $ap -Name "Path" -Value (Split-Path $appExe)
  Write-Host "[ok] 已注册 App Paths（Win+R → CodexQuota）" -ForegroundColor Green
}

# 4. 开机自启默认关闭（用户要求）；如旧版本留下过自启项则清掉
$startup = [Environment]::GetFolderPath("Startup")
$autoLink = Join-Path $startup "Codex Quota Panel Server.lnk"
if ($AutoStart) {
  $sc = $ws.CreateShortcut($autoLink)
  $sc.TargetPath = $wscript
  $sc.Arguments = "`"$(Join-Path $panel 'start-server.vbs')`""
  $sc.WorkingDirectory = $panel
  $sc.Description = "Codex Quota Panel 后台服务"
  $sc.Save()
  Write-Host "[ok] 已设置开机自启（后台服务）" -ForegroundColor Green
} elseif (Test-Path $autoLink) {
  Remove-Item -LiteralPath $autoLink -Force
  Write-Host "[ok] 已移除旧的开机自启项（默认不自启）" -ForegroundColor Green
}

# 5. 自检
Write-Host ""
Write-Host "启动器自检：" -ForegroundColor Cyan
$listener = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue
if ($listener) { Write-Host "  [i] 面板服务已在运行 (PID $($listener[0].OwningProcess))" -ForegroundColor Yellow }
else { Write-Host "  [i] 面板服务当前未运行（双击快捷方式即可）" -ForegroundColor Gray }

Write-Host ""
Write-Host "安装完成。双击「Codex 额度面板」即可打开。" -ForegroundColor Green
Write-Host "策略脚本每 5 分钟读取 panel-config.json，所以面板里改阈值会立刻生效。" -ForegroundColor DarkGray

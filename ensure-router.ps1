$ErrorActionPreference = "SilentlyContinue"
$root = $PSScriptRoot
$log = Join-Path $root "ensure-router.log"
$vbs = Join-Path $root "run-router.vbs"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"

$bindPath = Join-Path $root "app-bind\runtime-rotation-app-bind.json"
$port = 61908
try {
  $bind = Get-Content -LiteralPath $bindPath -Raw | ConvertFrom-Json
  if ($bind -and $bind.port) { $port = [int]$bind.port }
} catch { }

# 1) 只要还有本机 router 进程（端口一致）就什么都不做
$router = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*codex-app-router.js*' -and $_.CommandLine -like "*--port $port*"
}
if ($router) { return }

# 2) 端口已被别的进程占着也算活着（避免重复拉起）
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) { return }

# 2026-10-29：本机上 Win32_Process.Create（WMI）拉起的进程会被静默拦掉——返回 rc=0，但 wscript 连第一行都不执行，
# 于是这里每 5 分钟写一条"已重启"，路由却从 05:48 一直停到 07:39（Codex 全程无路由）。
# 改为直接启动：本脚本由计划任务拉起，不属于任何前台应用的进程树，子进程在任务结束后照常存活。
# 启动后等端口真的监听再记日志，日志只写事实。
$started = $false
try {
  Start-Process -FilePath $wscript -ArgumentList '//B', ('"' + $vbs + '"') -WindowStyle Hidden -ErrorAction Stop
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $started = $true; break }
  }
} catch { }
$result = if ($started) { "listening after " + ($i + 1) + "s" } else { "NOT listening after 30s" }
$msg = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  router down (port=$port) -> restart via hidden vbs: " + $result
Add-Content -LiteralPath $log -Value $msg -Encoding utf8
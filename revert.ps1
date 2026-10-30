param([Parameter(Mandatory=$true)][string]$Id)
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
$store = Join-Path $root 'versions'
$src   = Join-Path $store $Id
if (-not (Test-Path $src)) { throw "snapshot not found: $src" }
if (Get-Process CodexQuota -ErrorAction SilentlyContinue) {
  throw "Codex Quota 面板正在运行。请先关闭面板（关闭 = 退出），再执行回滚。"
}
$listening = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue
if ($listening) { throw "面板服务仍监听 8766（PID " + $listening[0].OwningProcess + "），请先关闭面板。" }

# 1) 校验哈希
$manifest = Join-Path $src 'manifest.sha256'
$bad = @()
foreach ($line in (Get-Content $manifest -Encoding ASCII)) {
  if (-not $line.Trim()) { continue }
  $hash, $rel = $line -split '  ', 2
  $p = Join-Path $src ($rel -replace '/','\')
  if (-not (Test-Path $p)) { $bad += "missing $rel"; continue }
  $actual = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $hash) { $bad += "hash-mismatch $rel" }
}
if ($bad.Count -gt 0) { throw ("快照校验失败，拒绝回滚：`n" + ($bad -join "`n")) }

# 2) 先给当前状态拍一张快照（崩溃也能手工恢复）
& (Join-Path $root 'snapshot.ps1') -Note "pre-revert to $Id"
$pre = (Get-ChildItem $store -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name

# 3) 覆盖回来（panel 全量 + 脚本配置）
robocopy (Join-Path $src 'panel') (Join-Path $root 'panel') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy revert failed: $LASTEXITCODE" }
foreach ($f in @('quota-policy.ps1','ensure-router.ps1','panel-config.json','account-policies.json')) {
  $from = Join-Path $src $f
  if (Test-Path $from) { Copy-Item $from (Join-Path $root $f) -Force }
}
Write-Output "REVERT OK  restored=$Id  pre-revert-snapshot=$pre"
Write-Output "提示：代码已回到该快照；运行时数据（usage/、account-policies、日志）未回滚。"
param([switch]$DryRun)

# 单飞：计划任务的 IgnoreNew 管不住手动 -File 运行，加本地互斥防止两个实例互相覆盖
# 单飞锁名可被 CMA_POLICY_MUTEX 覆盖：测试用独立名字，避免和真机计划任务抢同一把锁
$__mutexName = if ($env:CMA_POLICY_MUTEX) { $env:CMA_POLICY_MUTEX } else { 'Local\CodexQuotaPolicy-SingleFlight' }
$__mutex = New-Object System.Threading.Mutex($false, $__mutexName)
if (-not $__mutex.WaitOne(0)) { exit 0 }

$ErrorActionPreference = "Continue"
$root     = $PSScriptRoot
if (-not $env:CODEX_HOME -and $root -ne (Join-Path $env:USERPROFILE '.codex\multi-auth')) {
  Write-Error 'DEVELOPMENT_ENV_REQUIRED: use an isolated CODEX_HOME; repository scripts must not operate on installed accounts.'
  exit 1
}
$cma      = Join-Path $env:APPDATA "npm\codex-multi-auth.cmd"
$log      = Join-Path $root "quota-policy.log"
$stateF   = Join-Path $root "quota-policy.state.json"
$cfgF     = Join-Path $root "panel-config.json"
$decider  = Join-Path $root "panel\policy-cli.js"
$runId = [guid]::NewGuid().ToString('N').Substring(0,16)
$now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

# 本脚本只做三件事：① 取数（调 codex-multi-auth）② 执行动作（Try-Switch）③ 落盘（state/log）。
# 所有"该不该切号"的判断都在 panel/policy-cli.js（→ panel/lib/policy-decision.js
# → panel/policy-core.js 的纯函数 decide）。改规则只改那一处，别再往这里加分支。
$nodeExe = "node.exe"
try { $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source } catch { }

# ---- policy config：原始读取 --------------------------------------------------
# 字段名 / 默认值 / 钳位规则的唯一权威是 panel/lib/policy-config.js（policy-cli 调用它）。
# 这里刻意不做钳位，避免 PS 和 JS 各有一套"归一化"。
$cfgError = $false
$cfg = [pscustomobject]@{ autoSwitch = $true; minWaitMin = 60; reserveIndex = 1; allowFailover = $true; rotation = $null }
if (Test-Path $cfgF) {
  try {
    $raw = Get-Content -LiteralPath $cfgF -Raw | ConvertFrom-Json
    if ($null -ne $raw.autoSwitch) { $cfg.autoSwitch = [bool]$raw.autoSwitch }
    if ($null -ne $raw.allowFailover) { $cfg.allowFailover = [bool]$raw.allowFailover }
    if ($null -ne $raw.minWaitMin) { $cfg.minWaitMin = $raw.minWaitMin }
    if ($null -ne $raw.reserveIndex) { $cfg.reserveIndex = $raw.reserveIndex }
    if ($null -ne $raw.rotation) { $cfg.rotation = $raw.rotation }
  } catch { $cfgError = $true }
}

# ---- persistent state -------------------------------------------------------
$state = @{ lastSwitchAtMs = 0; lastStatus = ""; lastStatusAtMs = 0; lastWaitLogAtMs = 0; from = 0; to = 0; policyPaused = @(); lastWaitKey = ""; lastRunAtMs = 0; tickCount = 0; nextLogAtMs = 0; exhaustedPaused = @(); pauseOwnership = @{}; runtimeSeen = @{}; reserveReleased = 0 }
if (Test-Path $stateF) {
  try {
    $p = Get-Content -LiteralPath $stateF -Raw | ConvertFrom-Json
    if ($null -ne $p.lastSwitchAtMs) { $state.lastSwitchAtMs = [int64]$p.lastSwitchAtMs }
    if ($null -ne $p.lastStatus -and $p.lastStatus) { $state.lastStatus = [string]$p.lastStatus }
    if ($null -ne $p.lastStatusAtMs) { $state.lastStatusAtMs = [int64]$p.lastStatusAtMs }
    if ($null -ne $p.lastWaitLogAtMs) { $state.lastWaitLogAtMs = [int64]$p.lastWaitLogAtMs }
    if ($null -ne $p.from) { $state.from = [int]$p.from }
    if ($null -ne $p.to) { $state.to = [int]$p.to }
    if ($null -ne $p.policyPaused) { $state.policyPaused = @($p.policyPaused | ForEach-Object { [int]$_ }) }
    if ($null -ne $p.lastWaitKey) { $state.lastWaitKey = [string]$p.lastWaitKey }
    if ($null -ne $p.lastRunAtMs) { $state.lastRunAtMs = [int64]$p.lastRunAtMs }
    if ($null -ne $p.tickCount) { $state.tickCount = [int]$p.tickCount }
    if ($null -ne $p.nextLogAtMs) { $state.nextLogAtMs = [int64]$p.nextLogAtMs }
    if ($null -ne $p.exhaustedPaused) { $state.exhaustedPaused = @($p.exhaustedPaused | ForEach-Object { [int]$_ }) }
    if ($null -ne $p.pauseOwnership) { foreach ($property in $p.pauseOwnership.PSObject.Properties) { $state.pauseOwnership[$property.Name] = [bool]$property.Value } }
    # 运行时原因"首次看到"的时间（policy-core 判断冷却/容量是否已过期用）
    if ($null -ne $p.runtimeSeen) { foreach ($property in $p.runtimeSeen.PSObject.Properties) { $state.runtimeSeen[$property.Name] = [int64]$property.Value } }
    # 本策略为启用储备号而解除过 emergency-only 的账号（1 基；0 = 没有）
    if ($null -ne $p.reserveReleased) { $state.reserveReleased = [int]$p.reserveReleased }
  } catch {
    # P0：读失败时不能把 lastSwitchAtMs 回落 0，否则 600 秒护栏直接失效
    $state.lastSwitchAtMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    Add-Content -LiteralPath $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  ERROR 读取 state 失败：" + $_.Exception.Message + "（已把切号护栏基线设为当前时间）") -Encoding utf8
  }
}

function Log([string]$msg) {
  $safe = $msg -replace '[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[EMAIL]' -replace 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[TOKEN]' -replace '(?i)(access_token|refresh_token|identityToken|apiKey)["\s:=]+[^\s,}]+', '[SECRET]' -replace '(?i)[A-Z]:[\\/][^\r\n]*', '[PATH]'
  $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $safe + ' run=' + $runId
  for ($i = 0; $i -lt 3; $i++) {
    try {
      if ((Test-Path $log) -and (Get-Item $log).Length -gt 2097152) {
        $stream = [IO.File]::OpenRead($log)
        try { [void]$stream.Seek(-1048576, [IO.SeekOrigin]::End); $tail = New-Object byte[] 1048576; [void]$stream.Read($tail,0,$tail.Length) } finally { $stream.Dispose() }
        [IO.File]::WriteAllBytes($log, $tail)
      }
      Add-Content -LiteralPath $log -Value $line -Encoding utf8 -ErrorAction Stop; return
    } catch { Start-Sleep -Milliseconds 80 }
  }
}
function Finish([string]$status, [string]$msg, [bool]$write) {
  if (-not $now) { $script:now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
  if ($write) {
    foreach ($ln in ($msg -split "`r?`n")) { if ($ln.Trim()) { Log $ln.Trim() } }
  }
  $state.lastStatus = $status
  $state.runId = $runId
  $state.errorCode = if ($status -in @('ERROR','SWITCH-FAILED')) { if ($msg -match '\b([A-Z][A-Z_]{3,})\b' -and $Matches[1] -ne 'ERROR') { $Matches[1] } else { 'POLICY_EXECUTION_FAILED' } } else { $null }
  $state.lastStatusAtMs = $now
  $state.lastRunAtMs = $now
  $state.tickCount = [int]$state.tickCount + 1
  if ($status -ne "WAIT") { $state.nextLogAtMs = 0 }
  if ($status -eq "WAIT" -and $write) { $state.lastWaitLogAtMs = $now }
  # Codex 侧栏显示的账号名跟随 activeIndex（面板没开时也同步）；尽力而为，失败不影响策略
  $labelSync = Join-Path $root 'panel\sync-label.js'
  if (-not $DryRun -and (Test-Path -LiteralPath $labelSync)) { try { & $nodeExe $labelSync 2>&1 | Out-Null } catch { } }
  # P0：原子写（先写临时文件再改名），避免面板读到半截 JSON
  $json = $state | ConvertTo-Json -Depth 10
  $tmp = $stateF + ".tmp"
  # Scheduler invocations stay successful after a handled policy error. The structured state/log carries the failure;
  # a non-zero task result would make Task Scheduler retry and overlap the next run.
  $exitCode = 0
  try {
    [IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path $stateF) {
      # File.Replace is not reliable on every PowerShell/.NET combination (notably
      # when the target was opened by the panel). Move with overwrite keeps the
      # write path portable; the old file is still untouched until this point.
      Move-Item -LiteralPath $tmp -Destination $stateF -Force -ErrorAction Stop
    } else { [IO.File]::Move($tmp, $stateF) }
  } catch { Log ('ERROR STATE_WRITE_FAILED ' + $_.Exception.Message); $exitCode = 2 }
  finally {
    if ($null -ne $script:__sharedLockStream) {
      try { $script:__sharedLockStream.Dispose() } catch { }
      try { Remove-Item -LiteralPath $sharedLockPath -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
  exit $exitCode
}

# CLI 的 stdout 可能混入警告/提示行（22:12 真实事故：account policy list 输出前多一行，
# ConvertFrom-Json 直接失败，策略整轮 ERROR 空转）。统一先截出 JSON 再解析。
function Get-JsonText([string]$text) {
  if ($null -eq $text) { return $text }
  $a = $text.IndexOf('{')
  $b = $text.LastIndexOf('}')
  if ($a -lt 0 -or $b -le $a) { return $text }
  return $text.Substring($a, $b - $a + 1)
}

# 面板手动 pause/switch/unpin 与策略的多步切号必须共享同一把跨进程锁。
$sharedLockPath = Join-Path $root 'account-operations.lock'
$script:__sharedLockStream = $null
# ---- 原生 CLI 调用（统一 UTF-8 解码）----------------------------------------
# 事故（2026-10-26 23:0x）：计划任务里的策略每轮都报 "account policy list JSON 解析失败"。
# 根因不是 CLI 输出脏，而是解码：无控制台进程里 [Console]::OutputEncoding 是 936，
# `& $cma ... | Out-String` 把 CLI 的 UTF-8 中文解成乱码，尾字节还可能吃掉 JSON 的引号。
# 所以所有需要读输出的调用都走 cmd.exe + 显式 StandardOutputEncoding=UTF8。
function Capture-Cli([string[]]$CliArgs, [int]$TimeoutMs = 60000) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c ""' + $cma + '" ' + (($CliArgs | ForEach-Object { [string]$_ }) -join ' ') + '"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $psi.CreateNoWindow = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  try { [void]$proc.Start() } catch { return @{ code = -1; out = ('启动 CLI 失败：' + $_.Exception.Message) } }
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($TimeoutMs)) {
    try { $proc.Kill() } catch { }
    return @{ code = -1; out = ('CLI 超时（' + $TimeoutMs + 'ms）') }
  }
  $proc.WaitForExit()
  $text = $outTask.Result
  $err = $errTask.Result
  if ($err) { $text = $text + [char]10 + $err }
  return @{ code = $proc.ExitCode; out = $text }
}

function Try-SharedLock {
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    try {
      $script:__sharedLockStream = New-Object System.IO.FileStream($sharedLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @{ pid = $PID; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } -Compress))
      $script:__sharedLockStream.Write($bytes, 0, $bytes.Length)
      $script:__sharedLockStream.Flush()
      return $true
    } catch {
      if ($attempt -eq 0) {
        try {
          $owner = Get-Content -LiteralPath $sharedLockPath -Raw -ErrorAction Stop | ConvertFrom-Json
          if ([int]$owner.pid -gt 0 -and -not (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $sharedLockPath -Force -ErrorAction Stop; continue }
        } catch { }
      }
      return $false
    }
  }
  return $false
}

if (-not (Try-SharedLock)) {
  try { Add-Content -LiteralPath $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  WAIT  账号操作正在进行，本轮跳过") -Encoding utf8 } catch { }
  try { $__mutex.ReleaseMutex() } catch { }
  exit 0
}

# 执行一次真实切号：unpin -> unpause 目标 -> switch -> 校验 -> 失败回滚
# $pauseFrom=false 时保留 from 账号可用（冷却/网络抖动恢复后运行时能直接回切）
function Invoke-CmaChecked([string[]]$CliArgs) {
  $res = Capture-Cli $CliArgs 60000
  $out = $res.out
  $code = $res.code
  return @{ ok = ($code -eq 0); code = $code; out = $out }
}
function Invoke-CmaRetry([string[]]$CliArgs, [int]$Attempts = 3) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $result = Invoke-CmaChecked $CliArgs
    if ($result.ok) { return $result }
    if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds (250 * $attempt) }
  }
  return $result
}

function Try-Switch([int]$fromIdx, [int]$toIdx, [string]$why, [bool]$pauseFrom = $true) {
  $fromNo = $fromIdx + 1
  $toNo   = $toIdx + 1
  $fromWasPaused = @($pausedIdx) -contains $fromIdx
  $toWasPaused = @($pausedIdx) -contains $toIdx
  $unpin = Invoke-CmaRetry @('unpin')
  if (-not $unpin.ok) { Log ("ERROR unpin 失败（退出码 " + $unpin.code + "）：" + $unpin.out.Trim()); return $false }
  $unpause = Invoke-CmaChecked @('account', 'unpause', [string]$toNo)
  if (-not $unpause.ok) { Log ("ERROR 目标账号" + $toNo + " 解除暂停失败：" + $unpause.out.Trim()); return $false }
  $sw = Invoke-CmaChecked @('switch', [string]$toNo)
  if (-not $sw.ok) { Log ("ERROR switch " + $toNo + " 失败（退出码 " + $sw.code + "）：" + $sw.out.Trim()) }
  Start-Sleep -Milliseconds 350
  $ok = $false
  for ($k = 0; $k -lt 6; $k++) {
    try {
      $verify = ((Get-JsonText (Capture-Cli @('status','--json') 60000).out) | ConvertFrom-Json)
      if ([int]$verify.activeIndex -eq $toIdx) { $ok = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  if (-not $ok) {
    if ($toWasPaused) { [void](Invoke-CmaChecked @('account', 'pause', [string]$toNo)) }
    else { [void](Invoke-CmaChecked @('account', 'unpause', [string]$toNo)) }
    if ($fromWasPaused) { [void](Invoke-CmaChecked @('account', 'pause', [string]$fromNo)) }
    else { [void](Invoke-CmaChecked @('account', 'unpause', [string]$fromNo)) }
    return $false
  }
  # switch 命令会把目标账号写进 pinnedAccountIndex（钉住）；自动模式不需要钉住，切完立刻解除
  $cleanup = Invoke-CmaRetry @('unpin')
  if (-not $cleanup.ok) {
    Log ("ERROR 切号成功但解除 pin 失败（退出码 " + $cleanup.code + "）：" + $cleanup.out.Trim())
    # A successful switch followed by a stale pin is a direct 503 risk. Make a
    # final best-effort cleanup before reporting failure; the next policy tick
    # will also fail closed instead of silently accepting the pinned target.
    Start-Sleep -Milliseconds 500
    [void](Invoke-CmaRetry @('unpin'))
    return $false
  }
  if ($pauseFrom) {
    $paused = Invoke-CmaChecked @('account', 'pause', [string]$fromNo)
    if (-not $paused.ok) { Log 'ERROR SOURCE_PAUSE_FAILED'; return $false }
    if ($cfg.rotation) { $state.pauseOwnership[[string]$policyByIndex[[string]$fromIdx].accountKey] = $true }
    $state.policyPaused = @(@(($state.policyPaused + @($fromNo)) | Sort-Object -Unique) | Where-Object { $_ -ne $toNo })
  } else {
    # 仍有额度的账号不暂停：暂停它等于把运行时唯一的即时故障转移目标锁死（网络抖动时就 503）
    $state.policyPaused = @(@($state.policyPaused) | Where-Object { ($_ -ne $fromNo) -and ($_ -ne $toNo) })
    Log ("KEEP 账号" + $fromNo + " 仍有额度，保持可用（作为运行时即时故障转移目标）")
  }
  $state.lastSwitchAtMs = $now
  $state.from = $fromNo
  $state.to = $toNo
  if ($cfg.rotation) { $state.pauseOwnership.Remove([string]$policyByIndex[[string]$toIdx].accountKey) }
  return $true
}

# ---- 带超时的 CLI 调用 -------------------------------------------------------
# 事故：某次 limits --refresh 卡住不返回，进程一直占着互斥体；之后每 5 分钟的策略
# 运行都 WaitOne 失败直接 exit 0 —— 策略静默停摆，外面只看到"一直 503"。
# 所以最慢的那次上游查询必须带超时：超时就杀掉子进程、按失败处理并释放锁。
function Invoke-CliTimed([string[]]$CliArgs, [int]$TimeoutMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $cma
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $psi.Arguments = ($CliArgs -join ' ')
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  try { [void]$proc.Start() } catch { return @{ ok = $false; code = -1; out = ''; err = ('启动 CLI 失败：' + $_.Exception.Message) } }
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit($TimeoutMs)) {
    try { $proc.Kill() } catch { }
    return @{ ok = $false; code = -1; out = ''; err = ('CLI 超时 ' + $TimeoutMs + 'ms：' + ($CliArgs -join ' ')) }
  }
  $out = ''
  $err = ''
  try { $out = $outTask.Result } catch { }
  try { $err = $errTask.Result } catch { }
  $code = -1
  try { $code = $proc.ExitCode } catch { }
  $proc.Dispose()
  return @{ ok = ($code -eq 0); code = $code; out = $out; err = $err }
}
function Invoke-CliRetry([string[]]$CliArgs, [int]$TimeoutMs = 60000, [int]$Attempts = 3) {
  $last = @{ ok = $false; code = -1; out = ''; err = '' }
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $last = Invoke-CliTimed $CliArgs $TimeoutMs
    if ($last.ok) { return $last }
    if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds ([math]::Min(4000, 250 * [math]::Pow(2, $attempt - 1))) }
  }
  return $last
}

# ---- 取数 -------------------------------------------------------------------
if ($cfgError) { Finish 'ERROR' 'ERROR POLICY_CONFIG_INVALID 配置损坏，已停止执行，未覆盖配置' $true }
# 注意：`why-selected` 返回的是"按评分最优的候选"，不等于路由当前使用的账号；
# 当前账号必须取 `status --json` 的 activeIndex，否则一旦候选用尽就会误判为"没有选中账号"。
$statusRes = Invoke-CliRetry @('status','--json') 60000 3
if (-not $statusRes.ok) { Finish 'ERROR' ('ERROR status 查询失败（重试 3 次）: ' + $statusRes.err.Trim()) $true }
$stText = $statusRes.out
try { $statusJson = (Get-JsonText $stText) | ConvertFrom-Json } catch { Finish "ERROR" "ERROR status 解析失败" $true }
$cur = [int]$statusJson.activeIndex
$acctCount = [int]$statusJson.accountCount
if ($acctCount -le 0) { Finish "ERROR" "ERROR 账号池为空" $true }
if ($cur -lt 0 -or $cur -ge $acctCount) { Finish "ERROR" ("ERROR activeIndex 异常: " + $cur + "（账号数 " + $acctCount + "）") $true }
$pinnedIdx = $null
if ($null -ne $statusJson.pinnedAccountIndex) { $pinnedIdx = [int]$statusJson.pinnedAccountIndex }
# 额度只读缓存，不再 --refresh：limits --refresh 会给每个账号发一条真实请求（约 5k token），
# 每 5 分钟一次就是一天上千条。缓存只在用户点「刷新额度」时探测更新；路由在用的账号则由
# 路由按真实请求的响应头写进 live-quota.json（CLI 补丁 v4），比缓存新就用它。
# 没在用的账号额度不会变少，只会重置——重置时刻在快照里，policy-core 会按 resetAtMs 处理。
$limRes = Invoke-CliRetry @('limits', '--json') 60000 3
if (-not $limRes.ok) { Finish "ERROR" ("ERROR limits 读取失败（重试 3 次）(" + $limRes.err.Trim() + "）") $true }
$limText = $limRes.out
try { $lim = (Get-JsonText $limText) | ConvertFrom-Json } catch { Finish "ERROR" "ERROR limits 解析失败" $true }
$liveById = @{}
try {
  $liveRaw = Get-Content -LiteralPath (Join-Path $root 'live-quota.json') -Raw | ConvertFrom-Json
  foreach ($p in @($liveRaw.byAccountId.PSObject.Properties)) { $liveById[$p.Name] = $p.Value }
} catch { }
$accountIdByIndex = @{}
try {
  $store = Get-Content -LiteralPath (Join-Path $root 'openai-codex-accounts.json') -Raw | ConvertFrom-Json
  $i = 0
  foreach ($acc in @($store.accounts)) { $accountIdByIndex[[string]$i] = [string]$acc.accountId; $i++ }
} catch { }
function Merge-LiveWindow($base, $live) {
  if (($null -eq $live) -or ($null -eq $live.usedPercent)) { return $base }
  $out = [ordered]@{}
  if ($null -ne $base) { foreach ($p in $base.PSObject.Properties) { $out[$p.Name] = $p.Value } }
  foreach ($k in @('usedPercent', 'windowMinutes', 'resetAtMs')) { if ($null -ne $live.$k) { $out[$k] = $live.$k } }
  return [pscustomobject]$out
}
function Merge-LiveQuota($probed, $live) {
  if ($null -eq $live) { return $probed }
  $probedAt = 0
  if (($null -ne $probed) -and ($null -ne $probed.updatedAt)) { $probedAt = [int64]$probed.updatedAt }
  if ([int64]$live.updatedAt -le $probedAt) { return $probed }
  $out = [ordered]@{}
  if ($null -ne $probed) { foreach ($p in $probed.PSObject.Properties) { $out[$p.Name] = $p.Value } }
  $out.updatedAt = [int64]$live.updatedAt
  if ($null -ne $live.status) { $out.status = $live.status }
  $out.primary = Merge-LiveWindow $probed.primary $live.primary
  $out.secondary = Merge-LiveWindow $probed.secondary $live.secondary
  return [pscustomobject]$out
}
$quotaByIndex = @{}
$limCount = 0
# ConvertTo-Json 只接受字符串键的字典：这里的键必须是字符串（JS 侧 toIndexMap 会转回数字）
foreach ($a in $lim.accounts) {
  $key = [string][int]$a.index
  $accountId = $accountIdByIndex[$key]
  $live = $null
  if ($accountId -and $liveById.ContainsKey($accountId)) { $live = $liveById[$accountId] }
  $quotaByIndex[$key] = Merge-LiveQuota $a.quota $live
  $limCount++
}
if ($limCount -gt $acctCount) { $acctCount = $limCount }
# 台账时间取在慢 CLI 之后，避免面板"上次运行"比实际早 8~26 秒
$now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

# ---- 运行时信号：额度缓存比真实限流慢，运行时自己知道得更早 -------------------
# 读 runtime-observability.json（10 分钟内有效）：运行时已把某账号标成 rate-limited /
# quota-exhausted 时，直接按"不可用"处理，避免等额度缓存刷新（否则就是几分钟 503 空窗）。
$HARD_RT = @('rate-limited', 'quota-exhausted', 'model-capacity', 'model_capacity', 'capacity-exhausted', 'capacity-insufficient', 'capacity-unavailable', 'auth-invalid', 'token-expired', 'token-revoked', 'unauthorized')
# 运行时临时冷却（网络/服务端抖动）同样是"立刻不可用"：等 5 分钟缓存刷新就是 503 空窗
$COOLDOWN_RT_PREFIX = 'cooling-down'
$runtimeBlocked = @{}
$rtResetNote = ""
$obsPath = Join-Path $root 'runtime-observability.json'
if (Test-Path -LiteralPath $obsPath) {
  try {
    $obs = Get-Content -LiteralPath $obsPath -Raw | ConvertFrom-Json
    $obsAt = [int64]$obs.updatedAt
    # Runtime observations are request-level truth, but only while fresh. A stale
    # file must not keep an account quarantined after the upstream recovered.
    if (($obsAt -gt 0) -and (($now - $obsAt) -ge 0) -and (($now - $obsAt) -le 120000)) {
      $skipReasons = @{}
      foreach ($p in @($obs.accountSkipReasons.PSObject.Properties)) { $skipReasons[[int]$p.Name] = ([string]$p.Value).ToLower() }
      if ($null -ne $obs.lastPoolExhaustionSkipReasons) {
        foreach ($p in @($obs.lastPoolExhaustionSkipReasons.PSObject.Properties)) {
          if (-not $skipReasons.ContainsKey([int]$p.Name)) { $skipReasons[[int]$p.Name] = ([string]$p.Value).ToLower() }
        }
      }
      foreach ($idx in @($skipReasons.Keys)) {
        $skipReason = [string]$skipReasons[$idx]
        if (($HARD_RT -notcontains $skipReason) -and ($skipReason -notmatch 'model[\s_-]*capacity|capacity[\s_-]*(exhausted|insufficient|unavailable)|(?:auth|unauthori[sz]ed|token)[\s_-]*(invalid|expired|revoked|failed)|invalid[\s_-]*token') -and (-not $skipReason.StartsWith($COOLDOWN_RT_PREFIX))) { continue }
        $runtimeBlocked[[string]$idx] = $skipReasons[$idx]
        # 窗口已重置但运行时还带着旧 429：清掉旧标记，让它重新参与轮转
        $q = $quotaByIndex[[string]$idx]
        if ($null -ne $q) {
          $resetPassed = $false
          foreach ($w in @($q.primary, $q.secondary)) {
            if (($null -ne $w) -and ($null -ne $w.resetAtMs) -and ([int64]$w.resetAtMs -le $now)) { $resetPassed = $true }
          }
          if ($resetPassed -and -not $cfg.rotation -and -not $DryRun -and $cfg.autoSwitch) {
            $rrRes = Capture-Cli @('rotation','reset-rate-limits','--account',[string]([int]$idx + 1)) 60000
            $rr = $rrRes.out
            if ($rrRes.code -eq 0) {
              Log ("RATELIMIT-RESET 已清除账号" + ([int]$idx + 1) + " 的旧限流标记（窗口已重置）")
              $rtResetNote = $rtResetNote + [char]10 + "RATELIMIT-RESET 已清除账号" + ([int]$idx + 1) + " 的旧限流标记"
              $runtimeBlocked.Remove([string]$idx)
            } else {
              Log ("RATELIMIT-RESET 失败：" + $rr.Trim())
            }
          }
        }
      }
    }
  } catch { }
}

# account policy：策略核心需要知道所有会影响运行时选号的字段。
$pausedIdx = @()
$emergencyOnlyIndex = $null
$emergencyOnlyIndexes = @()
$policyByIndex = @{}
$polRes = Invoke-CliRetry @('account','policy','list','--json') 60000 3
$polText = $polRes.out
$policyExit = $polRes.code
if ($policyExit -ne 0) { Finish "ERROR" ("ERROR account policy list 失败（退出码 " + $policyExit + "）：" + $polText.Trim()) $true }
try { $pol = (Get-JsonText $polText) | ConvertFrom-Json } catch { Finish "ERROR" "ERROR account policy list JSON 解析失败" $true }
if ($null -eq $pol.accounts) { Finish "ERROR" "ERROR account policy list 缺少 accounts" $true }
foreach ($a in @($pol.accounts)) {
  $zero = [int]$a.index - 1
  if ($zero -lt 0) { continue }
  if ($a.paused) { $pausedIdx += $zero }
  if ($a.emergencyOnly) { $emergencyOnlyIndexes += $zero }
  $policyByIndex[[string]$zero] = @{
    accountKey = [string]$a.accountKey
    paused = [bool]$a.paused
    emergencyOnly = [bool]$a.emergencyOnly
    drained = [bool]$a.drained
    enabled = if ($null -ne $a.enabled) { [bool]$a.enabled } else { $true }
    authInvalidated = [bool]$a.authInvalidated
    priority = if ($null -ne $a.priority) { [int]$a.priority } else { 1 }
    weight = if ($null -ne $a.weight) { [double]$a.weight } else { 1 }
  }
}
# 储备号保留归还：本策略切进储备号时解除了它的 emergency-only；之后不管以什么方式离开储备号
# （策略回切、面板手动切号、故障转移），都由这里把保留标记还回去。只还自己解除过的那一次，
# 用户手动"取消备用"的账号不在 reserveReleased 里，不会被改回去。
if (($state.reserveReleased -gt 0) -and -not $cfg.rotation -and -not $DryRun) {
  $releasedNo = [int]$state.reserveReleased
  $releasedIdx = $releasedNo - 1
  if (($releasedIdx -lt 0) -or ($releasedIdx -ge $acctCount)) {
    $state.reserveReleased = 0
  } elseif ($cur -ne $releasedIdx) {
    if ($emergencyOnlyIndexes -notcontains $releasedIdx) {
      $back = Invoke-CmaChecked @('account','emergency-only',[string]$releasedNo,'on')
      if ($back.ok) {
        $emergencyOnlyIndexes += $releasedIdx
        if ($policyByIndex.ContainsKey([string]$releasedIdx)) { $policyByIndex[[string]$releasedIdx].emergencyOnly = $true }
        Log ("EMERGENCY-ONLY 储备号已不在用，恢复保留（账号" + $releasedNo + "）")
        $state.reserveReleased = 0
      } else {
        Log ("EMERGENCY-ONLY 恢复储备号保留失败（账号" + $releasedNo + "），下轮重试")
      }
    } else {
      $state.reserveReleased = 0
    }
  }
}
if ($emergencyOnlyIndexes.Count -gt 0) { $emergencyOnlyIndex = $emergencyOnlyIndexes[-1] }

# Legacy auto-unpin follows the validated decision below.
# （"Pinned account N is currently unavailable"）。autoSwitch 模式下由策略负责路由，
# 因此每次运行都清掉遗留的钉住；autoSwitch=false（手动模式）保留用户的选择。
$unpinNote = ""
if (-not $cfg.rotation -and -not $DryRun -and ($cfg.autoSwitch -ne $false) -and ($null -ne $pinnedIdx)) {
  $pinNo = $pinnedIdx + 1
  $unpinRes = Capture-Cli @('unpin') 60000
  $unpinOut = $unpinRes.out
  if ($unpinRes.code -eq 0) {
    Log ("UNPIN 已解除账号固定（账号" + $pinNo + "；autoSwitch 模式下由策略负责轮转）")
    $unpinNote = [char]10 + "UNPIN 已解除账号固定（账号" + $pinNo + "），恢复自动轮转"
    $pinnedIdx = $null
  } else {
    Log ("UNPIN 失败：" + $unpinOut.Trim())
  }
}

# 轮转自己暂停的账号只是冷却，不能当成"用户手动暂停"而永久排除
$autoPaused = @()
foreach ($v in @($state.policyPaused)) { $autoPaused += [int]$v }
# 只在账号越界时清理；不因"此刻未暂停"删除（可能是手动/CLI unpause）
$state.policyPaused = @($autoPaused | Where-Object { ($_ -ge 1) -and ($_ -le $acctCount) })

# ---- 决策：唯一实现在 panel/policy-cli.js -----------------------------------
if ($cfg.rotation) {
  $state.policyPaused = @()
  $state.exhaustedPaused = @()
  foreach ($entry in $policyByIndex.GetEnumerator()) {
    if ($state.pauseOwnership.ContainsKey([string]$entry.Value.accountKey)) { $state.exhaustedPaused += ([int]$entry.Key + 1) }
  }
}
$decisionInput = @{
  nowMs           = $now
  activeIndex     = $cur
  accountCount    = $acctCount
  quotaByIndex    = $quotaByIndex
  pausedIdx       = @($pausedIdx | Sort-Object -Unique)
  policyPaused    = @($state.policyPaused)
  policyByIndex   = $policyByIndex
  rotation        = $cfg.rotation
  exhaustedPaused = @($state.exhaustedPaused)
  autoSwitch      = $cfg.autoSwitch
  minWaitMin      = $cfg.minWaitMin
  minGapSec       = 600
  reserveIndex    = $cfg.reserveIndex
  dryRun          = [bool]$DryRun
  lastSwitchAtMs  = $state.lastSwitchAtMs
  lastStatus      = $state.lastStatus
  lastWaitKey     = $state.lastWaitKey
  lastWaitLogAtMs = $state.lastWaitLogAtMs
  runtimeSeen     = $state.runtimeSeen
}
if ($emergencyOnlyIndexes.Count -gt 0) {
  $decisionInput.emergencyOnlyIndexes = @($emergencyOnlyIndexes | Sort-Object -Unique)
}
if ($runtimeBlocked.Count -gt 0) { $decisionInput.runtimeBlocked = $runtimeBlocked }

# 用临时文件交换 JSON：避开 PowerShell 5.1 控制台对 UTF-8 的默认 ANSI 解码（中文会乱码）
$inFile  = Join-Path $env:TEMP ("codex-policy-in-"  + [guid]::NewGuid().ToString('N') + ".json")
$outFile = Join-Path $env:TEMP ("codex-policy-out-" + [guid]::NewGuid().ToString('N') + ".json")
$payload = $null
try {
  [IO.File]::WriteAllText($inFile, ($decisionInput | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  & $nodeExe $decider decide --in $inFile --out $outFile 2>&1 | Out-Null
  $payload = ([IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)) | ConvertFrom-Json
} catch {
  $payload = $null
} finally {
  Remove-Item -LiteralPath $inFile, $outFile -Force -ErrorAction SilentlyContinue
}
if ($null -eq $payload -or -not $payload.ok) {
  $why = if ($null -ne $payload -and $payload.error) { [string]$payload.error } else { "调用 " + $decider + " 失败（node: " + $nodeExe + "）" }
  Finish "ERROR" ("ERROR 决策失败：" + $why) $true
}
$d       = $payload.decision
$action  = [string]$d.action
$reason  = [string]$d.reason
$details = $d.details
if ($action -eq 'ERROR') { Finish 'ERROR' ($reason + ' code=' + $d.code) $true }
$state.runtimeSeen = @{}
if ($null -ne $details.runtimeSeen) { foreach ($property in $details.runtimeSeen.PSObject.Properties) { $state.runtimeSeen[$property.Name] = [int64]$property.Value } }

# ---- 额度耗尽：日常号自动暂停、额度重置后自动恢复 ---------------------------
# 事故：运行时会按"缓存额度"把一个 5h 已用满的账号当成可用，把请求派过去 → 上游 429 →
# Codex 界面直接显示"额度用完，等到 X 点重置"，其它账号明明有额度却在闲着。
# 判断放在 panel/policy-cli.js plan-pauses（同一份纯函数；不要在 PS 里再写一遍）。
$quotaNote = ""
$exhaustedTracked = @()
foreach ($v in @($state.exhaustedPaused)) { $exhaustedTracked += [int]$v }
$planInput = $decisionInput.Clone()
$planInput.exhaustedPaused = @($exhaustedTracked)
$plan = $null
$pIn  = Join-Path $env:TEMP ("codex-policy-plan-in-"  + [guid]::NewGuid().ToString('N') + ".json")
$pOut = Join-Path $env:TEMP ("codex-policy-plan-out-" + [guid]::NewGuid().ToString('N') + ".json")
try {
  [IO.File]::WriteAllText($pIn, ($planInput | ConvertTo-Json -Depth 12 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  & $nodeExe $decider plan-pauses --in $pIn --out $pOut 2>&1 | Out-Null
  $planPayload = ([IO.File]::ReadAllText($pOut, [Text.Encoding]::UTF8)) | ConvertFrom-Json
  if ($planPayload.ok) { $plan = $planPayload.plan }
} catch {
  $plan = $null
} finally {
  Remove-Item -LiteralPath $pIn, $pOut -Force -ErrorAction SilentlyContinue
}
if ($null -eq $plan) { Finish "ERROR" "ERROR 计划额度耗尽账号失败（policy-cli plan-pauses）" $true }
if ($plan.error) { Finish 'ERROR' ('ERROR ' + $plan.error + ' 运行时策略未修改') $true }
foreach ($change in @($plan.roleChanges)) {
  if ($null -eq $change) { continue }
  if ($DryRun) { continue }
  $flag = if ($change.emergencyOnly) { 'on' } else { 'off' }
  $roleResult = Invoke-CmaChecked @('account','emergency-only',[string]$change.n,$flag)
  if (-not $roleResult.ok) { Finish 'ERROR' ('ERROR ROLE_RECONCILE_FAILED account=' + $change.n) $true }
}
$actualTracked = @($exhaustedTracked)
foreach ($n in @($plan.pause)) {
  if ($DryRun) { $quotaNote = $quotaNote + [char]10 + "DRYRUN 将暂停额度耗尽的日常号（账号" + $n + "）"; continue }
  $prRes = Capture-Cli @('account','pause',[string]$n) 60000
  $pr = $prRes.out
  if ($prRes.code -eq 0) {
    $actualTracked = @(@($actualTracked + @([int]$n)) | Sort-Object -Unique)
    if ($cfg.rotation) { $state.pauseOwnership[[string]$policyByIndex[[string]([int]$n - 1)].accountKey] = $true }
    Log ("PAUSE 日常号额度耗尽，自动暂停（账号" + $n + "），等额度重置后自动恢复")
    $quotaNote = $quotaNote + [char]10 + "PAUSE 账号" + $n + " 额度耗尽，已自动暂停"
  } else {
    Log ("PAUSE 失败（账号" + $n + "）：" + $pr.Trim())
  }
}
foreach ($n in @($plan.resume)) {
  if ($DryRun) { $quotaNote = $quotaNote + [char]10 + "DRYRUN 将恢复额度已重置的账号（账号" + $n + "）"; continue }
  $urRes = Capture-Cli @('account','unpause',[string]$n) 60000
  $ur = $urRes.out
  if ($urRes.code -eq 0) {
    $actualTracked = @($actualTracked | Where-Object { $_ -ne [int]$n })
    if ($cfg.rotation) { $state.pauseOwnership.Remove([string]$policyByIndex[[string]([int]$n - 1)].accountKey) }
    Log ("RESUME 额度窗口已重置，自动恢复可用（账号" + $n + "）")
    $quotaNote = $quotaNote + [char]10 + "RESUME 账号" + $n + " 额度已重置，已恢复可用"
  } else {
    Log ("RESUME 失败（账号" + $n + "）：" + $ur.Trim())
  }
}
if ($DryRun) {
  $state.exhaustedPaused = @($exhaustedTracked)
} else {
  $state.exhaustedPaused = @($actualTracked)
}

if ($cfg.rotation -and -not $DryRun -and $cfg.autoSwitch -and ($null -ne $pinnedIdx)) {
  $unpin = Invoke-CmaChecked @('unpin')
  if (-not $unpin.ok) { Finish 'ERROR' 'ERROR UNPIN_FAILED 未解除固定，未执行切换' $true }
}



# 限流兜底：手动模式（autoSwitch=false）下当前号无法继续用时解除钉住，让路由器自动转移
$failNote = $unpinNote + $quotaNote
# 缓存里的 usedPercent 可能属于已重置的窗口：重置时刻已过（expired*）→ 账号实际已恢复，
# 不能再用缓存里的 100% 当"耗尽"（否则切离它时会误暂停、限流兜底也会误 unpin）。
$curExhausted = $false
if ($null -ne $details.cur) {
  $curDead5 = (($details.cur.exh5) -eq $true) -and (-not (($details.cur.expired5) -eq $true))
  $curDead7 = (($details.cur.exh7) -eq $true) -and (-not (($details.cur.expired7) -eq $true))
  $curExhausted = [bool]($curDead5 -or $curDead7)
}
if (-not $DryRun -and $null -ne $details.cur -and ($curExhausted -or ($details.cur.unavailable -eq $true)) -and ($cfg.allowFailover -ne $false)) {
  try {
    $stj = (Get-JsonText (Capture-Cli @('status','--json') 60000).out) | ConvertFrom-Json
    if ($null -ne $stj.pinnedAccountIndex) {
      Capture-Cli @('unpin') 60000 | Out-Null
      $failNote = [char]10 + "UNPIN 当前号已限流且解除了账号固定：Codex 请求会由路由器自动转移到有额度的账号（panel-config.json 设 allowFailover=false 可关闭）"
      Log ("UNPIN 已解除账号固定（" + "账号" + ($cur + 1) + " 限流），允许路由器自动转移")
    }
  } catch { }
}

$write = if ($null -ne $details.fresh) { [bool]$details.fresh } else { $true }
switch ($action) {
  "OK" {
    $state.lastWaitLogAtMs = 0
    Finish "OK" ($reason + $quotaNote) $write
  }
  "WAIT" {
    if ($write) {
      $state.lastWaitKey = [string]$details.waitKey
      $state.nextLogAtMs = [int64]$d.nextLogAtMs
    }
    Finish "WAIT" ($reason + $failNote) $write
  }
  "GUARD"    { Finish "GUARD" ($reason + $failNote) $write }
  "WARN"     { Finish "WARN" $reason $write }
  "SKIP"     { Finish "SKIP" $reason $write }
  "DEAD"     { Finish "DEAD" ($reason + $failNote) $write }
  "DISABLED" { Finish "DISABLED" ($reason + $failNote) $write }
  "SWITCH" {
    if ($details.dryRun) { Finish "DRYRUN" ($reason + $failNote) $true }
    $fromIdx = [int]$details.curIndex
    $toIdx   = [int]$d.targetIndex
    $whyText = [string]$details.why
    $reserveNo = [math]::Max(1, [int]$cfg.reserveIndex)
    $enterNote = ""
    # 事故修复：运行时会把 emergency-only 的储备号当作"不可路由"，切进去也会 503 池耗尽。
    # 决策决定启用储备号时必须先解除该标记；切离储备号后再恢复，保持"平时保留"的原意。
    $intoReserve = ($details.targetIsReserve -eq $true)
    if ($intoReserve) { $reserveNo = $toIdx + 1 }
    if ($intoReserve) {
      $released = Invoke-CmaChecked @('account','emergency-only',[string]$reserveNo,'off')
      if (-not $released.ok) { Finish 'ERROR' 'ERROR RESERVE_RELEASE_FAILED 未切换账号' $true }
      $enterNote = $enterNote + [char]10 + "EMERGENCY-ONLY 已解除储备号保留（账号" + $reserveNo + "），允许运行时路由"
      Log ("EMERGENCY-ONLY 已解除储备号保留（账号" + $reserveNo + "）")
    }
    # 只有切走的账号真的没额度（限流/打满）才暂停；冷却等临时故障保留它可用
    $pauseFrom = $true
    if ($($details.reserveBack) -ne $true) {
      if ($null -ne $details.cur) { $pauseFrom = $curExhausted }
    }
    if (Try-Switch $fromIdx $toIdx $whyText $pauseFrom) {
      if ($intoReserve) { $state.reserveReleased = $reserveNo }
      if ($details.reserveBack -eq $true) {
        $reserveNo = $fromIdx + 1
        $restored = Invoke-CmaChecked @('account','emergency-only',[string]$reserveNo,'on')
        if (-not $restored.ok) { $state.reserveReleased = $reserveNo; Finish 'ERROR' 'ERROR RESERVE_RESTORE_FAILED 已回切，备用角色恢复失败' $true }
        $state.reserveReleased = 0
        $enterNote = $enterNote + [char]10 + "EMERGENCY-ONLY 已恢复储备号保留（账号" + $reserveNo + "）"
        Log ("EMERGENCY-ONLY 已恢复储备号保留（账号" + $reserveNo + "）")
      }
      Finish "SWITCH" ($reason + [char]10 + "SWITCH 已切换 " + ($fromIdx + 1) + " -> " + ($toIdx + 1) + "（" + $whyText + "）activeIndex 已同步" + $enterNote + $rtResetNote) $true
    } else {
      $observed = $null
      try { $observed = (Get-JsonText (Capture-Cli @('status','--json') 15000).out) | ConvertFrom-Json } catch { }
      if ($intoReserve -and $null -ne $observed -and [int]$observed.activeIndex -ne $toIdx) {
        Capture-Cli @('account','emergency-only',[string]$reserveNo,'on') 60000 | Out-Null
        Log ("EMERGENCY-ONLY 切换失败，已恢复储备号保留（账号" + $reserveNo + "）")
      }
      Finish "SWITCH-FAILED" ($reason + [char]10 + "ERROR SWITCH_FAILED 切换未完整确认；请检查实际 activeIndex、pin 和 account policy") $true
    }
  }
  default    { Finish "ERROR" ("ERROR 未知决策动作：" + $action + "`n" + $reason) $true }
}

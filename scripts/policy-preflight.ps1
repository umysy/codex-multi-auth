param(
  [Parameter(Mandatory = $true)][string]$CodexHome,
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) { throw "CODEX_HOME 不存在：$CodexHome" }
if ([string]::IsNullOrWhiteSpace($OutputDir)) { $OutputDir = Join-Path $env:TEMP ('codex-policy-preflight-' + [guid]::NewGuid().ToString('N')) }
if (Test-Path -LiteralPath $OutputDir) { throw "预检输出目录已存在，拒绝覆盖：$OutputDir" }
New-Item -ItemType Directory -Force -Path (Join-Path $OutputDir 'panel\lib') | Out-Null

Copy-Item (Join-Path $repo 'quota-policy.ps1') (Join-Path $OutputDir 'quota-policy.ps1')
foreach ($file in @('policy-cli.js','policy-core.js')) {
  Copy-Item (Join-Path $repo ('panel\' + $file)) (Join-Path $OutputDir ('panel\' + $file))
}
foreach ($file in @('policy-config.js','policy-decision.js','rotation-policy.js','runtime-health.js')) {
  Copy-Item (Join-Path $repo ('panel\lib\' + $file)) (Join-Path $OutputDir ('panel\lib\' + $file))
}
$data = Join-Path $CodexHome 'multi-auth'
$config = Join-Path $data 'panel-config.json'
if (Test-Path -LiteralPath $config) { Copy-Item $config (Join-Path $OutputDir 'panel-config.json') }

$env:CODEX_HOME = (Resolve-Path -LiteralPath $CodexHome).Path
$env:CMA_POLICY_MUTEX = 'Local\CodexPolicyPreflight-' + [guid]::NewGuid().ToString('N')
$env:CMA_POLICY_ROOT = $OutputDir
$script = Join-Path $OutputDir 'quota-policy.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -DryRun
$code = $LASTEXITCODE
$result = [ordered]@{
  ok = ($code -eq 0)
  exitCode = $code
  outputDir = $OutputDir
  codeHome = $env:CODEX_HOME
  state = (Join-Path $OutputDir 'quota-policy.state.json')
  log = (Join-Path $OutputDir 'quota-policy.log')
  dryRun = $true
  note = '只读取真实账号状态和额度；不会执行 switch、pause、unpause 或 emergency-only 变更。'
}
$result | ConvertTo-Json -Depth 4
exit $code

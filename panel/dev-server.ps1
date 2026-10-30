# Development preview uses synthetic data only; no real CLI or watchdog is loaded.
param([int]$Port = 18766)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid preview port' }
$repo = Split-Path -Parent $PSScriptRoot
Write-Host 'Development preview: mock data; account actions never contact installed Codex.'
& node (Join-Path $repo 'panel\tests\mock-server.js') --port $Port
exit $LASTEXITCODE

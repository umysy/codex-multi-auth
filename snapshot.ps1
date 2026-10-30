param([string]$Note = '')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$store = Join-Path $root 'versions'
$id = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = Join-Path $store $id
if (Test-Path $dir) { throw "snapshot $id already exists" }
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# 1) panel 全量（排除运行时/构建/浏览器配置）
robocopy "$root\panel" "$dir\panel" /E /XD ".app-data" "bin" "obj" ".e2e-profile" /XF "*.log" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy panel failed: $LASTEXITCODE" }

# 2) 脚本与配置
foreach ($f in @('quota-policy.ps1','ensure-router.ps1','panel-config.json','account-policies.json')) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $dir $f) -Force }
}

# 3) 哈希清单
$files = Get-ChildItem $dir -Recurse -File | Where-Object { $_.Name -ne 'manifest.sha256' -and $_.Name -ne 'version.json' }
$lines = foreach ($f in $files) {
  $rel = $f.FullName.Substring($dir.Length + 1).Replace('\','/')
  $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
  "{0}  {1}" -f $h, $rel
}
$lines | Set-Content -LiteralPath (Join-Path $dir 'manifest.sha256') -Encoding ASCII

# 4) version.json
$size = ($files | Measure-Object -Property Length -Sum).Sum
$gitHead = $null; $gitDirty = $null
try {
  if (Test-Path (Join-Path $root '.git')) {
    $gitHead = (& git -C $root rev-parse --short HEAD 2>$null)
    $dirty = & git -C $root status --porcelain 2>$null
    $gitDirty = [bool]$dirty
  }
} catch { }
$obj = [ordered]@{
  id = $id
  created = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  note = $Note
  files = $files.Count
  sizeBytes = [int64]$size
  hashes = 'manifest.sha256'
  gitHead = $gitHead
  gitDirty = $gitDirty
}
($obj | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath (Join-Path $dir 'version.json') -Encoding UTF8

# 5) index.json
$indexPath = Join-Path $store 'index.json'
$index = @()
if (Test-Path $indexPath) { try { $index = @(Get-Content $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { $index = @() } }
$index = @($index) + @([pscustomobject]@{ id=$id; created=$obj.created; note=$Note; files=$obj.files; sizeBytes=$obj.sizeBytes })
($index | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $indexPath -Encoding UTF8

Write-Output ("SNAPSHOT OK {0}  files={1}  size={2:N0} bytes  dir={3}" -f $id, $files.Count, $size, $dir)
# 优雅重启 CodexQuota（先用 WM_CLOSE 触发托盘清理，失败才强杀）
param([switch]$Start)
$exe = Join-Path $PSScriptRoot 'desktop\CodexQuota.exe'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class GraceClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$p = Get-Process CodexQuota -ErrorAction SilentlyContinue
if ($p) {
  foreach ($proc in $p) { [void][GraceClose]::PostMessage($proc.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process CodexQuota -ErrorAction SilentlyContinue)) { break }
  }
  $left = Get-Process CodexQuota -ErrorAction SilentlyContinue
  if ($left) { $left | Stop-Process -Force; 'forced fallback' } else { 'graceful close OK' }
} else { 'not running' }
if ($Start) { Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) }
# Checks that closing the window puts Deeproject in the notification area
# instead of ending it, and that its terminals survive.
#
#   powershell -File scripts/background-close-test.ps1 -Profile <dir>
#
# Runs against a throwaway profile so the real one is never touched. Sends a
# real WM_CLOSE rather than clicking, because the window's close button is
# drawn by Windows and its position moves with the title bar overlay.
param(
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [int]$StartupSeconds = 45
)

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "node_modules\electron\dist\electron.exe"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BgTest {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

$failures = 0
function Check([string]$label, $actual, $expected) {
  $ok = "$actual" -eq "$expected"
  if (-not $ok) { $script:failures++ }
  $suffix = if ($ok) { "" } else { " (got $actual, want $expected)" }
  Write-Output ("  {0}  {1}{2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $label, $suffix)
}

if (Test-Path $ProfileDir) { Remove-Item -Recurse -Force $ProfileDir }
& node (Join-Path $root "scripts\seed-feature-profile.cjs") $ProfileDir $root | Out-Null

$log = "$ProfileDir.log"
$proc = Start-Process -FilePath $exe -ArgumentList "`"$root`"", "--user-data-dir=$ProfileDir" `
  -RedirectStandardError $log -PassThru
Write-Output "launched pid=$($proc.Id); waiting up to ${StartupSeconds}s for its window"

# Find the app's main window, which only exists once the renderer has painted.
function Find-Main([int]$targetPid) {
  $script:found = [IntPtr]::Zero
  $cb = [BgTest+EP] {
    param($h, $l)
    $q = [uint32]0
    [void][BgTest]::GetWindowThreadProcessId($h, [ref]$q)
    if ($q -eq $script:wanted) {
      $sb = New-Object System.Text.StringBuilder 256
      [void][BgTest]::GetClassNameW($h, $sb, 256)
      if ($sb.ToString() -eq 'Chrome_WidgetWin_1') { $script:found = $h; return $false }
    }
    return $true
  }
  $script:wanted = $targetPid
  [void][BgTest]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt $StartupSeconds * 2; $i++) {
  $hwnd = Find-Main $proc.Id
  if ($hwnd -ne [IntPtr]::Zero -and [BgTest]::IsWindowVisible($hwnd)) { break }
  Start-Sleep -Milliseconds 500
}
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output "the window never appeared"
  if (Test-Path $log) { Get-Content $log -Raw }
  try { Stop-Process -Id $proc.Id -Force } catch {}
  exit 1
}
Write-Output ("window = 0x{0:X}" -f [int64]$hwnd)

$shellsBefore = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.ParentProcessId -eq $proc.Id })
Write-Output ("terminals running: {0}" -f $shellsBefore.Count)
Write-Output ""

Write-Output "closing the window:"
[void][BgTest]::SendMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Seconds 5

$alive = [bool](Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)
Check "the app is still running" $alive $true
if ($alive) {
  Check "its window is hidden, not destroyed" ([BgTest]::IsWindow($hwnd)) $true
  Check "and is no longer on screen" ([BgTest]::IsWindowVisible($hwnd)) $false
  $shellsAfter = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.ParentProcessId -eq $proc.Id })
  Check "the terminals survived" $shellsAfter.Count $shellsBefore.Count

  Write-Output ""
  Write-Output "launching it again brings the window back:"
  Start-Process -FilePath $exe -ArgumentList "`"$root`"", "--user-data-dir=$ProfileDir" | Out-Null
  Start-Sleep -Seconds 6
  Check "window is on screen again" ([BgTest]::IsWindowVisible($hwnd)) $true
  Check "and it is the same process" ([bool](Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) $true
}

if (Test-Path $log) {
  $text = (Get-Content $log -Raw)
  if ($text.Trim()) { Write-Output ""; Write-Output "--- app stderr ---"; Write-Output $text }
}

try { Stop-Process -Id $proc.Id -Force } catch {}
Write-Output ""
Write-Output $(if ($failures -eq 0) { "ALL CHECKS PASSED" } else { "$failures CHECK(S) FAILED" })
exit $(if ($failures -eq 0) { 0 } else { 1 })

# Watches a docked window's parent and rectangle over time.
#
#   powershell -File scripts/embed-geometry-watch.ps1 -TitleMatch "Roblox Studio" -Seconds 20
#
# Tells two failures apart that look identical in a screenshot: a window we
# never sized (rect stays wrong and still), and one whose toolkit keeps putting
# its own geometry back (rect changes every sample, or flips between two).
param(
  [string]$TitleMatch = "Roblox Studio",
  [int]$Seconds = 20
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GWatch {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$GA_PARENT = 1
$GWL_STYLE = -16
$WS_CHILD = 0x40000000

# The window may already be a child, so EnumWindows alone will not find it.
function Find-Target([string]$match) {
  $hit = [IntPtr]::Zero
  $scan = [GWatch+EnumProc] {
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void][GWatch]::GetWindowTextW($h, $sb, 512)
    if ($sb.ToString() -like "*$match*") { $script:hit = $h; return $false }
    [void][GWatch]::EnumChildWindows($h, [GWatch+EnumProc]{
      param($c, $l2)
      $sb2 = New-Object System.Text.StringBuilder 512
      [void][GWatch]::GetWindowTextW($c, $sb2, 512)
      if ($sb2.ToString() -like "*$match*") { $script:hit = $c; return $false }
      return $true
    }, [IntPtr]::Zero)
    if ($script:hit -ne [IntPtr]::Zero) { return $false }
    return $true
  }
  $script:hit = [IntPtr]::Zero
  [void][GWatch]::EnumWindows($scan, [IntPtr]::Zero)
  return $script:hit
}

$target = Find-Target $TitleMatch
if ($target -eq [IntPtr]::Zero) { Write-Output "no window matching '$TitleMatch'"; exit 1 }

$pid_ = [uint32]0
[void][GWatch]::GetWindowThreadProcessId($target, [ref]$pid_)
Write-Output ("watching 0x{0:X} (pid {1}) for {2}s" -f [int64]$target, $pid_, $Seconds)
Write-Output ""
Write-Output ("{0,-6} {1,-12} {2,-7} {3,-9} {4,-24} {5}" -f 't', 'parent', 'WS_CHILD', 'visible', 'window rect', 'client size')

$last = ""
$changes = 0
for ($i = 0; $i -lt $Seconds * 4; $i++) {
  if (-not [GWatch]::IsWindow($target)) { Write-Output "window is gone"; break }

  $parent = [GWatch]::GetAncestor($target, $GA_PARENT)
  $style = [GWatch]::GetWindowLong($target, $GWL_STYLE)
  $r = New-Object GWatch+RECT
  [void][GWatch]::GetWindowRect($target, [ref]$r)
  $c = New-Object GWatch+RECT
  [void][GWatch]::GetClientRect($target, [ref]$c)

  $line = "{0,-12} {1,-7} {2,-9} {3,-24} {4}" -f `
    ("0x" + ([int64]$parent).ToString("X")),
    (($style -band $WS_CHILD) -ne 0),
    [GWatch]::IsWindowVisible($target),
    ("{0},{1} {2}x{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)),
    ("{0}x{1}" -f ($c.Right - $c.Left), ($c.Bottom - $c.Top))

  # Only print when something moved; a still window says as much as a busy one.
  if ($line -ne $last) {
    Write-Output ("{0,-6} {1}" -f ("{0:0.0}s" -f ($i * 0.25)), $line)
    if ($last -ne "") { $changes++ }
    $last = $line
  }
  Start-Sleep -Milliseconds 250
}

Write-Output ""
if ($changes -eq 0) {
  Write-Output "VERDICT: geometry never changed while watching."
  Write-Output "  If it is the wrong size, nothing is sizing it -- look at setBounds."
} else {
  Write-Output "VERDICT: geometry changed $changes time(s) while watching."
  Write-Output "  Something keeps moving it. If it alternates between two rectangles,"
  Write-Output "  the app and Deeproject are fighting over the window."
}

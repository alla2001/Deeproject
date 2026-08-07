# Lists a process's top-level windows the way embed.ts sees them, plus the
# attributes it does not currently check (owner, cloaked, tool-window), so a
# window that refuses to dock can be explained rather than guessed at.
param([Parameter(Mandatory = $true)][int]$ProcId)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Probe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
}
"@

$GW_OWNER = 4
$GWL_STYLE = -16
$GWL_EXSTYLE = -20
$WS_VISIBLE = 0x10000000
$WS_CHILD = 0x40000000
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_APPWINDOW = 0x00040000
$DWMWA_CLOAKED = 14

$rows = New-Object System.Collections.ArrayList
$cb = [Probe+EnumProc] {
  param($h, $l)
  $pid_ = [uint32]0
  [void][Probe]::GetWindowThreadProcessId($h, [ref]$pid_)
  if ($pid_ -ne $ProcId) { return $true }

  $sb = New-Object System.Text.StringBuilder 512
  [void][Probe]::GetWindowTextW($h, $sb, 512)
  $title = $sb.ToString()

  $cb2 = New-Object System.Text.StringBuilder 256
  [void][Probe]::GetClassNameW($h, $cb2, 256)

  $style = [Probe]::GetWindowLong($h, $GWL_STYLE)
  $ex = [Probe]::GetWindowLong($h, $GWL_EXSTYLE)
  $owner = [Probe]::GetWindow($h, $GW_OWNER)
  $cloaked = 0
  [void][Probe]::DwmGetWindowAttribute($h, $DWMWA_CLOAKED, [ref]$cloaked, 4)

  [void]$rows.Add([pscustomobject]@{
    Handle  = "0x" + $h.ToString("X")
    Class   = $cb2.ToString()
    Title   = if ($title) { $title } else { "<empty>" }
    Visible = [Probe]::IsWindowVisible($h)
    Child   = (($style -band $WS_CHILD) -ne 0)
    Owned   = ($owner -ne [IntPtr]::Zero)
    Tool    = (($ex -band $WS_EX_TOOLWINDOW) -ne 0)
    AppWin  = (($ex -band $WS_EX_APPWINDOW) -ne 0)
    Cloaked = $cloaked
  })
  return $true
}
[void][Probe]::EnumWindows($cb, [IntPtr]::Zero)

if ($rows.Count -eq 0) { Write-Output "no top-level windows owned by pid $ProcId"; exit }
$rows | Format-Table -AutoSize

# embed.ts keeps: visible AND non-empty title AND class not forbidden.
$dockable = $rows | Where-Object { $_.Visible -and $_.Title -ne "<empty>" }
Write-Output ("embed.ts would list {0} of {1} window(s)" -f $dockable.Count, $rows.Count)

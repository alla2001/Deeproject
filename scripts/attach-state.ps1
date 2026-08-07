# Reports what actually happened to a window after a dock attempt: who its
# parent is, whether WS_CHILD stuck, where it sits, and whether it is visible.
param([string]$TitleMatch = "Roblox Studio")

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AState {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$GWL_STYLE = -16
$WS_CHILD = 0x40000000
$WS_VISIBLE = 0x10000000
$WS_POPUP = -2147483648
$WS_CAPTION = 0x00C00000

# Search top-level windows and children of every window, since a docked window
# is no longer top-level and EnumWindows will not return it.
$found = New-Object System.Collections.ArrayList
$scan = [AState+EnumProc] {
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][AState]::GetWindowTextW($h, $sb, 512)
  $t = $sb.ToString()
  if ($t -like "*$TitleMatch*") { [void]$found.Add($h) }
  # Descend one level: a reparented window is a child of our frame.
  [void][AState]::EnumChildWindows($h, [AState+EnumProc]{
    param($c, $l2)
    $sb2 = New-Object System.Text.StringBuilder 512
    [void][AState]::GetWindowTextW($c, $sb2, 512)
    if ($sb2.ToString() -like "*$TitleMatch*") { [void]$found.Add($c) }
    return $true
  }, [IntPtr]::Zero)
  return $true
}
[void][AState]::EnumWindows($scan, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Output "no window matching '$TitleMatch'"; exit }

foreach ($h in ($found | Select-Object -Unique)) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][AState]::GetWindowTextW($h, $sb, 512)
  $cls = New-Object System.Text.StringBuilder 256
  [void][AState]::GetClassNameW($h, $cls, 256)
  $style = [AState]::GetWindowLong($h, $GWL_STYLE)
  $parent = [AState]::GetParent($h)
  $r = New-Object AState+RECT
  [void][AState]::GetWindowRect($h, [ref]$r)

  $ppid = [uint32]0
  if ($parent -ne [IntPtr]::Zero) { [void][AState]::GetWindowThreadProcessId($parent, [ref]$ppid) }
  $pname = if ($ppid -ne 0) { (Get-Process -Id $ppid -ErrorAction SilentlyContinue).ProcessName } else { "-" }

  Write-Output ("window   : 0x{0:X}  {1}" -f [int64]$h, $sb.ToString())
  Write-Output ("class    : {0}" -f $cls.ToString())
  Write-Output ("parent   : 0x{0:X} (pid {1} {2})" -f [int64]$parent, $ppid, $pname)
  Write-Output ("WS_CHILD : {0}" -f (($style -band $WS_CHILD) -ne 0))
  Write-Output ("WS_VISIBLE: {0}   IsWindowVisible: {1}" -f (($style -band $WS_VISIBLE) -ne 0), [AState]::IsWindowVisible($h))
  Write-Output ("WS_CAPTION: {0}" -f (($style -band $WS_CAPTION) -ne 0))
  Write-Output ("rect     : {0},{1} {2}x{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
  Write-Output ""
}

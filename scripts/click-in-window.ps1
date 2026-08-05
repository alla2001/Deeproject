# Clicks a point inside a specific window, for driving the UI during development.
#
# Refuses to click unless that window is genuinely in the foreground first, so a
# failed focus can never land the click in whatever app happens to be on top.
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clicker {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

$proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq 0) { Write-Output "NO_WINDOW"; exit 1 }
$h = $proc.MainWindowHandle

$fg = [Clicker]::GetForegroundWindow()
$fgThread = [Clicker]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$tgThread = [Clicker]::GetWindowThreadProcessId($h, [ref]([uint32]0))
[void][Clicker]::AttachThreadInput($fgThread, $tgThread, $true)
[void][Clicker]::ShowWindow($h, 9)
[void][Clicker]::SetForegroundWindow($h)
[void][Clicker]::AttachThreadInput($fgThread, $tgThread, $false)
Start-Sleep -Milliseconds 700

# Safety gate: only click when the intended window really owns the foreground.
$nowFg = [Clicker]::GetForegroundWindow()
$fgPid = [uint32]0
[void][Clicker]::GetWindowThreadProcessId($nowFg, [ref]$fgPid)
if ($fgPid -ne $ProcId) { Write-Output "NOT_FOREGROUND (foreground pid $fgPid) - refusing to click"; exit 1 }

$r = New-Object Clicker+RECT
[void][Clicker]::GetWindowRect($h, [ref]$r)
$sx = $r.Left + $X
$sy = $r.Top + $Y

$old = New-Object Clicker+POINT
[void][Clicker]::GetCursorPos([ref]$old)

[void][Clicker]::SetCursorPos($sx, $sy)
Start-Sleep -Milliseconds 120
[Clicker]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)  # left down
Start-Sleep -Milliseconds 60
[Clicker]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)  # left up
Start-Sleep -Milliseconds 200

[void][Clicker]::SetCursorPos($old.X, $old.Y)
Write-Output "CLICKED at window($X,$Y) screen($sx,$sy)"

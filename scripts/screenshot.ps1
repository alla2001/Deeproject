# Captures a window to a PNG.
#
# Uses PrintWindow with PW_RENDERFULLCONTENT, which asks the window to render
# itself into a bitmap. Unlike copying the screen region, this works even when
# the target is behind another window — screen copies silently capture whatever
# happens to be on top, which produced a lot of misleading screenshots.
param(
  [string]$Out = "$env:TEMP\deeproject-shot.png",
  [string]$TitleMatch = "Deeproject",
  [int]$ProcId = 0,
  [switch]$ScreenCopy
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

if ($ProcId -gt 0) {
  $proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
} else {
  $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitleMatch*" } | Select-Object -First 1
}
if (-not $proc -or $proc.MainWindowHandle -eq 0) { Write-Output "NO_WINDOW"; exit 1 }

$h = $proc.MainWindowHandle
# A minimised window has nothing to render, so it must be restored first.
if ([Win]::IsIconic($h)) {
  [Win]::ShowWindow($h, 9) | Out-Null
  Start-Sleep -Milliseconds 700
}

$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top
if ($w -le 0 -or $hgt -le 0) { Write-Output "BAD_RECT"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)

if ($ScreenCopy) {
  [Win]::ShowWindow($h, 9) | Out-Null
  [Win]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 900
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $mode = "screen"
} else {
  $hdc = $g.GetHdc()
  # 2 = PW_RENDERFULLCONTENT, required for hardware-composited (Chromium) windows.
  $ok = [Win]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc)
  if (-not $ok) { Write-Output "PRINTWINDOW_FAILED"; $g.Dispose(); $bmp.Dispose(); exit 1 }
  $mode = "printwindow"
}

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "SAVED $Out ($w x $hgt) via $mode"

import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * Finding and focusing another application's window needs Win32 calls that Node
 * has no binding for, and this project cannot compile a native addon. PowerShell
 * can P/Invoke them, so a short script is run out-of-process instead.
 */

const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

export interface FoundWindow {
  pid: number
  title: string
}

function runPowerShell(script: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) {
          console.error('[windows] powershell failed', err.message)
          resolve('')
          return
        }
        resolve(stdout.trim())
      }
    )
  })
}

/** Shared P/Invoke surface for the scripts below. */
const WIN32_TYPE = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DpWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
}
"@ -ErrorAction SilentlyContinue
`

/** Visible top-level windows belonging to any process with the given exe name. */
export async function listWindows(exeName: string): Promise<FoundWindow[]> {
  const script = `
$ErrorActionPreference='SilentlyContinue'
${WIN32_TYPE}
$targets = @{}
Get-Process -Name '${exeName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { $targets[[uint32]$_.Id] = $true }
if ($targets.Count -eq 0) { '[]'; exit }
$found = New-Object System.Collections.ArrayList
$cb = [DpWin+EnumProc]{
  param($h, $l)
  if ([DpWin]::IsWindowVisible($h)) {
    $pid_ = [uint32]0
    [void][DpWin]::GetWindowThreadProcessId($h, [ref]$pid_)
    if ($targets.ContainsKey($pid_)) {
      $len = [DpWin]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [void][DpWin]::GetWindowText($h, $sb, $sb.Capacity)
        [void]$found.Add([pscustomobject]@{ pid = [int]$pid_; title = $sb.ToString() })
      }
    }
  }
  return $true
}
[void][DpWin]::EnumWindows($cb, [IntPtr]::Zero)
ConvertTo-Json -InputObject @($found) -Compress
`
  const out = await runPowerShell(script)
  if (!out) return []
  try {
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/**
 * Bring a window to the front.
 *
 * Windows refuses SetForegroundWindow from a process that does not own the
 * foreground, so the caller's input queue is briefly attached to the target's —
 * the long-standing workaround for exactly this.
 */
export async function focusWindowOfProcess(pid: number, titleContains?: string): Promise<boolean> {
  const needle = (titleContains ?? '').replace(/'/g, "''")
  const script = `
$ErrorActionPreference='SilentlyContinue'
${WIN32_TYPE}
$target = [IntPtr]::Zero
$needle = '${needle}'
$cb = [DpWin+EnumProc]{
  param($h, $l)
  if ($target -ne [IntPtr]::Zero) { return $true }
  if ([DpWin]::IsWindowVisible($h)) {
    $pid_ = [uint32]0
    [void][DpWin]::GetWindowThreadProcessId($h, [ref]$pid_)
    if ($pid_ -eq ${pid}) {
      $len = [DpWin]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [void][DpWin]::GetWindowText($h, $sb, $sb.Capacity)
        if ($needle -eq '' -or $sb.ToString() -like "*$needle*") { $script:target = $h }
      }
    }
  }
  return $true
}
[void][DpWin]::EnumWindows($cb, [IntPtr]::Zero)
if ($target -eq [IntPtr]::Zero) { 'NO'; exit }
$fg = [DpWin]::GetForegroundWindow()
$fgThread = [DpWin]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
$tgThread = [DpWin]::GetWindowThreadProcessId($target, [ref]([uint32]0))
[void][DpWin]::AttachThreadInput($fgThread, $tgThread, $true)
if ([DpWin]::IsIconic($target)) { [void][DpWin]::ShowWindow($target, 9) }
[void][DpWin]::BringWindowToTop($target)
$ok = [DpWin]::SetForegroundWindow($target)
[void][DpWin]::AttachThreadInput($fgThread, $tgThread, $false)
if ($ok) { 'OK' } else { 'NO' }
`
  const out = await runPowerShell(script)
  return out.includes('OK')
}

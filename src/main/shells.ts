import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ShellInfo } from '@shared/types'

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const SYS32 = join(SYSTEM_ROOT, 'System32')
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files'
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const LOCAL_APPDATA = process.env.LOCALAPPDATA || ''

/** First path that exists, or null. */
function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

let cached: ShellInfo[] | null = null

/**
 * Discover the shells available on this machine. Ordered best-first; the first
 * entry becomes the default when the user has not chosen one.
 *
 * cmd.exe leads deliberately: Claude Code's TUI misbehaves under PowerShell,
 * so plain cmd is the reliable host for these sessions.
 */
export function detectShells(): ShellInfo[] {
  if (cached) return cached

  const found: ShellInfo[] = []

  const cmd = firstExisting([join(SYS32, 'cmd.exe')])
  if (cmd) {
    found.push({
      id: 'cmd',
      label: 'Command Prompt',
      exe: cmd,
      plainArgs: [],
      commandMode: 'cmd',
      icon: '⬛'
    })
  }

  const pwsh = firstExisting([
    join(PROGRAM_FILES, 'PowerShell', '7', 'pwsh.exe'),
    join(PROGRAM_FILES, 'PowerShell', '7-preview', 'pwsh.exe'),
    join(PROGRAM_FILES_X86, 'PowerShell', '7', 'pwsh.exe'),
    join(LOCAL_APPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ])
  if (pwsh) {
    found.push({
      id: 'pwsh',
      label: 'PowerShell 7',
      exe: pwsh,
      plainArgs: ['-NoLogo'],
      commandMode: 'powershell',
      icon: '🔷'
    })
  }

  const winps = firstExisting([join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')])
  if (winps) {
    found.push({
      id: 'powershell',
      label: 'Windows PowerShell',
      exe: winps,
      plainArgs: ['-NoLogo'],
      commandMode: 'powershell',
      icon: '🟦'
    })
  }

  const gitBash = firstExisting([
    join(PROGRAM_FILES, 'Git', 'bin', 'bash.exe'),
    join(PROGRAM_FILES_X86, 'Git', 'bin', 'bash.exe'),
    join(LOCAL_APPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
  ])
  if (gitBash) {
    found.push({
      id: 'git-bash',
      label: 'Git Bash',
      exe: gitBash,
      plainArgs: ['-i', '-l'],
      commandMode: 'posix',
      icon: '🐚'
    })
  }

  const wsl = firstExisting([join(SYS32, 'wsl.exe')])
  if (wsl) {
    found.push({
      id: 'wsl',
      label: 'WSL',
      exe: wsl,
      plainArgs: [],
      commandMode: 'wsl',
      icon: '🐧'
    })
  }

  // Guaranteed fallback so the app is never left with an empty shell list.
  if (found.length === 0) {
    found.push({
      id: 'cmd',
      label: 'Command Prompt',
      exe: 'cmd.exe',
      plainArgs: [],
      commandMode: 'cmd',
      icon: '⬛'
    })
  }

  cached = found
  return found
}

export function resolveShell(shellId: string | null | undefined): ShellInfo {
  const shells = detectShells()
  if (shellId) {
    const match = shells.find((s) => s.id === shellId)
    if (match) return match
  }
  return shells[0]
}

/**
 * cmd.exe starts on the legacy OEM codepage, which mangles the box-drawing and
 * emoji in Claude's TUI. Switching to UTF-8 first fixes the rendering.
 */
const CMD_UTF8 = 'chcp 65001>nul'

/**
 * Build the launch arguments for a shell. When `command` is set the shell runs
 * it and then drops to an interactive prompt, so the tab stays usable after
 * Claude exits.
 *
 * cmd.exe gets a pre-built command line (a string) rather than an argv array.
 * node-pty escapes quotes inside an array as `\"`, which is the C runtime's
 * convention; cmd.exe does not understand it and splits the argument at the
 * first space instead — which broke any quoted path containing one. Handing it
 * a raw command line keeps the quotes intact, and cmd's documented `/K` rule
 * strips exactly the outer pair.
 */
export function buildArgs(shell: ShellInfo, command: string | null): string[] | string {
  const cmd = command?.trim()

  if (!cmd) {
    // Even a bare prompt gets UTF-8, so anything launched by hand renders right.
    return shell.commandMode === 'cmd' ? `/K "${CMD_UTF8}"` : [...shell.plainArgs]
  }

  switch (shell.commandMode) {
    case 'powershell':
      return ['-NoLogo', '-NoExit', '-Command', cmd]
    case 'cmd':
      return `/K "${CMD_UTF8} && ${cmd}"`
    case 'posix':
      // Replace the subshell with an interactive one so the session survives.
      return ['-i', '-l', '-c', `${cmd}; exec "$SHELL" -i`]
    case 'wsl':
      return ['--', 'bash', '-lic', `${cmd}; exec bash -i`]
    default:
      return [...shell.plainArgs]
  }
}

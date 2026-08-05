import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { IPty } from '@lydell/node-pty'
import * as nodePty from '@lydell/node-pty'
import type { PtyAttachResult, PtyStartOptions, PtyStatus, PtyStatusEvent } from '@shared/types'
import { buildArgs, resolveShell } from './shells'
import { augmentClaudeCommand } from './mcp'

/** Cap on replayed scrollback held in the main process, in characters. */
const MAX_BUFFER = 512 * 1024

interface Session {
  id: string
  pty: IPty | null
  status: PtyStatus
  /** Identifies the current run; stale callbacks compare against it. */
  runId: string
  chunks: string[]
  bufferLength: number
  /** Total characters emitted by the current run. */
  emitted: number
  pid?: number
  exitCode?: number
}

class PtyManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  private session(id: string): Session {
    let s = this.sessions.get(id)
    if (!s) {
      s = {
        id,
        pty: null,
        status: 'stopped',
        runId: '',
        chunks: [],
        bufferLength: 0,
        emitted: 0
      }
      this.sessions.set(id, s)
    }
    return s
  }

  private setStatus(
    s: Session,
    runId: string,
    status: PtyStatus,
    extra: Partial<PtyStatusEvent> = {}
  ): void {
    if (runId !== s.runId) return
    s.status = status
    const event: PtyStatusEvent = {
      terminalId: s.id,
      runId,
      status,
      pid: s.pid,
      exitCode: s.exitCode,
      ...extra
    }
    this.emit('status', event)
  }

  /** Buffer a chunk and broadcast it with its absolute stream position. */
  private emitData(s: Session, runId: string, data: string): void {
    // Output from a superseded run is dropped rather than mixed into the new one.
    if (runId !== s.runId) return
    s.chunks.push(data)
    s.bufferLength += data.length
    s.emitted += data.length
    while (s.bufferLength > MAX_BUFFER && s.chunks.length > 1) {
      const dropped = s.chunks.shift()!
      s.bufferLength -= dropped.length
    }
    this.emit('data', { terminalId: s.id, runId, data, seq: s.emitted })
  }

  /** Environment handed to the child, cleaned of the launcher's own markers. */
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    // These leak Electron internals into child processes and break Node CLIs.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    delete env.NODE_OPTIONS

    // If this app was itself launched from inside a Claude Code session, those
    // markers would be inherited and every terminal we spawn would be treated
    // as a nested child session (which disables transcript saving). Each tab
    // should be a fresh top-level session instead.
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_CHILD_SESSION
    delete env.CLAUDE_CODE_SESSION_ID
    delete env.CLAUDE_CODE_ENTRYPOINT
    delete env.CLAUDE_PID

    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.FORCE_COLOR = '3'
    env.TERM_PROGRAM = 'Deeproject'
    return env
  }

  start(opts: PtyStartOptions): PtyStatusEvent {
    const s = this.session(opts.terminalId)
    if (s.pty) this.killPty(s)

    const runId = opts.runId
    s.runId = runId
    s.chunks = []
    s.bufferLength = 0
    s.emitted = 0
    s.exitCode = undefined
    s.pid = undefined
    this.setStatus(s, runId, 'starting')

    const shell = resolveShell(opts.shellId)
    const cwd =
      opts.cwd && existsSync(opts.cwd) ? opts.cwd : process.env.USERPROFILE || process.cwd()
    // A Claude session gets this project's Notion task tools bolted on.
    const command = augmentClaudeCommand(opts.command, opts.projectId)
    const args = buildArgs(shell, command)

    try {
      const p = nodePty.spawn(shell.exe, args, {
        name: 'xterm-256color',
        cols: Math.max(2, opts.cols || 80),
        rows: Math.max(1, opts.rows || 24),
        cwd,
        env: this.childEnv(),
        useConpty: true
      })

      s.pty = p
      // On Windows the real pid is not known until ConPTY's data pipe is ready
      // ("Not available until `ready` event emitted" in node-pty's own source).
      // Reading it now yields 0, and anything downstream that treats 0 as a
      // process id ends up walking the System Idle tree. Poll until it lands,
      // then re-announce so listeners can attach to the right process.
      s.pid = p.pid > 0 ? p.pid : undefined
      if (!s.pid) {
        let attempts = 0
        const timer = setInterval(() => {
          attempts++
          const pid = s.pty === p ? p.pid : 0
          if (pid > 0) {
            clearInterval(timer)
            s.pid = pid
            if (s.runId === runId) this.setStatus(s, runId, s.status)
          } else if (attempts > 40 || s.pty !== p) {
            clearInterval(timer)
          }
        }, 50)
      }

      p.onData((data) => this.emitData(s, runId, data))

      p.onExit(({ exitCode, signal }) => {
        if (runId !== s.runId) return
        s.pty = null
        s.exitCode = exitCode
        this.setStatus(s, runId, 'exited', { exitCode, signal })
      })

      this.setStatus(s, runId, 'running')
    } catch (err) {
      s.pty = null
      const message = err instanceof Error ? err.message : String(err)
      this.emitData(s, runId, `\r\n\x1b[31mFailed to start ${shell.exe}: ${message}\x1b[0m\r\n`)
      this.setStatus(s, runId, 'exited', { error: message, exitCode: -1 })
    }

    return { terminalId: s.id, runId, status: s.status, pid: s.pid, exitCode: s.exitCode }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const p = this.sessions.get(id)?.pty
    if (!p) return
    try {
      p.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    } catch {
      // The process can exit between the renderer measuring and this call.
    }
  }

  private killPty(s: Session): void {
    const p = s.pty
    if (!p) return
    s.pty = null
    try {
      p.kill()
    } catch {
      // Already gone.
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s?.pty) return
    this.killPty(s)
    this.setStatus(s, s.runId, 'stopped')
  }

  /** Renderer (re)connecting to a session; hands back the replay buffer. */
  attach(id: string): PtyAttachResult {
    const s = this.sessions.get(id)
    if (!s) return { status: 'stopped', runId: '', buffer: '', seq: 0 }
    return {
      status: s.status,
      runId: s.runId,
      buffer: s.chunks.join(''),
      seq: s.emitted,
      pid: s.pid,
      exitCode: s.exitCode
    }
  }

  status(id: string): PtyStatus {
    return this.sessions.get(id)?.status ?? 'stopped'
  }

  allStatuses(): Record<string, PtyStatus> {
    const out: Record<string, PtyStatus> = {}
    for (const [id, s] of this.sessions) out[id] = s.status
    return out
  }

  /** Forget a terminal entirely (its tab was deleted). */
  dispose(id: string): void {
    const s = this.sessions.get(id)
    if (s) this.killPty(s)
    this.sessions.delete(id)
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) this.killPty(s)
    this.sessions.clear()
  }
}

export const ptyManager = new PtyManager()

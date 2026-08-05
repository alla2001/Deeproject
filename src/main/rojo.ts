import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createServer } from 'node:net'
import type { RojoState, RojoStatus } from '@shared/types'

const MAX_LOG = 128 * 1024

interface Session {
  projectId: string
  child: ChildProcess | null
  status: RojoStatus
  port: number
  pid: number | null
  message: string | null
  startedAt: number | null
  log: string[]
  logLength: number
}

/** Rojo prints this once the HTTP server is actually listening. */
const READY_PATTERN = /serving on|server listening|visit http/i

/** Wrap in double quotes when cmd.exe would otherwise split the token. */
function quoteArg(value: string): string {
  if (!/[\s&|<>^"]/.test(value)) return value
  return `"${value.replace(/"/g, '\\"')}"`
}

export function findProjectFiles(projectPath: string): string[] {
  try {
    return readdirSync(projectPath, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.project.json'))
      .map((e) => e.name)
      .sort((a, b) => {
        // default.project.json is the conventional entry point.
        if (a === 'default.project.json') return -1
        if (b === 'default.project.json') return 1
        return a.localeCompare(b)
      })
  } catch {
    return []
  }
}

/** True when nothing is already listening on the port. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

class RojoManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  private session(projectId: string, port = 34872): Session {
    let s = this.sessions.get(projectId)
    if (!s) {
      s = {
        projectId,
        child: null,
        status: 'stopped',
        port,
        pid: null,
        message: null,
        startedAt: null,
        log: [],
        logLength: 0
      }
      this.sessions.set(projectId, s)
    }
    return s
  }

  private snapshot(s: Session): RojoState {
    return {
      projectId: s.projectId,
      status: s.status,
      port: s.port,
      pid: s.pid,
      message: s.message,
      startedAt: s.startedAt
    }
  }

  private setStatus(s: Session, status: RojoStatus, message: string | null = null): void {
    s.status = status
    s.message = message
    this.emit('state', this.snapshot(s))
  }

  private appendLog(s: Session, chunk: string): void {
    s.log.push(chunk)
    s.logLength += chunk.length
    while (s.logLength > MAX_LOG && s.log.length > 1) {
      s.logLength -= s.log.shift()!.length
    }
    this.emit('log', { projectId: s.projectId, chunk })
  }

  async start(opts: {
    projectId: string
    projectPath: string
    projectFile: string | null
    port: number
    binary: string
  }): Promise<RojoState> {
    const s = this.session(opts.projectId, opts.port)
    if (s.child) return this.snapshot(s)

    s.port = opts.port
    s.log = []
    s.logLength = 0
    s.pid = null
    s.startedAt = Date.now()
    this.setStatus(s, 'starting')

    if (!existsSync(opts.projectPath)) {
      this.setStatus(s, 'error', `Project folder not found: ${opts.projectPath}`)
      return this.snapshot(s)
    }

    // Resolve the project file so a clearer error than Rojo's own surfaces here.
    let projectFile = opts.projectFile
    if (!projectFile) {
      projectFile = findProjectFiles(opts.projectPath)[0] ?? null
    }
    if (!projectFile) {
      this.setStatus(s, 'error', 'No *.project.json found in this folder.')
      return this.snapshot(s)
    }
    const resolved = isAbsolute(projectFile) ? projectFile : join(opts.projectPath, projectFile)
    if (!existsSync(resolved)) {
      this.setStatus(s, 'error', `Project file not found: ${resolved}`)
      return this.snapshot(s)
    }

    if (!(await isPortFree(opts.port))) {
      this.setStatus(s, 'error', `Port ${opts.port} is already in use.`)
      return this.snapshot(s)
    }

    const binary = opts.binary?.trim() || 'rojo'
    // `shell: true` passes argv through to cmd.exe verbatim, so anything with a
    // space in it (a project under "C:\Users\Some Name\…") has to be quoted
    // here or cmd splits it into separate arguments.
    const command = [binary, 'serve', resolved, '--port', String(opts.port)]
      .map(quoteArg)
      .join(' ')
    this.appendLog(s, `> ${command}\r\n`)

    let child: ChildProcess
    try {
      child = spawn(command, {
        cwd: opts.projectPath,
        windowsHide: true,
        // rojo is often an aftman/foreman shim, so it needs shell resolution.
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.appendLog(s, `\r\n${message}\r\n`)
      this.setStatus(s, 'error', message)
      return this.snapshot(s)
    }

    s.child = child
    s.pid = child.pid ?? null

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    const onOutput = (chunk: string): void => {
      this.appendLog(s, chunk.replace(/\r?\n/g, '\r\n'))
      if (s.status === 'starting' && READY_PATTERN.test(chunk)) {
        this.setStatus(s, 'running')
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    child.on('error', (err) => {
      const message = err.message.includes('ENOENT')
        ? `Could not run "${binary}". Is Rojo installed and on PATH?`
        : err.message
      this.appendLog(s, `\r\n${message}\r\n`)
      s.child = null
      s.pid = null
      this.setStatus(s, 'error', message)
    })

    child.on('exit', (code, signal) => {
      s.child = null
      s.pid = null
      if (s.status === 'stopped') return
      if (code === 0 || signal) {
        this.setStatus(s, 'stopped')
      } else {
        this.setStatus(s, 'error', `Rojo exited with code ${code}`)
      }
    })

    // Rojo's ready line varies by version; treat a process that is still alive
    // shortly after launch as running so the UI doesn't hang on "starting".
    setTimeout(() => {
      if (s.child && s.status === 'starting') this.setStatus(s, 'running')
    }, 2000)

    return this.snapshot(s)
  }

  stop(projectId: string): RojoState {
    const s = this.sessions.get(projectId)
    if (!s) return this.session(projectId) && this.snapshot(this.session(projectId))
    const child = s.child
    s.child = null
    this.setStatus(s, 'stopped')
    if (child?.pid) {
      // Rojo is launched through a shell, so the whole tree has to go.
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        try {
          child.kill()
        } catch {
          // already gone
        }
      }
    }
    s.pid = null
    return this.snapshot(s)
  }

  state(projectId: string): RojoState {
    return this.snapshot(this.session(projectId))
  }

  allStates(): RojoState[] {
    return [...this.sessions.values()].map((s) => this.snapshot(s))
  }

  log(projectId: string): string {
    return this.sessions.get(projectId)?.log.join('') ?? ''
  }

  dispose(projectId: string): void {
    this.stop(projectId)
    this.sessions.delete(projectId)
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
    this.sessions.clear()
  }
}

export const rojoManager = new RojoManager()

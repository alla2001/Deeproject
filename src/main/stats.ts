import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cpus } from 'node:os'
import type { TerminalStats } from '@shared/types'

/**
 * Windows exposes per-process CPU only as cumulative kernel/user tick counters,
 * so usage has to be derived from the delta between two samples. Rather than
 * spawning a PowerShell per poll, one long-lived process emits a compact
 * snapshot on an interval and this class diffs consecutive snapshots.
 */

interface RawProcess {
  /** ProcessId */
  i: number
  /** ParentProcessId */
  p: number
  /** WorkingSetSize, bytes */
  m: number
  /** KernelModeTime + UserModeTime, in 100ns units */
  t: number
  /** Name */
  n: string
  /** CreationDate in ticks; used to reject recycled-pid "children". */
  c: number
}

interface Sample {
  at: number
  byPid: Map<number, RawProcess>
  childrenOf: Map<number, number[]>
}

/** Emits one JSON line per sample; `Write-Host` keeps it off the object pipeline. */
function samplerScript(intervalMs: number): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $rows = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name,CreationDate |
    ForEach-Object {
      [pscustomobject]@{
        i = [int]$_.ProcessId
        p = [int]$_.ParentProcessId
        m = [int64]$_.WorkingSetSize
        t = [int64]($_.KernelModeTime + $_.UserModeTime)
        n = $_.Name
        c = if ($null -eq $_.CreationDate) { 0 } else { [int64]$_.CreationDate.Ticks }
      }
    }
  Write-Host (ConvertTo-Json -InputObject @($rows) -Compress -Depth 3)
  Start-Sleep -Milliseconds ${Math.max(500, intervalMs)}
}`.trim()
}

class StatsMonitor extends EventEmitter {
  private child: ChildProcess | null = null
  private buffer = ''
  private previous: Sample | null = null
  private current: Sample | null = null
  /** terminalId -> root pid of its shell */
  private roots = new Map<string, { pid: number; startedAt: number }>()
  private intervalMs = 2500
  private readonly cores = Math.max(1, cpus().length)
  private powershellPath: string

  constructor() {
    super()
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    this.powershellPath = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  }

  setInterval(ms: number): void {
    if (ms === this.intervalMs) return
    this.intervalMs = ms
    if (this.child) {
      this.stop()
      if (this.roots.size > 0) this.start()
    }
  }

  /**
   * Begin tracking a terminal's process tree. Pids 0 and 4 are the Idle and
   * System processes; walking down from either sweeps in most of the OS, so a
   * not-yet-known pid is refused rather than measured.
   */
  track(terminalId: string, pid: number): void {
    if (!Number.isInteger(pid) || pid <= 4) return
    const existing = this.roots.get(terminalId)
    if (existing?.pid === pid) return
    // Keep the original start time if this is just a late pid correction.
    this.roots.set(terminalId, { pid, startedAt: existing?.startedAt ?? Date.now() })
    this.start()
  }

  untrack(terminalId: string): void {
    this.roots.delete(terminalId)
    if (this.roots.size === 0) this.stop()
  }

  private start(): void {
    if (this.child || this.intervalMs <= 0) return
    try {
      this.child = spawn(
        this.powershellPath,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', samplerScript(this.intervalMs)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      console.error('[stats] could not start sampler', err)
      this.child = null
      return
    }

    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onChunk(chunk))
    this.child.on('error', (err) => console.error('[stats] sampler error', err))
    this.child.on('exit', () => {
      this.child = null
      this.buffer = ''
    })
  }

  private stop(): void {
    const child = this.child
    this.child = null
    this.previous = null
    this.current = null
    this.buffer = ''
    if (!child) return
    try {
      child.kill()
    } catch {
      // already gone
    }
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onSample(line)
      newline = this.buffer.indexOf('\n')
    }
    // A malformed or oversized partial line must not grow without bound.
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = ''
  }

  private onSample(line: string): void {
    let rows: RawProcess[]
    try {
      const parsed = JSON.parse(line)
      rows = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return
    }

    const byPid = new Map<number, RawProcess>()
    const childrenOf = new Map<number, number[]>()
    for (const row of rows) {
      if (!row || typeof row.i !== 'number') continue
      byPid.set(row.i, row)
      const siblings = childrenOf.get(row.p)
      if (siblings) siblings.push(row.i)
      else childrenOf.set(row.p, [row.i])
    }

    this.previous = this.current
    this.current = { at: Date.now(), byPid, childrenOf }
    this.emitStats()
  }

  /**
   * Depth-first walk of a process tree.
   *
   * Windows recycles pids aggressively, and a process whose real parent has
   * exited keeps pointing at that dead pid. Once the pid is handed to something
   * else, the orphan looks like its child. Requiring a child to be no older
   * than its parent throws those impostors out — without it a small shell can
   * be credited with an unrelated multi-gigabyte process tree.
   */
  private collectTree(sample: Sample, root: number): RawProcess[] {
    // Never descend from Idle (0) or System (4) — that is most of the machine.
    if (root <= 4) return []
    const rootProc = sample.byPid.get(root)
    if (!rootProc) return []

    const out: RawProcess[] = []
    const seen = new Set<number>()
    const stack: RawProcess[] = [rootProc]

    while (stack.length > 0) {
      const proc = stack.pop()!
      if (seen.has(proc.i)) continue
      seen.add(proc.i)
      out.push(proc)

      for (const childPid of sample.childrenOf.get(proc.i) ?? []) {
        if (seen.has(childPid)) continue
        const child = sample.byPid.get(childPid)
        if (!child) continue
        // Both timestamps must be known for the check to mean anything.
        if (child.c > 0 && proc.c > 0 && child.c < proc.c) continue
        stack.push(child)
      }
    }
    return out
  }

  private emitStats(): void {
    const current = this.current
    if (!current) return
    const previous = this.previous
    const elapsedMs = previous ? current.at - previous.at : 0

    const all: TerminalStats[] = []
    for (const [terminalId, { pid, startedAt }] of this.roots) {
      const tree = this.collectTree(current, pid)
      if (tree.length === 0) {
        all.push({
          terminalId,
          cpu: 0,
          memory: 0,
          processes: 0,
          topProcess: null,
          pid,
          uptimeMs: Date.now() - startedAt
        })
        continue
      }

      let memory = 0
      let ticks = 0
      let priorTicks = 0
      let hasPrior = previous !== null
      for (const proc of tree) {
        memory += proc.m
        ticks += proc.t
        const before = previous?.byPid.get(proc.i)
        // A process that appeared since the last sample has no baseline, so its
        // whole lifetime would look like a CPU spike. Skip the delta this round.
        if (before) priorTicks += before.t
        else hasPrior = false
      }

      let cpu = 0
      if (hasPrior && elapsedMs > 0) {
        // Ticks are 100ns units: 10,000 ticks per millisecond, per core.
        const busyMs = (ticks - priorTicks) / 10_000
        cpu = (busyMs / (elapsedMs * this.cores)) * 100
        if (!Number.isFinite(cpu) || cpu < 0) cpu = 0
        if (cpu > 100) cpu = 100
      }

      // The shell itself is rarely interesting; surface the busiest descendant.
      const descendants = tree.filter((p) => p.i !== pid)
      const top = descendants.sort((a, b) => b.m - a.m)[0] ?? tree[0]

      all.push({
        terminalId,
        cpu: Math.round(cpu * 10) / 10,
        memory,
        processes: tree.length,
        topProcess: top?.n ?? null,
        pid,
        uptimeMs: Date.now() - startedAt
      })
    }

    if (all.length > 0) this.emit('stats', all)
  }

  dispose(): void {
    this.roots.clear()
    this.stop()
  }
}

export const statsMonitor = new StatsMonitor()

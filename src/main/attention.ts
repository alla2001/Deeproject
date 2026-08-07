import { EventEmitter } from 'node:events'
import type { TerminalAttention, TerminalStats } from '@shared/types'

/**
 * Works out which terminals want you.
 *
 * The app exists to run several Claude sessions at once, which means most of
 * them are unattended most of the time. Without something watching, the only
 * way to notice that one has finished — or has stopped to ask a question — is
 * to click through the tabs, which is exactly the polling the app is supposed
 * to remove.
 *
 * Two signals are available without asking the sessions to cooperate:
 *
 * - **The bell.** A CLI that wants attention writes BEL, and Claude Code does.
 *   When it arrives there is nothing to infer.
 * - **Going quiet.** A session that was producing output and then stops, with
 *   no CPU left in its process tree, has either finished or is sitting at a
 *   prompt. Either way it is yours again.
 *
 * Quiet alone would be wrong for a session thinking hard between tool calls, so
 * CPU is required to agree when the resource monitor is running. When it isn't,
 * output timing decides on its own and the wait is a little longer.
 *
 * "Wants you" is deliberately sticky: it is cleared when that terminal is
 * actually looked at, not on a timer, so a session that finishes while you are
 * in another window is still flagged when you come back.
 */

/** Above this share of one machine's CPU, a tree counts as still working. */
const BUSY_CPU = 3
/** Extra quiet needed before calling it, when no CPU reading is available. */
const NO_STATS_GRACE_MS = 4000
/**
 * How long a run gets before silence means anything.
 *
 * Every shell prints something and then stops: cmd writes its banner, Claude
 * draws its welcome and waits for a prompt. That is a terminal doing exactly
 * what was asked of it, not one coming back to you, and flagging it seconds
 * after you opened the tab you are already looking at is pure noise. Only the
 * quiet path needs this — a bell is an explicit request whenever it arrives,
 * and an exit speaks for itself.
 */
const STARTUP_GRACE_MS = 15_000
/** How much trailing output to keep, for the notification and the tooltip. */
const TAIL_LIMIT = 400

interface Watch {
  /** When the current run started. */
  startedAt: number
  /** Last time this terminal wrote anything. */
  lastOutputAt: number
  /** Last CPU reading for its tree, or null when the monitor is off. */
  cpu: number | null
  /** Whether the current run has produced output worth waiting on. */
  produced: boolean
  activity: TerminalAttention['activity']
  needsYou: boolean
  since: number | null
  /** Why it is asking: it rang, it went quiet, or it exited. */
  reason: TerminalAttention['reason']
  tail: string
  running: boolean
}

/**
 * Operating System Command sequences — how a shell sets the window title.
 *
 * These matter more than they look. An OSC string is terminated by BEL, and
 * ConPTY sends one the moment a shell starts, so a naive search for BEL finds a
 * "bell" in every terminal within a second of opening it. They have to come out
 * before anything else is asked of the stream.
 */
// eslint-disable-next-line no-control-regex
const OSC = /\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g
/** Cursor movement, colour, character-set selection: layout, not content. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][B0]|\x1b[=>78MD]/g
/** What is left that still isn't text. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g

function stripEscapes(data: string): string {
  return data.replace(OSC, '').replace(ESCAPES, '')
}

/** True when the stream carries a real bell rather than an OSC terminator. */
function rang(data: string): boolean {
  return stripEscapes(data).includes('\x07')
}

function clean(data: string): string {
  return stripEscapes(data).replace(CONTROLS, '')
}

class AttentionWatcher extends EventEmitter {
  private watches = new Map<string, Watch>()
  private timer: NodeJS.Timeout | null = null
  /** Quiet needed before a terminal counts as waiting. 0 disables the whole thing. */
  private idleMs = 6000
  /** The terminal the user is currently looking at, if the window has focus. */
  private focused: string | null = null
  private windowFocused = true

  private watch(id: string): Watch {
    let w = this.watches.get(id)
    if (!w) {
      w = {
        startedAt: 0,
        lastOutputAt: 0,
        cpu: null,
        produced: false,
        activity: 'idle',
        needsYou: false,
        since: null,
        reason: null,
        tail: '',
        running: false
      }
      this.watches.set(id, w)
    }
    return w
  }

  setIdleMs(ms: number): void {
    this.idleMs = Math.max(0, ms)
    if (this.idleMs === 0) {
      // Turning it off should clear what it already flagged, not freeze it.
      for (const id of [...this.watches.keys()]) this.seen(id)
      this.stopTimer()
    } else if (this.watches.size > 0) {
      this.startTimer()
    }
  }

  /** Called for every chunk a terminal produces. */
  onData(id: string, data: string): void {
    const w = this.watch(id)
    w.lastOutputAt = Date.now()

    const text = clean(data)
    if (text.trim()) {
      w.produced = true
      w.tail = (w.tail + text).slice(-TAIL_LIMIT)
    }

    // A bell is a request, not a hint; it does not wait for the quiet period.
    if (this.idleMs > 0 && rang(data)) {
      this.flag(id, w, 'bell')
      return
    }

    if (w.activity !== 'busy') {
      w.activity = 'busy'
      this.publish()
    }
    this.startTimer()
  }

  onStatus(id: string, status: string): void {
    const w = this.watch(id)
    const running = status === 'running' || status === 'starting'
    if (status === 'starting') {
      w.startedAt = Date.now()
      // A fresh run starts from nothing; last run's tail is not this one's.
      w.produced = false
      w.tail = ''
      this.clear(w)
    }
    // Exiting is the clearest "it is yours again" there is — but only for a run
    // that actually did something, so closing an idle shell stays silent.
    if (w.running && !running && w.produced && this.idleMs > 0) {
      this.flag(id, w, 'exited')
    }
    w.running = running
    if (!running) w.activity = 'idle'
    this.publish()
  }

  /** Latest CPU readings, so a thinking session is not mistaken for a finished one. */
  onStats(all: TerminalStats[]): void {
    for (const stat of all) {
      const w = this.watches.get(stat.terminalId)
      if (w) w.cpu = stat.cpu
    }
  }

  /** The resource monitor was turned off; stop trusting stale CPU readings. */
  clearStats(): void {
    for (const w of this.watches.values()) w.cpu = null
  }

  /**
   * Which terminal the user is looking at. Anything flagged for it is cleared
   * immediately, and stays clear while it is in front.
   */
  setFocus(terminalId: string | null, windowFocused: boolean): void {
    this.focused = terminalId
    this.windowFocused = windowFocused
    if (windowFocused && terminalId) this.seen(terminalId)
  }

  /** Mark a terminal as looked at. */
  seen(id: string): void {
    const w = this.watches.get(id)
    if (!w || !w.needsYou) return
    this.clear(w)
    this.publish()
  }

  seenAll(): void {
    let changed = false
    for (const w of this.watches.values()) {
      if (!w.needsYou) continue
      this.clear(w)
      changed = true
    }
    if (changed) this.publish()
  }

  dispose(id: string): void {
    if (this.watches.delete(id)) this.publish()
    if (this.watches.size === 0) this.stopTimer()
  }

  states(): Record<string, TerminalAttention> {
    const out: Record<string, TerminalAttention> = {}
    for (const [id, w] of this.watches) {
      out[id] = {
        activity: w.activity,
        needsYou: w.needsYou,
        since: w.since,
        reason: w.reason,
        tail: w.tail.trimEnd().split('\n').slice(-3).join('\n').trim()
      }
    }
    return out
  }

  private clear(w: Watch): void {
    w.needsYou = false
    w.since = null
    w.reason = null
  }

  private flag(id: string, w: Watch, reason: NonNullable<TerminalAttention['reason']>): void {
    w.activity = 'waiting'
    // Looking straight at it is the same as having already dealt with it.
    if (this.windowFocused && this.focused === id) {
      this.clear(w)
      this.publish()
      return
    }
    if (w.needsYou) return
    w.needsYou = true
    w.since = Date.now()
    w.reason = reason
    this.publish()
    this.emit('attention', { terminalId: id, reason, tail: w.tail.trim().slice(-200) })
  }

  /** Look for terminals that have gone quiet. */
  private sweep(): void {
    if (this.idleMs === 0) return
    const now = Date.now()
    let busy = false

    for (const [id, w] of this.watches) {
      if (!w.running || w.activity === 'waiting') continue
      if (w.activity !== 'busy') continue
      busy = true

      const quietFor = now - w.lastOutputAt
      // Without a CPU reading there is nothing to corroborate the silence, so
      // wait longer before speaking up rather than guessing early.
      const needed = w.cpu === null ? this.idleMs + NO_STATS_GRACE_MS : this.idleMs
      if (quietFor < needed) continue
      if (w.cpu !== null && w.cpu > BUSY_CPU) continue
      // A shell that has only just printed its banner is not asking for you.
      if (now - w.startedAt < STARTUP_GRACE_MS) continue
      if (!w.produced) {
        // Nothing has happened in this run; going quiet means nothing either.
        w.activity = 'idle'
        continue
      }
      this.flag(id, w, 'quiet')
    }

    if (!busy) this.stopTimer()
  }

  private startTimer(): void {
    if (this.timer || this.idleMs === 0) return
    // A second is fine: the thresholds are seconds, and this only walks a map.
    this.timer = setInterval(() => this.sweep(), 1000)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private publish(): void {
    this.emit('update', this.states())
  }
}

export const attentionWatcher = new AttentionWatcher()

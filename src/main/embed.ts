import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { EmbedAttachResult, EmbedBounds, EmbedCandidate, EmbedState } from '@shared/types'

/**
 * Docks a real Windows application inside one of our panels.
 *
 * The mechanism is window reparenting: take the target's top-level HWND, strip
 * the styles that make it a top-level window, make it a WS_CHILD of our
 * BrowserWindow, and move it to the panel's rectangle whenever that changes.
 * The app keeps running in its own process and knows nothing about us.
 *
 * Two consequences are worth knowing before reading further:
 *
 * - A native child HWND composites *above* everything Chromium paints, so the
 *   embedded app covers our own UI. Modals, the palette and menus therefore ask
 *   for embeds to be hidden while they are up; see `setVisible`.
 * - Windows destroys child windows along with their parent. If our window went
 *   away while something was still attached, we would take the user's
 *   application down with us — so `detachAll` runs on window close as well as
 *   on quit, and is the single most important call in this file.
 *
 * koffi is used rather than a compiled addon because it ships prebuilt N-API
 * binaries, which keeps `npm install` free of a C++ toolchain.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (...args: any[]) => any

let user32: Record<string, Fn> | null = null
let kernel32: Record<string, Fn> | null = null
let koffiLib: typeof import('koffi') | null = null
/** Callback prototype for EnumWindows; registered once, koffi rejects a repeat. */
let enumProc: unknown = null
let loadError: string | null = null

const GWL_STYLE = -16
const GWL_EXSTYLE = -20

const WS_CHILD = 0x40000000
const WS_POPUP = 0x80000000
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const WS_MINIMIZEBOX = 0x00020000
const WS_MAXIMIZEBOX = 0x00010000
const WS_SYSMENU = 0x00080000
const WS_EX_APPWINDOW = 0x00040000

const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020
const SWP_SHOWWINDOW = 0x0040

const SW_HIDE = 0
const SW_MAXIMIZE = 3
const SW_SHOWNA = 8
const SW_RESTORE = 9

const GA_PARENT = 1

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** Window classes that are the shell itself; reparenting one wrecks the desktop. */
const FORBIDDEN_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Button'])

/**
 * Store apps are hosted by ApplicationFrameHost rather than owning their own
 * window, so the HWND we can see is a frame that does not survive reparenting.
 */
const UWP_CLASSES = new Set(['ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow'])

function load(): boolean {
  if (user32) return true
  if (loadError) return false
  try {
    // Required lazily so a missing binary degrades this one feature rather than
    // preventing the app from starting.
    const koffi = require('koffi') as typeof import('koffi')
    koffiLib = koffi

    const u = koffi.load('user32.dll')
    const k = koffi.load('kernel32.dll')

    enumProc = koffi.proto('bool __stdcall EnumWindowsProc(int64_t hwnd, int64_t lParam)')

    // HWNDs cross as int64 rather than pointers so they can be plain numbers in
    // IPC payloads and React props; every real handle fits in a double.
    user32 = {
      EnumWindows: u.func('bool __stdcall EnumWindows(EnumWindowsProc *proc, int64_t lParam)'),
      IsWindow: u.func('bool __stdcall IsWindow(int64_t hWnd)'),
      IsWindowVisible: u.func('bool __stdcall IsWindowVisible(int64_t hWnd)'),
      IsIconic: u.func('bool __stdcall IsIconic(int64_t hWnd)'),
      IsZoomed: u.func('bool __stdcall IsZoomed(int64_t hWnd)'),
      GetWindowTextW: u.func('int __stdcall GetWindowTextW(int64_t hWnd, void *s, int n)'),
      GetClassNameW: u.func('int __stdcall GetClassNameW(int64_t hWnd, void *s, int n)'),
      GetWindowThreadProcessId: u.func(
        'uint32_t __stdcall GetWindowThreadProcessId(int64_t hWnd, void *pid)'
      ),
      GetWindowLongPtrW: u.func('int64_t __stdcall GetWindowLongPtrW(int64_t hWnd, int index)'),
      SetWindowLongPtrW: u.func(
        'int64_t __stdcall SetWindowLongPtrW(int64_t hWnd, int index, int64_t value)'
      ),
      SetParent: u.func('int64_t __stdcall SetParent(int64_t child, int64_t parent)'),
      GetParent: u.func('int64_t __stdcall GetParent(int64_t hWnd)'),
      // GetParent reports NULL for anything lacking WS_CHILD, which is useless
      // for checking whether a reparent landed; GetAncestor answers regardless
      // of style, returning the desktop for a window that is genuinely loose.
      GetAncestor: u.func('int64_t __stdcall GetAncestor(int64_t hWnd, uint32_t flags)'),
      GetWindowRect: u.func('bool __stdcall GetWindowRect(int64_t hWnd, void *rect)'),
      SetWindowPos: u.func(
        'bool __stdcall SetWindowPos(int64_t hWnd, int64_t after, int x, int y, int cx, int cy, uint32_t flags)'
      ),
      ShowWindow: u.func('bool __stdcall ShowWindow(int64_t hWnd, int cmd)'),
      SetFocus: u.func('int64_t __stdcall SetFocus(int64_t hWnd)'),
      AttachThreadInput: u.func(
        'bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)'
      ),
      SetForegroundWindow: u.func('bool __stdcall SetForegroundWindow(int64_t hWnd)'),
      SetActiveWindow: u.func('int64_t __stdcall SetActiveWindow(int64_t hWnd)'),
      // A null RECT* releases the confinement, hence `void *` rather than a
      // typed pointer here.
      ClipCursor: u.func('bool __stdcall ClipCursor(void *rect)'),
      SetCursorPos: u.func('bool __stdcall SetCursorPos(int x, int y)')
    }
    kernel32 = {
      GetCurrentThreadId: k.func('uint32_t __stdcall GetCurrentThreadId()'),
      GetLastError: k.func('uint32_t __stdcall GetLastError()'),
      SetLastError: k.func('void __stdcall SetLastError(uint32_t code)'),
      OpenProcess: k.func('int64_t __stdcall OpenProcess(uint32_t a, bool i, uint32_t pid)'),
      QueryFullProcessImageNameW: k.func(
        'bool __stdcall QueryFullProcessImageNameW(int64_t h, uint32_t f, void *buf, void *size)'
      ),
      CloseHandle: k.func('bool __stdcall CloseHandle(int64_t h)')
    }
    return true
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    console.error('[embed] FFI unavailable:', loadError)
    return false
  }
}

function decode(buf: Buffer, chars: number): string {
  return buf.toString('ucs2', 0, Math.max(0, chars) * 2)
}

function windowText(hwnd: number): string {
  const buf = Buffer.alloc(1024)
  const n = user32!.GetWindowTextW(hwnd, buf, 512)
  return n > 0 ? decode(buf, n) : ''
}

function windowClass(hwnd: number): string {
  const buf = Buffer.alloc(512)
  const n = user32!.GetClassNameW(hwnd, buf, 256)
  return n > 0 ? decode(buf, n) : ''
}

function windowPid(hwnd: number): number {
  const out = Buffer.alloc(4)
  user32!.GetWindowThreadProcessId(hwnd, out)
  return out.readUInt32LE(0)
}

function exeForPid(pid: number): string {
  const handle = kernel32!.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    const buf = Buffer.alloc(2048)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(1024, 0)
    if (!kernel32!.QueryFullProcessImageNameW(handle, 0, buf, size)) return ''
    return decode(buf, size.readUInt32LE(0))
  } catch {
    return ''
  } finally {
    kernel32!.CloseHandle(handle)
  }
}

function windowRect(hwnd: number): { x: number; y: number; width: number; height: number } | null {
  const buf = Buffer.alloc(16)
  if (!user32!.GetWindowRect(hwnd, buf)) return null
  const left = buf.readInt32LE(0)
  const top = buf.readInt32LE(4)
  const right = buf.readInt32LE(8)
  const bottom = buf.readInt32LE(12)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** JS bitwise is 32-bit signed; window styles are unsigned, hence the >>> 0. */
function clearBits(value: number, mask: number): number {
  return (value & ~mask) >>> 0
}

function setBits(value: number, mask: number): number {
  return (value | mask) >>> 0
}

/**
 * Turn a SetParent failure into something the user can act on. The codes worth
 * naming are the ones with a fix; anything else is reported verbatim so a bug
 * report carries the number.
 */
function reparentError(code: number): string {
  switch (code) {
    case 5: // ERROR_ACCESS_DENIED
      return 'Windows refused to dock that app because it runs with higher privileges than Deeproject. Restart Deeproject as administrator, or start that app without elevation.'
    case 1400: // ERROR_INVALID_WINDOW_HANDLE
      return 'That window closed while it was being docked.'
    case 0:
      return 'That app moved its window back out on its own; it cannot be docked.'
    default:
      return `Windows refused to dock that window (error ${code}).`
  }
}

function enumerateHwnds(): number[] {
  const found: number[] = []
  const cb = koffiLib!.register(
    (hwnd: number) => {
      found.push(hwnd)
      return true
    },
    koffiLib!.pointer(enumProc as never)
  )
  try {
    user32!.EnumWindows(cb, 0)
  } finally {
    koffiLib!.unregister(cb)
  }
  return found
}

interface Saved {
  style: number
  exStyle: number
  rect: { x: number; y: number; width: number; height: number } | null
  /** Restored to this state on detach, rather than to a bare style bit. */
  wasMaximized: boolean
  pid: number
  title: string
  exe: string
  /** The panel window this was docked into, so drift back out can be undone. */
  parent: number
  /** Where the panel last asked it to sit, replayed after a forced re-attach. */
  bounds: EmbedBounds | null
  /** How many times the app has pulled itself back out; see `startWatchdog`. */
  escapes: number
  /** Consecutive watchdog ticks the window has stayed put. */
  settled: number
}

/**
 * How many times an application may undo the reparent before we stop fighting
 * it. Toolkits that keep their own idea of the window hierarchy — Qt is the one
 * that shows up in practice — reconcile it after a style change and put the
 * window back on the desktop. Re-asserting wins against a one-off reconcile;
 * against an app that does it continuously it would only produce a flicker, so
 * past this count the dock is abandoned and reported.
 */
const MAX_ESCAPES = 4

/**
 * Watchdog ticks — seconds — of staying put that earn an application a clean
 * slate. Without this, one that jumps out on some occasional event of its own,
 * such as opening a file, would eventually exhaust its allowance over a long
 * session despite behaving the rest of the time.
 */
const SETTLED_TICKS = 30

class EmbedManager extends EventEmitter {
  private attached = new Map<number, Saved>()
  private watchdog: NodeJS.Timeout | null = null
  /** The docked window currently holding the mouse, if any. */
  private captured: number | null = null
  /** The app thread currently sharing our input queue; see `bindInput`. */
  private inputBound: { hwnd: number; thread: number } | null = null
  /** The embed whose panel is in front, restored when our window regains focus. */
  private activeEmbed: number | null = null

  available(): boolean {
    return load()
  }

  unavailableReason(): string | null {
    return load() ? null : (loadError ?? 'The window-embedding library did not load.')
  }

  /** Every visible, titled top-level window that could plausibly be docked. */
  list(): EmbedCandidate[] {
    if (!load()) return []
    const out: EmbedCandidate[] = []

    for (const hwnd of enumerateHwnds()) {
      if (!user32!.IsWindowVisible(hwnd)) continue
      const title = windowText(hwnd).trim()
      if (!title) continue

      const className = windowClass(hwnd)
      if (FORBIDDEN_CLASSES.has(className)) continue

      const pid = windowPid(hwnd)
      // Docking ourselves into ourselves would recurse until something gave.
      if (pid === process.pid) continue
      if (this.attached.has(hwnd)) continue

      out.push({
        hwnd,
        pid,
        title,
        className,
        exe: exeForPid(pid),
        unsupported: UWP_CLASSES.has(className)
          ? 'Store apps run inside a shared host window and cannot be docked.'
          : null
      })
    }

    out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
    return out
  }

  attach(hwnd: number, parentHwnd: number): EmbedAttachResult {
    if (!load()) return { ok: false, error: this.unavailableReason() ?? 'Unavailable.' }
    if (!user32!.IsWindow(hwnd)) return { ok: false, error: 'That window no longer exists.' }
    if (this.attached.has(hwnd)) return { ok: false, error: 'That window is already docked.' }

    const pid = windowPid(hwnd)
    if (pid === process.pid) return { ok: false, error: 'Deeproject cannot dock its own window.' }

    const className = windowClass(hwnd)
    if (FORBIDDEN_CLASSES.has(className)) {
      return { ok: false, error: 'That window belongs to the Windows shell.' }
    }

    // A maximised or minimised window carries state that survives reparenting
    // and leaves it wrongly sized inside the panel, so normalise it first — and
    // do that *before* recording what to put back, otherwise detach would write
    // a style claiming "maximised" and then immediately contradict it. The
    // restored geometry is also the rectangle worth returning the window to.
    const wasMaximized = Boolean(user32!.IsZoomed(hwnd))
    if (wasMaximized || user32!.IsIconic(hwnd)) {
      user32!.ShowWindow(hwnd, SW_RESTORE)
    }

    const saved: Saved = {
      style: Number(user32!.GetWindowLongPtrW(hwnd, GWL_STYLE)) >>> 0,
      exStyle: Number(user32!.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0,
      rect: windowRect(hwnd),
      wasMaximized,
      pid,
      title: windowText(hwnd),
      exe: exeForPid(pid),
      parent: parentHwnd,
      bounds: null,
      escapes: 0,
      settled: 0
    }

    try {
      const code = this.reparent(hwnd, saved)
      if (code !== null) {
        this.restoreWindow(hwnd, saved)
        return { ok: false, error: reparentError(code) }
      }
      // A toolkit that recreates its window on a style change destroys this
      // handle behind our back, and every later call would silently no-op
      // against a dead HWND.
      if (!user32!.IsWindow(hwnd)) {
        return { ok: false, error: 'That application replaced its window instead of docking it.' }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.restoreWindow(hwnd, saved)
      return { ok: false, error: `Could not dock that window: ${message}` }
    }

    this.attached.set(hwnd, saved)
    this.startWatchdog()
    return {
      ok: true,
      state: { hwnd, pid, title: saved.title, exe: saved.exe, alive: true }
    }
  }

  /**
   * Make the window a child of the panel and dress it as one.
   *
   * Returns null on success, or a Win32 error code describing why the window is
   * not our child afterwards — 0 meaning the call reported success and the
   * window still ended up somewhere else.
   *
   * The reparent goes first and the styles second. The reverse order asks
   * Windows to hold a WS_CHILD window whose parent is still the desktop, which
   * is not a legal configuration; toolkits that rebuild their native window in
   * response to WM_STYLECHANGED can react to that intermediate state by
   * throwing the HWND away.
   *
   * Cross-process SetParent attaches the two threads' input queues, so a hang
   * in the embedded app can stall our UI thread too. Nothing can be done about
   * that beyond detaching promptly when it goes wrong.
   */
  private reparent(hwnd: number, saved: Saved): number | null {
    // Cleared first, so a nonzero code afterwards genuinely belongs to this call.
    kernel32!.SetLastError(0)
    user32!.SetParent(hwnd, saved.parent)
    const code = Number(kernel32!.GetLastError())

    const style = setBits(
      clearBits(
        saved.style,
        WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU
      ),
      WS_CHILD
    )
    user32!.SetWindowLongPtrW(hwnd, GWL_STYLE, style)
    // Keeping WS_EX_APPWINDOW would leave a ghost entry on the taskbar.
    user32!.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, clearBits(saved.exStyle, WS_EX_APPWINDOW))

    user32!.SetWindowPos(
      hwnd,
      0,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW
    )

    // SetParent reports failure only through its return value, and a refusal
    // used to leave the window untouched on the desktop while we drew a panel
    // claiming it was docked. Ask Windows where the window ended up rather than
    // assuming — and ask only now, because until WS_CHILD is set there is
    // nothing to see.
    return this.parentOf(hwnd) === saved.parent ? null : code
  }

  /** The real parent, which for a loose window is the desktop rather than 0. */
  private parentOf(hwnd: number): number {
    return Number(user32!.GetAncestor(hwnd, GA_PARENT))
  }

  /**
   * Hand the window back to the desktop, restoring the styles and position it
   * had before we took it. Safe to call for an unknown or dead hwnd.
   */
  detach(hwnd: number): boolean {
    // Never leave the cursor fenced into a window we are about to let go of,
    // nor our UI thread tied to one we no longer host.
    if (this.captured === hwnd) this.releaseMouse()
    this.blur(hwnd)
    const saved = this.attached.get(hwnd)
    this.attached.delete(hwnd)
    if (this.attached.size === 0) this.stopWatchdog()
    if (!saved || !load()) return false
    return this.restoreWindow(hwnd, saved)
  }

  /**
   * Put a window back the way we found it. Used both when the user undocks and
   * when an attach gives up part-way through, so that a refused dock leaves no
   * trace on the user's application.
   */
  private restoreWindow(hwnd: number, saved: Saved): boolean {
    if (!user32!.IsWindow(hwnd)) return false
    try {
      user32!.SetParent(hwnd, 0)
      user32!.SetWindowLongPtrW(hwnd, GWL_STYLE, saved.style)
      user32!.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, saved.exStyle)
      const r = saved.rect
      user32!.SetWindowPos(
        hwnd,
        0,
        r?.x ?? 80,
        r?.y ?? 80,
        r?.width ?? 1024,
        r?.height ?? 720,
        SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW
      )
      // A window docked while maximised goes back to being maximised; one that
      // was minimised comes back visible rather than vanishing to the taskbar.
      user32!.ShowWindow(hwnd, saved.wasMaximized ? SW_MAXIMIZE : SW_RESTORE)
      return true
    } catch (err) {
      console.error('[embed] restore failed', err)
      return false
    }
  }

  /**
   * Release everything. Called on window close as well as on quit: Windows
   * destroys child windows with their parent, so an attached app would die with
   * us otherwise.
   */
  detachAll(): void {
    for (const hwnd of [...this.attached.keys()]) this.detach(hwnd)
  }

  setBounds(hwnd: number, bounds: EmbedBounds): void {
    if (!load()) return
    const saved = this.attached.get(hwnd)
    if (!saved) return
    if (!user32!.IsWindow(hwnd)) return
    // Remembered so a window that escapes and gets pulled back in resumes the
    // panel's geometry instead of whatever size it gave itself outside.
    saved.bounds = bounds

    const width = Math.round(bounds.width)
    const height = Math.round(bounds.height)
    // A hidden dockview panel measures as zero; nothing useful to show.
    if (width < 8 || height < 8) {
      user32!.ShowWindow(hwnd, SW_HIDE)
      return
    }
    user32!.SetWindowPos(
      hwnd,
      0,
      Math.round(bounds.x),
      Math.round(bounds.y),
      width,
      height,
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
    )

    // A captured cursor is confined to where the panel *was*; dragging a dock
    // divider mid-game would otherwise leave the mouse fenced off the game.
    if (this.captured === hwnd) {
      const moved = windowRect(hwnd)
      if (moved) this.applyClip(moved)
    }
  }

  /**
   * Show or hide without detaching. A native child window paints over anything
   * Chromium draws, so our own overlays — modals, the command palette, context
   * menus — hide every embed while they are open.
   */
  setVisible(hwnd: number, visible: boolean): void {
    if (!load() || !this.attached.has(hwnd)) return
    if (!user32!.IsWindow(hwnd)) return
    // Hiding a game that holds the mouse would strand the cursor in a rectangle
    // with nothing visible in it.
    if (!visible && this.captured === hwnd) this.releaseMouse()
    if (!visible) this.blur(hwnd)
    user32!.ShowWindow(hwnd, visible ? SW_SHOWNA : SW_HIDE)
  }

  setAllVisible(visible: boolean): void {
    for (const hwnd of this.attached.keys()) this.setVisible(hwnd, visible)
  }

  /**
   * Hand the mouse and keyboard to a docked game.
   *
   * Games confine the cursor themselves with ClipCursor, but they compute the
   * rectangle from their own window — which, once reparented, is the panel. So
   * the useful thing to add is the confinement they *don't* do while they think
   * they are unfocused, plus a guarantee that the pointer cannot wander onto
   * the sidebar mid-aim. The cursor is parked in the middle first, because a
   * mouse-look engine takes its first delta from wherever it starts.
   *
   * Nothing here can be undone by the game itself, so `releaseMouse` has to be
   * reachable from a global hotkey rather than from the UI underneath.
   */
  captureMouse(hwnd: number): boolean {
    if (!load() || !this.attached.has(hwnd)) return false
    if (!user32!.IsWindow(hwnd)) return false

    const rect = windowRect(hwnd)
    if (!rect || rect.width < 8 || rect.height < 8) return false

    const parent = Number(user32!.GetParent(hwnd))
    if (parent) {
      // Keyboard input follows the foreground window, which is ours, not the
      // child's — so both have to be pointed at the game.
      user32!.SetForegroundWindow(parent)
    }
    this.focus(hwnd)
    user32!.SetActiveWindow(hwnd)

    user32!.SetCursorPos(
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2)
    )
    this.applyClip(rect)
    this.captured = hwnd
    this.emit('capture', hwnd)
    return true
  }

  /** GetWindowRect is already in screen coordinates, which is what ClipCursor wants. */
  private applyClip(rect: { x: number; y: number; width: number; height: number }): void {
    const buf = Buffer.alloc(16)
    buf.writeInt32LE(rect.x, 0)
    buf.writeInt32LE(rect.y, 4)
    buf.writeInt32LE(rect.x + rect.width, 8)
    buf.writeInt32LE(rect.y + rect.height, 12)
    user32!.ClipCursor(buf)
  }

  /**
   * Give the mouse back. Releasing the clip is not enough on its own: a game
   * that still holds focus simply re-clips on its next frame, so the foreground
   * has to move off it as well.
   */
  releaseMouse(): void {
    if (!load()) return
    // Only ever release a clip we put there. ClipCursor is global, so clearing
    // it unconditionally — this runs on every window blur — would free the
    // cursor of whatever else had confined it, such as a fullscreen game the
    // user just alt-tabbed away from.
    const hwnd = this.captured
    if (hwnd === null) return
    this.captured = null
    user32!.ClipCursor(null)
    if (hwnd && user32!.IsWindow(hwnd)) {
      const parent = Number(user32!.GetParent(hwnd))
      if (parent) {
        user32!.SetForegroundWindow(parent)
        user32!.SetFocus(parent)
      }
    }
    this.emit('capture', null)
  }

  capturedWindow(): number | null {
    return this.captured
  }

  /** Move keyboard focus into the embedded app, and keep input working there. */
  focus(hwnd: number): void {
    if (!load() || !this.attached.has(hwnd)) return
    if (!user32!.IsWindow(hwnd)) return
    this.activeEmbed = hwnd
    if (!this.bindInput(hwnd)) return
    user32!.SetFocus(hwnd)
  }

  /** Its panel stopped being the active one, so it stops owning input. */
  blur(hwnd: number): void {
    if (!load()) return
    if (this.activeEmbed === hwnd) this.activeEmbed = null
    if (this.inputBound?.hwnd !== hwnd) return
    this.unbindInput()
  }

  /**
   * Our window went to the background. Holding another thread's input queue
   * from back there buys nothing and leaves our UI waiting on it, so the
   * binding is dropped — but which embed was in front is remembered, so
   * `refocus` can restore it rather than making the user click twice.
   */
  suspendInput(): void {
    if (!load()) return
    this.unbindInput()
  }

  /** Our window came back to the front. */
  refocus(): void {
    if (!load()) return
    const hwnd = this.activeEmbed
    if (hwnd === null || !this.attached.has(hwnd)) return
    this.focus(hwnd)
  }

  /**
   * Share our input queue with the embedded application's thread, for as long
   * as its panel is the active one.
   *
   * This is what makes the mouse behave inside a docked window. Windows gives
   * mouse capture, focus and activation to one *input queue*, and the queue
   * that owns them is our own — the embedded app's window is only a child, and
   * a child can never be the foreground window. An app whose thread has its own
   * queue therefore believes it is in the background, and Windows enforces
   * that belief: `SetCapture` is documented to work only for the foreground
   * window, so a click-and-drag that leaves the window — selecting text past
   * the edge, dragging a slider — stops being delivered halfway through. Games
   * that gate mouse-look on having focus simply never start.
   *
   * Attaching the two queues makes the app's thread part of the same
   * foreground, and capture, `GetFocus` and `WM_SETFOCUS` all start telling it
   * the truth. The cost is that the threads then block on each other, so a
   * hang in the embedded app can stall our UI — which is why this is held only
   * while its panel is genuinely in front, and dropped on blur, on hide and on
   * undock.
   *
   * Games that ask `GetForegroundWindow` rather than `GetFocus` are beyond
   * this: the answer is our window and cannot be theirs while they are hosted.
   */
  private bindInput(hwnd: number): boolean {
    const theirs = Number(user32!.GetWindowThreadProcessId(hwnd, null))
    if (!theirs) return false
    if (this.inputBound?.thread === theirs) {
      this.inputBound.hwnd = hwnd
      return true
    }
    this.unbindInput()

    const ours = Number(kernel32!.GetCurrentThreadId())
    // Nothing to attach when the app somehow shares our thread, but focus still
    // has to move, so this counts as success.
    if (ours === theirs) return true
    if (!user32!.AttachThreadInput(ours, theirs, true)) return false
    this.inputBound = { hwnd, thread: theirs }
    return true
  }

  private unbindInput(): void {
    const bound = this.inputBound
    if (!bound) return
    this.inputBound = null
    const ours = Number(kernel32!.GetCurrentThreadId())
    // Fails harmlessly if the other thread has already exited.
    user32!.AttachThreadInput(ours, bound.thread, false)
  }

  /**
   * Launch an executable and wait for the window it puts on screen.
   *
   * The pid is not enough to find it: installers, bootstrappers and Studio all
   * hand off to a different process. Comparing the set of top-level windows
   * before and after catches the window whoever ends up owning it.
   */
  async launch(exePath: string, args: string[] = [], timeoutMs = 30_000): Promise<number | null> {
    if (!load()) return null
    const before = new Set(enumerateHwnds())
    const wanted = basename(exePath).toLowerCase()

    try {
      const child = spawn(exePath, args, { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (err) {
      console.error('[embed] launch failed', err)
      return null
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      let fallback: number | null = null

      for (const hwnd of enumerateHwnds()) {
        if (before.has(hwnd)) continue
        if (!user32!.IsWindowVisible(hwnd)) continue
        if (!windowText(hwnd).trim()) continue
        const className = windowClass(hwnd)
        if (FORBIDDEN_CLASSES.has(className)) continue
        const pid = windowPid(hwnd)
        if (pid === process.pid) continue

        // Prefer a window owned by the executable we asked for; a splash screen
        // from a bootstrapper is the usual runner-up.
        if (basename(exeForPid(pid)).toLowerCase() === wanted) return hwnd
        fallback ??= hwnd
      }
      if (fallback !== null) return fallback
    }
    return null
  }

  states(): EmbedState[] {
    if (!load()) return []
    return [...this.attached.entries()].map(([hwnd, saved]) => ({
      hwnd,
      pid: saved.pid,
      title: saved.title,
      exe: saved.exe,
      alive: user32!.IsWindow(hwnd)
    }))
  }

  /**
   * Notice an app that left without being undocked — either because it was
   * closed from its own UI, or because it walked back out to the desktop.
   *
   * The second case is not hypothetical: a toolkit that keeps its own record of
   * the window hierarchy reconciles it after our style change and calls
   * SetParent(NULL) on itself, which leaves the application floating free while
   * the panel still claims to hold it. Putting it straight back wins when the
   * reconcile is a one-off. When it is not, the dock is given up rather than
   * fought over, since the alternative is a window flickering in and out of the
   * panel once a second.
   */
  private startWatchdog(): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      for (const [hwnd, saved] of [...this.attached.entries()]) {
        if (!user32!.IsWindow(hwnd)) {
          // A game that crashed while holding the mouse must not keep holding it.
          if (this.captured === hwnd) this.releaseMouse()
          this.blur(hwnd)
          this.attached.delete(hwnd)
          this.emit('gone', hwnd)
          continue
        }
        if (this.parentOf(hwnd) === saved.parent) {
          saved.settled += 1
          if (saved.settled >= SETTLED_TICKS) {
            saved.settled = 0
            saved.escapes = 0
          }
          continue
        }

        saved.settled = 0
        saved.escapes += 1
        if (saved.escapes > MAX_ESCAPES) {
          this.detach(hwnd)
          this.emit('escaped', hwnd, saved.title)
          continue
        }
        try {
          if (this.reparent(hwnd, saved) === null && saved.bounds) {
            this.setBounds(hwnd, saved.bounds)
          }
        } catch (err) {
          console.error('[embed] re-attach failed', err)
        }
      }
      if (this.attached.size === 0) this.stopWatchdog()
    }, 1000)
  }

  private stopWatchdog(): void {
    if (!this.watchdog) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }
}

export const embedManager = new EmbedManager()

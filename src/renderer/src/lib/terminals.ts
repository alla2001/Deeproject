import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { AppSettings, TerminalConfig } from '@shared/types'
import { useStore } from '../state'
import { isAppShortcut } from './keys'

export interface TerminalEntry {
  id: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Detached element that follows the panel around the dock. */
  container: HTMLDivElement
  webgl: WebglAddon | null
  /** Absolute stream position already rendered; guards against replay dupes. */
  seq: number
  /** The run this view is showing. Events from other runs are ignored. */
  runId: string
  synced: boolean
  queue: { seq: number; data: string }[]
  transparent: boolean
  disposers: (() => void)[]
}

const registry = new Map<string, TerminalEntry>()

const BASE_THEME: ITheme = {
  foreground: '#d7dce5',
  background: '#0d1017',
  selectionBackground: '#2c3a55',
  selectionForeground: '#ffffff',
  black: '#20242e',
  red: '#f4707f',
  green: '#7ddb8c',
  yellow: '#f0c674',
  blue: '#7aa6f0',
  magenta: '#c792ea',
  cyan: '#5fd7d7',
  white: '#c6ccd8',
  brightBlack: '#4b5364',
  brightRed: '#ff8b98',
  brightGreen: '#9ff0ac',
  brightYellow: '#ffdd8f',
  brightBlue: '#9ec1ff',
  brightMagenta: '#e0b0ff',
  brightCyan: '#89f0f0',
  brightWhite: '#f2f5fa'
}

function buildTheme(accent: string, transparent: boolean): ITheme {
  return {
    ...BASE_THEME,
    background: transparent ? 'rgba(0,0,0,0)' : BASE_THEME.background,
    cursor: accent,
    cursorAccent: '#0d1017',
    selectionBackground: transparent ? 'rgba(120,140,190,0.45)' : BASE_THEME.selectionBackground
  }
}

function hasBackground(config: TerminalConfig, settings: AppSettings): boolean {
  return Boolean(config.backgroundImage ?? settings.defaultBackgroundImage)
}

export function getEntry(id: string): TerminalEntry | undefined {
  return registry.get(id)
}

export function getOrCreate(config: TerminalConfig, settings: AppSettings): TerminalEntry {
  const existing = registry.get(config.id)
  if (existing) {
    applyConfig(existing, config, settings)
    return existing
  }

  const transparent = hasBackground(config, settings)
  const container = document.createElement('div')
  container.className = 'xterm-host'

  const term = new Terminal({
    allowProposedApi: true,
    allowTransparency: transparent,
    fontFamily: settings.fontFamily,
    fontSize: config.fontSize ?? settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    drawBoldTextInBrightColors: true,
    macOptionIsMeta: false,
    theme: buildTheme(config.color, transparent),
    windowsPty: { backend: 'conpty' }
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))

  const unicode = new Unicode11Addon()
  term.loadAddon(unicode)
  term.unicode.activeVersion = '11'

  term.open(container)

  const entry: TerminalEntry = {
    id: config.id,
    term,
    fit,
    search,
    container,
    webgl: null,
    seq: 0,
    runId: '',
    synced: false,
    queue: [],
    transparent,
    disposers: []
  }

  // WebGL is much faster but does not play well with a transparent backdrop,
  // so terminals with a background image stay on the DOM renderer.
  if (!transparent) loadWebgl(entry)

  entry.disposers.push(term.onData((data) => window.api.pty.write(config.id, data)).dispose)
  entry.disposers.push(
    term.onBinary((data) => {
      const buf = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 255
      window.api.pty.write(config.id, String.fromCharCode(...buf))
    }).dispose
  )
  entry.disposers.push(
    term.onResize(({ cols, rows }) => window.api.pty.resize(config.id, cols, rows)).dispose
  )
  entry.disposers.push(
    term.onTitleChange((title) => {
      const current = useStore.getState().terminals.find((t) => t.id === config.id)
      if (current?.autoTitle && title.trim()) {
        useStore.getState().updateTerminal(config.id, { title: title.trim() })
      }
    }).dispose
  )

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    // Let the window-level handler deal with app chrome chords.
    if (isAppShortcut(e)) return false

    const s = useStore.getState().settings
    // Ctrl+C copies only when there is a selection; otherwise it must reach the
    // shell as an interrupt.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      const sel = term.getSelection()
      if (sel) {
        void window.api.sys.writeClipboard(sel)
        term.clearSelection()
        return false
      }
      return true
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
      void pasteInto(config.id)
      return false
    }
    if (s.copyOnSelect) return true
    return true
  })

  container.addEventListener('contextmenu', (e) => {
    const s = useStore.getState().settings
    if (!s.rightClickPaste) return
    e.preventDefault()
    const sel = term.getSelection()
    if (sel) {
      void window.api.sys.writeClipboard(sel)
      term.clearSelection()
    } else {
      void pasteInto(config.id)
    }
  })

  term.onSelectionChange(() => {
    if (!useStore.getState().settings.copyOnSelect) return
    const sel = term.getSelection()
    if (sel) void window.api.sys.writeClipboard(sel)
  })

  registry.set(config.id, entry)
  return entry
}

/** Quote a path only when it needs it, and leave a trailing space to type after. */
export function pathToken(filePath: string): string {
  return /[\s"]/.test(filePath) ? `"${filePath}" ` : `${filePath} `
}

/**
 * Paste into a terminal. An image on the clipboard is written to disk and its
 * path typed instead — a PTY carries bytes, not pictures, and every CLI that
 * accepts an image accepts a path to one.
 */
async function pasteInto(id: string): Promise<void> {
  const imagePath = await window.api.sys.clipboardImage()
  if (imagePath) {
    window.api.pty.write(id, pathToken(imagePath))
    return
  }
  const text = await window.api.sys.readClipboard()
  if (text) window.api.pty.write(id, text)
}

function loadWebgl(entry: TerminalEntry): void {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      addon.dispose()
      entry.webgl = null
    })
    entry.term.loadAddon(addon)
    entry.webgl = addon
  } catch {
    // No WebGL available; the DOM renderer still works.
    entry.webgl = null
  }
}

/** Push config/settings changes into a live terminal without recreating it. */
export function applyConfig(
  entry: TerminalEntry,
  config: TerminalConfig,
  settings: AppSettings
): void {
  const transparent = hasBackground(config, settings)
  const { term } = entry

  term.options.fontFamily = settings.fontFamily
  term.options.fontSize = config.fontSize ?? settings.fontSize
  term.options.lineHeight = settings.lineHeight
  term.options.cursorStyle = settings.cursorStyle
  term.options.cursorBlink = settings.cursorBlink
  term.options.scrollback = settings.scrollback

  if (transparent !== entry.transparent) {
    entry.transparent = transparent
    term.options.allowTransparency = transparent
    if (transparent && entry.webgl) {
      entry.webgl.dispose()
      entry.webgl = null
    } else if (!transparent && !entry.webgl) {
      loadWebgl(entry)
    }
  }
  term.options.theme = buildTheme(config.color, transparent)
  safeFit(entry)
}

/** Fit only when the host actually has a size — hidden panels measure as 0. */
export function safeFit(entry: TerminalEntry): void {
  const el = entry.container
  if (!el.isConnected || el.clientWidth < 8 || el.clientHeight < 8) return
  try {
    entry.fit.fit()
  } catch {
    // Fit can throw while the element is mid-layout; the next resize retries.
  }
}

/** Feed a chunk in, respecting the run token and the replay cursor. */
export function pushData(id: string, runId: string, seq: number, data: string): void {
  const entry = registry.get(id)
  if (!entry) return
  if (!entry.synced) {
    entry.queue.push({ seq, data })
    return
  }
  if (runId !== entry.runId) return
  if (seq <= entry.seq) return
  entry.seq = seq
  entry.term.write(data)
}

/** Pull the session's scrollback from main and switch to live streaming. */
export async function syncFromMain(id: string): Promise<void> {
  const entry = registry.get(id)
  if (!entry) return
  const result = await window.api.pty.attach(id)
  entry.term.reset()
  if (result.buffer) entry.term.write(result.buffer)
  entry.runId = result.runId
  entry.seq = result.seq
  entry.synced = true
  const queued = entry.queue
  entry.queue = []
  for (const item of queued) {
    if (item.seq > entry.seq) {
      entry.seq = item.seq
      entry.term.write(item.data)
    }
  }
}

/**
 * Point the view at a brand new run. Called before `pty:start` so any output
 * still in flight from the previous run is discarded on arrival.
 */
export function beginRun(id: string, runId: string): void {
  const entry = registry.get(id)
  if (!entry) return
  entry.runId = runId
  entry.seq = 0
  entry.synced = true
  entry.queue = []
  entry.term.reset()
}

export function writeNotice(id: string, text: string): void {
  registry.get(id)?.term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

export function focusTerminal(id: string): void {
  const entry = registry.get(id)
  if (!entry) return
  safeFit(entry)
  entry.term.focus()
}

export function disposeTerminal(id: string): void {
  const entry = registry.get(id)
  if (!entry) return
  for (const d of entry.disposers) {
    try {
      d()
    } catch {
      // ignore
    }
  }
  try {
    entry.webgl?.dispose()
  } catch {
    // ignore
  }
  entry.term.dispose()
  entry.container.remove()
  registry.delete(id)
}

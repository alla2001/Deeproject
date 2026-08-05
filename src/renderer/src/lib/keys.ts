export interface Chord {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

/** Application-level chords. xterm must not swallow these. */
export const SHORTCUTS = {
  palette: { key: 'p', ctrl: true, shift: true },
  newTerminal: { key: 't', ctrl: true, shift: true },
  closeTerminal: { key: 'w', ctrl: true, shift: true },
  restartTerminal: { key: 'r', ctrl: true, shift: true },
  find: { key: 'f', ctrl: true, shift: true },
  quickOpen: { key: 'p', ctrl: true },
  save: { key: 's', ctrl: true },
  toggleSidebar: { key: 'b', ctrl: true, shift: true },
  addProject: { key: 'n', ctrl: true, shift: true },
  settings: { key: ',', ctrl: true },
  copy: { key: 'c', ctrl: true, shift: true },
  paste: { key: 'v', ctrl: true, shift: true },
  nextTab: { key: 'Tab', ctrl: true },
  prevTab: { key: 'Tab', ctrl: true, shift: true }
} as const satisfies Record<string, Chord>

export function matches(e: KeyboardEvent, chord: Chord): boolean {
  if (e.key.toLowerCase() !== chord.key.toLowerCase()) return false
  if (!!chord.ctrl !== (e.ctrlKey || e.metaKey)) return false
  if (!!chord.shift !== e.shiftKey) return false
  if (!!chord.alt !== e.altKey) return false
  return true
}

/** Alt+1..9 jumps straight to a tab. */
export function altDigit(e: KeyboardEvent): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  const n = Number(e.key)
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n : null
}

/**
 * True when the event belongs to the app chrome rather than the shell, so the
 * terminal should let it bubble up untouched.
 */
/**
 * Chords the terminal keeps for itself. Ctrl+S and Ctrl+P are ordinary control
 * characters in a shell (and Ctrl+P is history-previous in readline), so they
 * only act as app shortcuts outside a terminal.
 */
const TERMINAL_OWNED: Chord[] = [SHORTCUTS.quickOpen, SHORTCUTS.save]

export function isAppShortcut(e: KeyboardEvent): boolean {
  if (altDigit(e) !== null) return true
  if (TERMINAL_OWNED.some((chord) => matches(e, chord))) return false
  for (const chord of Object.values(SHORTCUTS)) {
    if (matches(e, chord)) return true
  }
  return false
}

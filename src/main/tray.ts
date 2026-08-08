import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'

/**
 * Keeps Deeproject reachable while its window is put away.
 *
 * Terminals are child processes of this app: quitting kills every one of them,
 * so "let me know when it finishes" and "let me close the window" can only both
 * be true if closing the window stops meaning quit. The tray is what makes that
 * honest — something visible that says the app is still there, holding sessions
 * open, with the only real way out on its menu.
 *
 * The icons are drawn here rather than shipped as files. They are two shapes and
 * a dot; generating them costs a few lines, and it keeps the packaged build from
 * having a way to lose them.
 */

interface Summary {
  running: number
  needsYou: number
}

let tray: Tray | null = null
let onOpen: (() => void) | null = null
let onQuit: (() => void) | null = null
let last: Summary = { running: 0, needsYou: 0 }

const SIZE = 32
/** The app's own mark: a rounded outline with a divider, as on the boot screen. */
const INK: [number, number, number] = [0x9c, 0xa6, 0xba]
/** Same amber the sidebar uses for a terminal that wants you. */
const ALERT: [number, number, number] = [0xf0, 0xc6, 0x74]

/**
 * Draw the mark into a BGRA buffer.
 *
 * Windows scales this down to 16 or 20 pixels depending on DPI, so the strokes
 * are deliberately thick: a hairline outline survives the downscale as a smudge.
 */
function drawIcon(alert: boolean): NativeImage {
  const buffer = Buffer.alloc(SIZE * SIZE * 4)

  const set = (x: number, y: number, [r, g, b]: [number, number, number], a = 255): void => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
    const i = (y * SIZE + x) * 4
    buffer[i] = b
    buffer[i + 1] = g
    buffer[i + 2] = r
    buffer[i + 3] = a
  }

  const left = 4
  const right = SIZE - 5
  const top = 5
  const bottom = SIZE - 6
  const stroke = 3

  for (let t = 0; t < stroke; t++) {
    for (let x = left; x <= right; x++) {
      set(x, top + t, INK)
      set(x, bottom - t, INK)
    }
    for (let y = top; y <= bottom; y++) {
      set(left + t, y, INK)
      set(right - t, y, INK)
    }
  }
  // The divider that makes it a pane rather than a plain box.
  const middle = Math.floor((left + right) / 2)
  for (let t = 0; t < stroke - 1; t++) {
    for (let y = top; y <= bottom; y++) set(middle + t, y, INK)
  }

  if (alert) {
    // A filled disc in the corner, over the outline rather than beside it, so
    // the whole glyph still reads at 16 pixels.
    const cx = SIZE - 8
    const cy = SIZE - 8
    const radius = 6
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const dx = x - cx
        const dy = y - cy
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d <= radius - 1) set(x, y, ALERT)
        // One pixel of coverage-based edge; a hard circle at this size aliases badly.
        else if (d <= radius) set(x, y, ALERT, Math.round(255 * (radius - d)))
      }
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: SIZE, height: SIZE })
}

let normalIcon: NativeImage | null = null
let alertIcon: NativeImage | null = null

function tooltip(summary: Summary): string {
  const parts: string[] = []
  parts.push(
    summary.running === 0
      ? 'No terminals running'
      : `${summary.running} terminal${summary.running === 1 ? '' : 's'} running`
  )
  if (summary.needsYou > 0) {
    parts.push(`${summary.needsYou} waiting for you`)
  }
  return `Deeproject — ${parts.join(' · ')}`
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Deeproject', click: () => onOpen?.() },
    { type: 'separator' },
    {
      // Spelled out, because this is the one action that takes the terminals
      // with it and there is no undo.
      label: 'Quit (closes every terminal)',
      click: () => onQuit?.()
    }
  ])
}

export function createTray(handlers: { open: () => void; quit: () => void }): void {
  if (tray) return
  onOpen = handlers.open
  onQuit = handlers.quit
  normalIcon ??= drawIcon(false)
  alertIcon ??= drawIcon(true)

  tray = new Tray(normalIcon)
  tray.setToolTip(tooltip(last))
  tray.setContextMenu(buildMenu())
  // A left click is what people try first; the menu is the right-click.
  tray.on('click', () => onOpen?.())
  tray.on('double-click', () => onOpen?.())
}

export function updateTray(summary: Summary): void {
  last = summary
  if (!tray) return
  tray.setToolTip(tooltip(summary))
  const wanted = summary.needsYou > 0 ? alertIcon : normalIcon
  if (wanted) tray.setImage(wanted)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export function trayExists(): boolean {
  return tray !== null
}

/** The window icon, so the taskbar shows the app's mark rather than Electron's. */
export function appIcon(): NativeImage {
  normalIcon ??= drawIcon(false)
  return normalIcon
}

app.on('before-quit', () => destroyTray())

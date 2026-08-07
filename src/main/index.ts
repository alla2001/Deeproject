import { app, BrowserWindow, globalShortcut, net, protocol, session, shell } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { embedManager } from './embed'
import { ptyManager } from './pty'
import { rojoManager } from './rojo'
import { statsMonitor } from './stats'
import { startMcpServer, stopMcpServer } from './mcp'
import { flushAll, initStore, loadWindow, saveWindow } from './store'

const MEDIA_SCHEME = 'deepmedia'
const APP_SCHEME = 'app'
const APP_ORIGIN = `${APP_SCHEME}://bundle`

// Must run before `app.ready`. `deepmedia` lets the renderer fetch local
// background images without turning off webSecurity; `app` serves the built
// renderer from a real origin, which `file://` is not — Monaco's web workers
// refuse to start from an opaque origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

let mainWindow: BrowserWindow | null = null

/**
 * When the app is launched from a terminal that later goes away, writing to
 * stdio raises EPIPE. Node turns that into an uncaught exception and Electron
 * shows a crash dialog — so diagnostics must never be able to kill the app.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    /* the pipe is gone; there is nowhere left to report it */
  })
}

/** Console output that cannot throw, whatever has happened to stdio. */
function safeLog(...args: unknown[]): void {
  try {
    console.error(...args)
  } catch {
    // Nothing to do: logging is best-effort.
  }
}

function createWindow(): void {
  const saved = loadWindow()

  mainWindow = new BrowserWindow({
    x: saved.x ?? undefined,
    y: saved.y ?? undefined,
    width: saved.width,
    height: saved.height,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0d1017',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1017', symbolColor: '#8b94a7', height: 38 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The Watch panel hosts YouTube in a <webview>. An iframe cannot work:
      // YouTube's embed rejects a non-http origin like app:// with "Error 153",
      // and a webview loads the site as a real top-level page instead.
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  if (saved.maximized) mainWindow.maximize()

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Alt-tabbing away from a docked game has to free the cursor too, or it stays
  // fenced into a window that is no longer in front of the user. The shared
  // input queue goes with it: holding it while we are in the background buys
  // nothing and leaves our UI thread waiting on someone else's.
  mainWindow.on('blur', () => {
    embedManager.releaseMouse()
    embedManager.suspendInput()
  })
  // Coming back to the front hands input to whichever embed is in front of us,
  // and stops the taskbar button flashing about a terminal you are now looking
  // at. What the terminal wanted stays flagged in the sidebar until it is
  // actually opened.
  mainWindow.on('focus', () => {
    embedManager.refocus()
    mainWindow?.flashFrame(false)
  })

  // Remember size/position. `getNormalBounds` reports the restored geometry, so
  // maximising then quitting doesn't save a full-screen rectangle as the
  // un-maximised size.
  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
    const bounds = mainWindow.getNormalBounds()
    saveWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: mainWindow.isMaximized()
    })
  }
  mainWindow.on('resize', persistBounds)
  mainWindow.on('move', persistBounds)
  mainWindow.on('maximize', persistBounds)
  mainWindow.on('unmaximize', persistBounds)

  // Surface renderer failures on the terminal that launched the app, otherwise
  // a blank window gives no clue what went wrong.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) safeLog(`[renderer] ${message}  (${sourceId}:${line})`)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    safeLog(`[renderer] did-fail-load ${code} ${desc} ${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    safeLog('[renderer] render-process-gone', details)
  })

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
  }

  // Everything pending goes to disk before the window is gone, not just on quit.
  mainWindow.on('close', () => {
    persistBounds()
    flushAll()
    // Windows destroys child windows along with their parent, so anything still
    // docked has to be handed back before this window goes away — otherwise
    // closing Deeproject would close the user's Studio or editor with it. This
    // must happen here rather than in `before-quit`, which runs too late.
    embedManager.detachAll()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Lock the packaged renderer down. Skipped in dev because Vite's HMR client
 * needs inline scripts and a websocket back to the dev server.
 */
function applyContentSecurityPolicy(): void {
  if (process.env['ELECTRON_RENDERER_URL']) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only police our own documents. This callback sees every response in the
    // session, including those inside third-party frames — overwriting their
    // CSP with ours breaks them (a YouTube embed loses all of its scripts).
    if (!details.url.startsWith(`${APP_SCHEME}://`)) {
      callback({})
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            // blob: covers the worker bundles Monaco spins up.
            "script-src 'self' blob:",
            "worker-src 'self' blob:",
            "style-src 'self' 'unsafe-inline'",
            // Discord serves report attachments from its own CDN.
            `img-src 'self' data: ${MEDIA_SCHEME}: https://cdn.discordapp.com https://media.discordapp.net`,
            "font-src 'self' data:",
            "connect-src 'self' data: blob:",
            // The Watch panel embeds YouTube's own player in an iframe.
            'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'"
          ].join('; ')
        ]
      }
    })
  })
}

/** Serves local image files to the renderer as deepmedia://media/?p=<path>. */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = url.searchParams.get('p')
      if (!filePath) return new Response('missing path', { status: 400 })
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch (err) {
      console.error('[media]', err)
      return new Response('not found', { status: 404 })
    }
  })
}

/** Serves the built renderer bundle from app://bundle/... */
function registerAppProtocol(): void {
  const root = resolve(__dirname, '../renderer')

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const requested = decodeURIComponent(url.pathname)
      const target = resolve(join(root, requested))

      // Never serve anything outside the bundle directory.
      if (target !== root && !target.startsWith(root + sep)) {
        return new Response('forbidden', { status: 403 })
      }
      return await net.fetch(pathToFileURL(target).toString())
    } catch (err) {
      console.error('[app protocol]', err)
      return new Response('not found', { status: 404 })
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.deeproject.app')
    initStore()
    applyContentSecurityPolicy()
    registerMediaProtocol()
    registerAppProtocol()
    registerIpc()
    // Started before any terminal can spawn, so Claude sessions can be handed
    // the task tools at launch.
    await startMcpServer()
    createWindow()

    // The only way out of a captured mouse. It has to be a system-wide hotkey:
    // while a game holds the pointer and the keyboard, nothing we render is
    // reachable, so an in-app shortcut would never be seen.
    if (!globalShortcut.register('Control+Alt+M', () => {
      embedManager.releaseMouse()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus()
        mainWindow.webContents.send('embed:capture', null)
      }
    })) {
      safeLog('[embed] could not register the mouse-release hotkey (Ctrl+Alt+M)')
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    flushAll()
    globalShortcut.unregisterAll()
    // Belt and braces: the window's own close handler normally gets there first.
    embedManager.detachAll()
    ptyManager.disposeAll()
    rojoManager.disposeAll()
    statsMonitor.dispose()
    stopMcpServer()
  })
}

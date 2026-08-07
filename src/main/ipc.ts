import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  AppState,
  EmbedBounds,
  NotionTaskPatch,
  PtyStartOptions,
  RobloxConfig,
  RobloxCreator,
  TerminalStats
} from '@shared/types'
import { attentionWatcher } from './attention'
import { flushAll, loadLayout, loadState, saveLayout, saveState } from './store'
import {
  applyBundle,
  estimateConversationBytes,
  exportBundle,
  pathExists,
  probeBundle
} from './transfer'
import { detectShells } from './shells'
import { ptyManager } from './pty'
import { statsMonitor } from './stats'
import { findProjectFiles, isPortFree, rojoManager } from './rojo'
import { findPlaceFiles, findStudioExe, lookupUniverseId, openInStudio } from './roblox'
import {
  hasRobloxApiKey,
  setRobloxApiKey,
  uploadableExtensions,
  uploadAsset,
  verifyRobloxApiKey
} from './robloxAssets'
import { isInside, listDirectory, readTextFile, walkFiles, writeTextFile } from './files'
import { embedManager } from './embed'
import {
  getPost,
  hasDiscordToken,
  listPosts,
  setDiscordToken,
  setPostArchived,
  setPostTags,
  verifyToken as verifyDiscordToken
} from './discord'
import {
  createTask,
  deleteTask,
  hasNotionToken,
  listTasks,
  resolveTarget,
  setNotionToken,
  updateTask,
  verifyToken
} from './notion'

/** Pasted screenshots accumulate; drop anything older than a week. */
function prunePastes(dir: string): void {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      } catch {
        // Locked or already gone; leave it.
      }
    }
  } catch {
    // Directory unreadable; nothing to prune.
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

interface AttentionAlert {
  terminalId: string
  reason: 'bell' | 'quiet' | 'exited'
  tail: string
}

const ATTENTION_WORDING: Record<AttentionAlert['reason'], string> = {
  bell: 'is asking for you',
  quiet: 'has gone quiet',
  exited: 'has finished'
}

/**
 * Tell the user about a terminal that wants them, outside the app's own window.
 *
 * The in-app marker is enough when Deeproject is in front; the point of this is
 * the case it cannot cover — a session finishing while the user is in Studio or
 * a browser. The taskbar flash is the cheap, always-on half; the toast is
 * optional because a notification per terminal gets tiresome quickly if you run
 * a lot of short ones.
 */
function announce(alert: AttentionAlert): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win && !win.isFocused()) win.flashFrame(true)

  const state = loadState()
  if (!state.settings.attentionNotify || !Notification.isSupported()) return
  // A toast for something already on screen is noise.
  if (win?.isFocused()) return

  const terminal = state.terminals.find((t) => t.id === alert.terminalId)
  const project = state.projects.find((p) => p.id === terminal?.projectId)
  const name = terminal ? `${terminal.emoji} ${terminal.title}`.trim() : 'A terminal'
  const where = project ? ` · ${project.name}` : ''

  const toast = new Notification({
    title: `${name}${where} ${ATTENTION_WORDING[alert.reason]}`,
    body: alert.tail || 'No output to show.'
  })
  toast.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('attention:reveal', alert.terminalId)
  })
  toast.show()
}

export function registerIpc(): void {
  ptyManager.on('data', (e) => {
    broadcast('pty:data', e)
    attentionWatcher.onData(e.terminalId, e.data)
  })
  ptyManager.on('status', (e) => {
    broadcast('pty:status', e)
    attentionWatcher.onStatus(e.terminalId, e.status)
    // Resource sampling follows the lifetime of each shell process.
    if (e.status === 'running' && typeof e.pid === 'number') {
      statsMonitor.track(e.terminalId, e.pid)
    } else if (e.status === 'exited' || e.status === 'stopped') {
      statsMonitor.untrack(e.terminalId)
    }
  })

  statsMonitor.on('stats', (all: TerminalStats[]) => {
    broadcast('stats:update', all)
    attentionWatcher.onStats(all)
  })

  attentionWatcher.on('update', (all) => broadcast('attention:update', all))
  attentionWatcher.on('attention', (e: AttentionAlert) => announce(e))
  rojoManager.on('state', (state) => broadcast('rojo:state', state))
  rojoManager.on('log', (event) => broadcast('rojo:log', event))

  // ---- persisted state -----------------------------------------------------
  ipcMain.handle('state:load', () => loadState())
  ipcMain.handle('state:save', (_e, state: AppState, immediate = false) => {
    saveState(state, immediate)
    return true
  })

  ipcMain.handle('layout:load', () => loadLayout())
  ipcMain.handle('layout:save', (_e, layout: unknown) => {
    saveLayout(layout)
    return true
  })

  // Sent on window unload and periodically, so a hard kill loses nothing.
  ipcMain.on('state:flush', () => flushAll())

  // ---- shells --------------------------------------------------------------
  ipcMain.handle('shells:list', () => detectShells())

  // ---- pty -----------------------------------------------------------------
  ipcMain.handle('pty:start', (_e, opts: PtyStartOptions) => ptyManager.start(opts))
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptyManager.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptyManager.resize(id, cols, rows)
  )
  ipcMain.handle('pty:kill', (_e, id: string) => {
    ptyManager.kill(id)
    return true
  })
  ipcMain.handle('pty:dispose', (_e, id: string) => {
    ptyManager.dispose(id)
    statsMonitor.untrack(id)
    attentionWatcher.dispose(id)
    return true
  })
  ipcMain.handle('pty:attach', (_e, id: string) => ptyManager.attach(id))
  ipcMain.handle('pty:statuses', () => ptyManager.allStatuses())

  // ---- dialogs & shell integration ----------------------------------------
  ipcMain.handle('dialog:pickFolder', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Add project folder',
          properties: ['openDirectory', 'createDirectory', 'multiSelections']
        })
      : await dialog.showOpenDialog({
          title: 'Add project folder',
          properties: ['openDirectory', 'createDirectory', 'multiSelections']
        })
    if (result.canceled) return []
    return result.filePaths.map((p) => ({ path: p, name: basename(p) || p }))
  })

  ipcMain.handle('dialog:pickImage', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Files to hand to whatever is running in a terminal. `defaultPath` is the
  // terminal's own folder, since that is where the thing being talked about
  // almost always is.
  ipcMain.handle('dialog:pickFiles', async (e, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Attach files',
      buttonLabel: 'Attach',
      defaultPath: defaultPath || undefined,
      properties: ['openFile', 'multiSelections']
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:confirm', async (e, opts: { title: string; message: string; detail?: string; confirmLabel?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const params: Electron.MessageBoxOptions = {
      type: 'warning',
      title: opts.title,
      message: opts.message,
      detail: opts.detail,
      buttons: [opts.confirmLabel ?? 'Confirm', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }
    const result = win
      ? await dialog.showMessageBox(win, params)
      : await dialog.showMessageBox(params)
    return result.response === 0
  })

  ipcMain.handle('sys:reveal', (_e, path: string) => {
    if (!existsSync(path)) return false
    shell.openPath(path)
    return true
  })

  ipcMain.handle('sys:openInEditor', (_e, path: string, command: string) => {
    if (!existsSync(path)) return false
    const exe = (command || 'code').trim()
    try {
      // Editor launchers on Windows are usually .cmd shims, hence shell: true.
      const child = spawn(exe, [path], { detached: true, stdio: 'ignore', shell: true })
      child.unref()
      return true
    } catch (err) {
      console.error('[openInEditor]', err)
      return false
    }
  })

  ipcMain.handle('sys:pathExists', (_e, path: string) => {
    try {
      return existsSync(path) && statSync(path).isDirectory()
    } catch {
      return false
    }
  })

  ipcMain.handle('sys:readClipboard', () => clipboard.readText())

  /**
   * Save a clipboard image to disk and hand back its path. Terminals can't
   * carry image data, but every CLI that accepts an image accepts a file path,
   * so pasting a screenshot types the path instead.
   */
  ipcMain.handle('sys:clipboardImage', () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    try {
      const dir = join(app.getPath('userData'), 'pastes')
      mkdirSync(dir, { recursive: true })
      prunePastes(dir)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = join(dir, `paste-${stamp}.png`)
      writeFileSync(file, image.toPNG())
      return file
    } catch (err) {
      console.error('[clipboardImage]', err)
      return null
    }
  })
  ipcMain.handle('sys:writeClipboard', (_e, text: string) => {
    clipboard.writeText(text)
    return true
  })

  // ---- resource stats ------------------------------------------------------
  ipcMain.on('stats:interval', (_e, ms: number) => {
    statsMonitor.setInterval(ms)
    // Without sampling there are no CPU readings to corroborate silence with.
    if (ms <= 0) attentionWatcher.clearStats()
  })

  // ---- attention -----------------------------------------------------------
  ipcMain.on('attention:idle', (_e, ms: number) => attentionWatcher.setIdleMs(ms))
  ipcMain.on('attention:focus', (_e, terminalId: string | null, windowFocused: boolean) =>
    attentionWatcher.setFocus(terminalId, windowFocused)
  )
  ipcMain.on('attention:seen', (_e, terminalId: string) => attentionWatcher.seen(terminalId))
  ipcMain.handle('attention:states', () => attentionWatcher.states())

  // ---- files ---------------------------------------------------------------
  ipcMain.handle('fs:list', async (_e, root: string, dir: string) => {
    if (!isInside(root, dir)) return []
    try {
      return await listDirectory(dir)
    } catch (err) {
      console.error('[fs:list]', err)
      return []
    }
  })

  ipcMain.handle('fs:read', async (_e, root: string, filePath: string) => {
    if (!isInside(root, filePath)) {
      return {
        ok: false,
        path: filePath,
        content: '',
        language: 'plaintext',
        error: 'That file is outside the project folder.',
        modified: 0
      }
    }
    return readTextFile(filePath)
  })

  ipcMain.handle(
    'fs:write',
    async (_e, root: string, filePath: string, content: string, expectedModified: number | null) => {
      if (!isInside(root, filePath)) {
        return { ok: false, modified: 0, error: 'That file is outside the project folder.' }
      }
      return writeTextFile(filePath, content, expectedModified)
    }
  )

  ipcMain.handle('fs:walk', async (_e, root: string) => {
    try {
      return await walkFiles(root)
    } catch (err) {
      console.error('[fs:walk]', err)
      return []
    }
  })

  // ---- rojo ----------------------------------------------------------------
  ipcMain.handle(
    'rojo:start',
    (
      _e,
      opts: { projectId: string; projectPath: string; projectFile: string | null; port: number; binary: string }
    ) => rojoManager.start(opts)
  )
  ipcMain.handle('rojo:stop', (_e, projectId: string) => rojoManager.stop(projectId))
  ipcMain.handle('rojo:states', () => rojoManager.allStates())
  ipcMain.handle('rojo:log', (_e, projectId: string) => rojoManager.log(projectId))
  ipcMain.handle('rojo:projectFiles', (_e, projectPath: string) => findProjectFiles(projectPath))
  ipcMain.handle('rojo:portFree', (_e, port: number) => isPortFree(port))

  // ---- roblox --------------------------------------------------------------
  ipcMain.handle(
    'roblox:open',
    (_e, projectPath: string, config: RobloxConfig, projectId: string) =>
      openInStudio(projectPath, config, projectId)
  )
  ipcMain.handle('roblox:placeFiles', (_e, projectPath: string) => findPlaceFiles(projectPath))
  ipcMain.handle('roblox:lookupUniverse', (_e, placeId: string) => lookupUniverseId(placeId))
  ipcMain.handle('roblox:studioPath', () => findStudioExe())

  // ---- notion --------------------------------------------------------------
  ipcMain.handle('notion:setToken', (_e, token: string | null) => setNotionToken(token))
  ipcMain.handle('notion:hasToken', () => hasNotionToken())
  ipcMain.handle('notion:verify', () => verifyToken())
  ipcMain.handle('notion:resolve', (_e, target: string) => resolveTarget(target))
  ipcMain.handle('notion:list', (_e, target: string) => listTasks(target))
  ipcMain.handle('notion:create', (_e, target: string, title: string) => createTask(target, title))
  ipcMain.handle('notion:update', (_e, target: string, taskId: string, patch: NotionTaskPatch) =>
    updateTask(target, taskId, patch)
  )
  ipcMain.handle('notion:delete', (_e, target: string, taskId: string) => deleteTask(target, taskId))

  // ---- transfer between machines -------------------------------------------
  ipcMain.handle('transfer:pickDir', async (e, mode: 'export' | 'import') => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: mode === 'export' ? 'Choose where to write the bundle' : 'Choose a bundle folder',
      buttonLabel: mode === 'export' ? 'Export here' : 'Open bundle',
      properties: mode === 'export' ? ['openDirectory', 'createDirectory'] : ['openDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('transfer:estimate', () => estimateConversationBytes())
  ipcMain.handle('transfer:export', (_e, dir: string, includeConversations: boolean) =>
    exportBundle(dir, { includeConversations })
  )
  ipcMain.handle('transfer:probe', (_e, dir: string) => probeBundle(dir))
  ipcMain.handle(
    'transfer:apply',
    (_e, dir: string, mode: 'replace' | 'merge', paths: Record<string, string>) =>
      applyBundle(dir, { mode, paths })
  )
  ipcMain.handle('transfer:pathExists', (_e, target: string) => pathExists(target))

  // ---- idea attachments ----------------------------------------------------
  ipcMain.handle('ideas:pickImages', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Attach images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled ? [] : result.filePaths
  })

  /**
   * Copy images into the app's own store. Referencing them where they were
   * dropped from would leave an idea full of broken thumbnails as soon as the
   * originals move — and screenshots usually come from a temp folder anyway.
   */
  ipcMain.handle('ideas:attach', (_e, ideaId: string, sources: string[]) => {
    const stored: string[] = []
    try {
      const dir = join(app.getPath('userData'), 'idea-images', ideaId)
      mkdirSync(dir, { recursive: true })
      for (const source of sources) {
        if (!existsSync(source)) continue
        const ext = extname(source) || '.png'
        const target = join(dir, `${randomUUID()}${ext}`)
        copyFileSync(source, target)
        stored.push(target)
      }
    } catch (err) {
      console.error('[ideas:attach]', err)
    }
    return stored
  })

  ipcMain.handle('ideas:removeImage', (_e, filePath: string) => {
    try {
      // Only ever delete out of our own attachment folder.
      const root = join(app.getPath('userData'), 'idea-images')
      if (!isInside(root, filePath)) return false
      if (existsSync(filePath)) unlinkSync(filePath)
      return true
    } catch (err) {
      console.error('[ideas:removeImage]', err)
      return false
    }
  })

  // ---- roblox assets -------------------------------------------------------
  ipcMain.handle('rbxassets:setKey', (_e, key: string | null) => setRobloxApiKey(key))
  ipcMain.handle('rbxassets:hasKey', () => hasRobloxApiKey())
  ipcMain.handle('rbxassets:verify', () => verifyRobloxApiKey())
  ipcMain.handle('rbxassets:extensions', () => uploadableExtensions())
  ipcMain.handle(
    'rbxassets:upload',
    (
      _e,
      opts: {
        filePath: string
        creator: RobloxCreator
        displayName?: string
        description?: string
        assetType?: string
      }
    ) => uploadAsset(opts)
  )
  ipcMain.handle('rbxassets:pickFiles', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Upload to Roblox',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Roblox assets', extensions: uploadableExtensions() }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled ? [] : result.filePaths
  })

  // ---- discord -------------------------------------------------------------
  ipcMain.handle('discord:setToken', (_e, token: string | null) => setDiscordToken(token))
  ipcMain.handle('discord:hasToken', () => hasDiscordToken())
  ipcMain.handle('discord:verify', () => verifyDiscordToken())
  ipcMain.handle('discord:list', (_e, channel: string, includeArchived: boolean) =>
    listPosts(channel, includeArchived)
  )
  ipcMain.handle('discord:get', (_e, postId: string, replyLimit: number) =>
    getPost(postId, replyLimit)
  )
  ipcMain.handle('discord:setTags', (_e, postId: string, tagIds: string[]) =>
    setPostTags(postId, tagIds)
  )
  ipcMain.handle('discord:setArchived', (_e, postId: string, archived: boolean) =>
    setPostArchived(postId, archived)
  )

  // ---- embedded windows ----------------------------------------------------
  embedManager.on('gone', (hwnd: number) => broadcast('embed:gone', hwnd))
  // An app that kept pulling itself back out to the desktop; the panel is now
  // empty and has to say why rather than sit there blank.
  embedManager.on('escaped', (hwnd: number, title: string) =>
    broadcast('embed:escaped', { hwnd, title })
  )

  ipcMain.handle('embed:available', () => ({
    ok: embedManager.available(),
    error: embedManager.unavailableReason()
  }))
  ipcMain.handle('embed:list', () => embedManager.list())

  ipcMain.handle('embed:attach', (e, hwnd: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: 'No window to dock into.' }
    // getNativeWindowHandle hands back the HWND as little-endian bytes: eight
    // of them on x64, four on a 32-bit build.
    const raw = win.getNativeWindowHandle()
    const parent =
      raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0)
    return embedManager.attach(hwnd, parent)
  })

  ipcMain.handle('embed:detach', (_e, hwnd: number) => embedManager.detach(hwnd))
  ipcMain.handle('embed:states', () => embedManager.states())
  ipcMain.on('embed:bounds', (_e, hwnd: number, bounds: EmbedBounds) =>
    embedManager.setBounds(hwnd, bounds)
  )
  ipcMain.on('embed:visible', (_e, hwnd: number, visible: boolean) =>
    embedManager.setVisible(hwnd, visible)
  )
  ipcMain.on('embed:allVisible', (_e, visible: boolean) => embedManager.setAllVisible(visible))
  ipcMain.on('embed:focus', (_e, hwnd: number) => embedManager.focus(hwnd))
  ipcMain.on('embed:blur', (_e, hwnd: number) => embedManager.blur(hwnd))

  embedManager.on('capture', (hwnd: number | null) => broadcast('embed:capture', hwnd))
  ipcMain.handle('embed:capture', (_e, hwnd: number) => embedManager.captureMouse(hwnd))
  ipcMain.handle('embed:release', () => {
    embedManager.releaseMouse()
    return true
  })

  ipcMain.handle('embed:pickExe', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: 'Launch an application',
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('embed:launch', (_e, exePath: string) => embedManager.launch(exePath))

  // ---- window controls -----------------------------------------------------
  ipcMain.handle('win:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:toggleMaximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}

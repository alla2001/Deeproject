import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppState,
  BundleSummary,
  DiscordBoard,
  DiscordDetail,
  EmbedAttachResult,
  EmbedBounds,
  EmbedCandidate,
  EmbedState,
  FileEntry,
  NotionBoard,
  NotionTaskPatch,
  PtyAttachResult,
  PtyDataEvent,
  PtyStartOptions,
  PtyStatus,
  PtyStatusEvent,
  ReadFileResult,
  RobloxConfig,
  RobloxCreator,
  RobloxUploadResult,
  RojoLogEvent,
  RojoState,
  ShellInfo,
  TerminalStats
} from '@shared/types'

/** Subscribe helper that returns an unsubscribe function. */
function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  state: {
    load: (): Promise<AppState> => ipcRenderer.invoke('state:load'),
    save: (state: AppState, immediate = false): Promise<boolean> =>
      ipcRenderer.invoke('state:save', state, immediate),
    /** Force every pending write to disk right now. */
    flush: (): void => ipcRenderer.send('state:flush')
  },
  layout: {
    load: (): Promise<unknown> => ipcRenderer.invoke('layout:load'),
    save: (layout: unknown): Promise<boolean> => ipcRenderer.invoke('layout:save', layout)
  },
  shells: {
    list: (): Promise<ShellInfo[]> => ipcRenderer.invoke('shells:list')
  },
  pty: {
    start: (opts: PtyStartOptions): Promise<PtyStatusEvent> => ipcRenderer.invoke('pty:start', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:kill', id),
    dispose: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:dispose', id),
    attach: (id: string): Promise<PtyAttachResult> => ipcRenderer.invoke('pty:attach', id),
    statuses: (): Promise<Record<string, PtyStatus>> => ipcRenderer.invoke('pty:statuses'),
    onData: (cb: (e: PtyDataEvent) => void): (() => void) => on('pty:data', cb),
    onStatus: (cb: (e: PtyStatusEvent) => void): (() => void) => on('pty:status', cb)
  },
  stats: {
    setInterval: (ms: number): void => ipcRenderer.send('stats:interval', ms),
    onUpdate: (cb: (all: TerminalStats[]) => void): (() => void) => on('stats:update', cb)
  },
  fs: {
    list: (root: string, dir: string): Promise<FileEntry[]> =>
      ipcRenderer.invoke('fs:list', root, dir),
    read: (root: string, filePath: string): Promise<ReadFileResult> =>
      ipcRenderer.invoke('fs:read', root, filePath),
    write: (
      root: string,
      filePath: string,
      content: string,
      expectedModified: number | null
    ): Promise<{ ok: boolean; modified: number; error?: string; conflict?: boolean }> =>
      ipcRenderer.invoke('fs:write', root, filePath, content, expectedModified),
    walk: (root: string): Promise<string[]> => ipcRenderer.invoke('fs:walk', root)
  },
  rojo: {
    start: (opts: {
      projectId: string
      projectPath: string
      projectFile: string | null
      port: number
      binary: string
    }): Promise<RojoState> => ipcRenderer.invoke('rojo:start', opts),
    stop: (projectId: string): Promise<RojoState> => ipcRenderer.invoke('rojo:stop', projectId),
    states: (): Promise<RojoState[]> => ipcRenderer.invoke('rojo:states'),
    log: (projectId: string): Promise<string> => ipcRenderer.invoke('rojo:log', projectId),
    projectFiles: (projectPath: string): Promise<string[]> =>
      ipcRenderer.invoke('rojo:projectFiles', projectPath),
    portFree: (port: number): Promise<boolean> => ipcRenderer.invoke('rojo:portFree', port),
    onState: (cb: (state: RojoState) => void): (() => void) => on('rojo:state', cb),
    onLog: (cb: (event: RojoLogEvent) => void): (() => void) => on('rojo:log', cb)
  },
  roblox: {
    open: (
      projectPath: string,
      config: RobloxConfig,
      projectId: string
    ): Promise<{
      ok: boolean
      error?: string
      universeId?: number
      focused?: boolean
      placeName?: string
    }> => ipcRenderer.invoke('roblox:open', projectPath, config, projectId),
    placeFiles: (projectPath: string): Promise<string[]> =>
      ipcRenderer.invoke('roblox:placeFiles', projectPath),
    lookupUniverse: (placeId: string): Promise<number | null> =>
      ipcRenderer.invoke('roblox:lookupUniverse', placeId),
    studioPath: (): Promise<string | null> => ipcRenderer.invoke('roblox:studioPath'),

    setApiKey: (key: string | null): Promise<boolean> =>
      ipcRenderer.invoke('rbxassets:setKey', key),
    hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('rbxassets:hasKey'),
    verifyApiKey: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('rbxassets:verify'),
    uploadExtensions: (): Promise<string[]> => ipcRenderer.invoke('rbxassets:extensions'),
    pickAssets: (): Promise<string[]> => ipcRenderer.invoke('rbxassets:pickFiles'),
    upload: (opts: {
      filePath: string
      creator: RobloxCreator
      displayName?: string
      description?: string
      assetType?: string
    }): Promise<RobloxUploadResult> => ipcRenderer.invoke('rbxassets:upload', opts)
  },
  notion: {
    setToken: (token: string | null): Promise<boolean> =>
      ipcRenderer.invoke('notion:setToken', token),
    hasToken: (): Promise<boolean> => ipcRenderer.invoke('notion:hasToken'),
    verify: (): Promise<{ ok: boolean; user?: string; error?: string }> =>
      ipcRenderer.invoke('notion:verify'),
    resolve: (
      target: string
    ): Promise<{ ok: true; kind: 'database' | 'page'; id: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('notion:resolve', target),
    list: (target: string): Promise<NotionBoard> => ipcRenderer.invoke('notion:list', target),
    create: (target: string, title: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('notion:create', target, title),
    update: (
      target: string,
      taskId: string,
      patch: NotionTaskPatch
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('notion:update', target, taskId, patch),
    remove: (target: string, taskId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('notion:delete', target, taskId)
  },
  transfer: {
    pickDir: (mode: 'export' | 'import'): Promise<string | null> =>
      ipcRenderer.invoke('transfer:pickDir', mode),
    /** Bytes of Claude transcripts an export would carry, for a size warning. */
    estimate: (): Promise<number> => ipcRenderer.invoke('transfer:estimate'),
    export: (
      dir: string,
      includeConversations: boolean
    ): Promise<{
      ok: boolean
      error?: string
      bytes?: number
      projects?: number
      conversations?: number
    }> => ipcRenderer.invoke('transfer:export', dir, includeConversations),
    probe: (dir: string): Promise<BundleSummary> => ipcRenderer.invoke('transfer:probe', dir),
    apply: (
      dir: string,
      mode: 'replace' | 'merge',
      paths: Record<string, string>
    ): Promise<{ ok: boolean; error?: string; imported?: number; conversations?: number }> =>
      ipcRenderer.invoke('transfer:apply', dir, mode, paths),
    pathExists: (target: string): Promise<boolean> =>
      ipcRenderer.invoke('transfer:pathExists', target)
  },
  ideas: {
    pickImages: (): Promise<string[]> => ipcRenderer.invoke('ideas:pickImages'),
    /** Copies the given files into the app's store; resolves to the new paths. */
    attach: (ideaId: string, sources: string[]): Promise<string[]> =>
      ipcRenderer.invoke('ideas:attach', ideaId, sources),
    removeImage: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke('ideas:removeImage', filePath)
  },
  discord: {
    setToken: (token: string | null): Promise<boolean> =>
      ipcRenderer.invoke('discord:setToken', token),
    hasToken: (): Promise<boolean> => ipcRenderer.invoke('discord:hasToken'),
    verify: (): Promise<{ ok: boolean; user?: string; error?: string }> =>
      ipcRenderer.invoke('discord:verify'),
    list: (channel: string, includeArchived: boolean): Promise<DiscordBoard> =>
      ipcRenderer.invoke('discord:list', channel, includeArchived),
    get: (postId: string, replyLimit = 30): Promise<DiscordDetail> =>
      ipcRenderer.invoke('discord:get', postId, replyLimit),
    setTags: (postId: string, tagIds: string[]): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('discord:setTags', postId, tagIds),
    setArchived: (postId: string, archived: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('discord:setArchived', postId, archived)
  },
  embed: {
    available: (): Promise<{ ok: boolean; error: string | null }> =>
      ipcRenderer.invoke('embed:available'),
    list: (): Promise<EmbedCandidate[]> => ipcRenderer.invoke('embed:list'),
    attach: (hwnd: number): Promise<EmbedAttachResult> => ipcRenderer.invoke('embed:attach', hwnd),
    detach: (hwnd: number): Promise<boolean> => ipcRenderer.invoke('embed:detach', hwnd),
    states: (): Promise<EmbedState[]> => ipcRenderer.invoke('embed:states'),
    /** Bounds are physical pixels relative to our window's client area. */
    setBounds: (hwnd: number, bounds: EmbedBounds): void =>
      ipcRenderer.send('embed:bounds', hwnd, bounds),
    setVisible: (hwnd: number, visible: boolean): void =>
      ipcRenderer.send('embed:visible', hwnd, visible),
    /** Used to clear the way for modals, which a native child window covers. */
    setAllVisible: (visible: boolean): void => ipcRenderer.send('embed:allVisible', visible),
    focus: (hwnd: number): void => ipcRenderer.send('embed:focus', hwnd),
    /** Hand mouse and keyboard to a docked game; Ctrl+Alt+M takes them back. */
    captureMouse: (hwnd: number): Promise<boolean> => ipcRenderer.invoke('embed:capture', hwnd),
    releaseMouse: (): Promise<boolean> => ipcRenderer.invoke('embed:release'),
    onCaptureChange: (cb: (hwnd: number | null) => void): (() => void) => on('embed:capture', cb),
    pickExe: (): Promise<string | null> => ipcRenderer.invoke('embed:pickExe'),
    launch: (exePath: string): Promise<number | null> => ipcRenderer.invoke('embed:launch', exePath),
    onGone: (cb: (hwnd: number) => void): (() => void) => on('embed:gone', cb)
  },
  dialog: {
    pickFolder: (): Promise<{ path: string; name: string }[]> =>
      ipcRenderer.invoke('dialog:pickFolder'),
    pickImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickImage'),
    confirm: (opts: {
      title: string
      message: string
      detail?: string
      confirmLabel?: string
    }): Promise<boolean> => ipcRenderer.invoke('dialog:confirm', opts)
  },
  sys: {
    reveal: (path: string): Promise<boolean> => ipcRenderer.invoke('sys:reveal', path),
    openInEditor: (path: string, command: string): Promise<boolean> =>
      ipcRenderer.invoke('sys:openInEditor', path, command),
    pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('sys:pathExists', path),
    readClipboard: (): Promise<string> => ipcRenderer.invoke('sys:readClipboard'),
    /** Saves a clipboard image to disk; resolves to its path, or null. */
    clipboardImage: (): Promise<string | null> => ipcRenderer.invoke('sys:clipboardImage'),
    /** Real filesystem path for a dropped File (File.path is gone in Electron 32+). */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    writeClipboard: (text: string): Promise<boolean> =>
      ipcRenderer.invoke('sys:writeClipboard', text),
    /** Turns an absolute file path into a URL the renderer is allowed to load. */
    mediaUrl: (path: string): string =>
      `deepmedia://media/?p=${encodeURIComponent(path)}`
  },
  win: {
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
    minimize: (): void => ipcRenderer.send('win:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('win:toggleMaximize'),
    close: (): void => ipcRenderer.send('win:close')
  }
}

export type DeeprojectApi = typeof api

contextBridge.exposeInMainWorld('api', api)

/** Types shared between the main process, the preload bridge and the renderer. */

export type PtyStatus = 'stopped' | 'starting' | 'running' | 'exited'

/** A shell that can host a terminal session. */
export interface ShellInfo {
  id: string
  label: string
  exe: string
  /** Args used when no command should run (plain interactive shell). */
  plainArgs: string[]
  /** How to wrap a command so the shell runs it and then stays alive. */
  commandMode: 'powershell' | 'cmd' | 'posix' | 'wsl'
  icon: string
}

/** A one-click way to start a terminal (e.g. "Claude — Resume"). */
export interface LaunchPreset {
  id: string
  label: string
  emoji: string
  /** null means "just open the shell". */
  command: string | null
  color: string | null
  /** Shown on project rows as a quick-launch button. */
  pinned: boolean
  builtin: boolean
}

export interface Project {
  id: string
  name: string
  path: string
  color: string
  emoji: string
  backgroundImage: string | null
  backgroundOpacity: number
  backgroundBlur: number
  order: number
  collapsed: boolean
  createdAt: number
  lastOpenedAt: number | null
  /** Rojo dev-server configuration for this folder. */
  rojo: RojoConfig
  /** Roblox place this folder builds into. */
  roblox: RobloxConfig
  /** Notion database or page holding this project's tasks. */
  notion: NotionConfig
  /** Discord forum channel holding this project's bug reports. */
  discord: DiscordConfig
}

export interface RojoConfig {
  /** Path to a *.project.json, relative to the project folder or absolute. */
  projectFile: string | null
  port: number
  /** Override the `rojo` executable for this project. */
  binary: string | null
  /** Start the server as soon as the app launches. */
  autoStart: boolean
}

export interface RobloxCreator {
  type: 'user' | 'group'
  /** Numeric user or group id that will own uploaded assets. */
  id: string
}

export interface RobloxConfig {
  /** Local .rbxl / .rbxlx to open in Studio. */
  placeFile: string | null
  /** Cloud place opened through Studio's command line. */
  placeId: string | null
  universeId: string | null
  /** Cached experience name, used to recognise an already-open Studio window. */
  placeName: string | null
  /** Who owns assets uploaded from this project. */
  creatorType: 'user' | 'group'
  creatorId: string | null
}

export interface RobloxUploadResult {
  ok: boolean
  /** File name, so a batch upload can be reported per item. */
  file: string
  assetId?: string
  assetType?: string
  error?: string
}

export interface DiscordConfig {
  /** Forum channel link or id holding this project's bug reports. */
  channel: string | null
  /** Cached channel name for the panel header. */
  channelName: string | null
}

export interface DiscordTag {
  id: string
  name: string
  emoji: string | null
}

export interface DiscordPost {
  id: string
  title: string
  /** Tag names, resolved from the forum's tag list. */
  tags: string[]
  tagIds: string[]
  excerpt: string
  author: string | null
  messageCount: number
  createdAt: number | null
  archived: boolean
  url: string | null
  image: string | null
}

export interface DiscordReply {
  author: string
  content: string
  at: number | null
}

/** One report in full, as shown when a post is expanded. */
export interface DiscordDetail {
  ok: boolean
  title: string
  body: string
  author: string | null
  attachments: string[]
  replies: DiscordReply[]
  error?: string
}

export interface DiscordBoard {
  ok: boolean
  channelName: string | null
  tags: DiscordTag[]
  posts: DiscordPost[]
  error: string | null
}

export interface NotionConfig {
  /** Notion URL or raw id; resolved to a database or page on first use. */
  target: string | null
  /** Cached resolution so we don't probe on every open. */
  kind: 'database' | 'page' | null
}

export interface TerminalConfig {
  id: string
  projectId: string
  title: string
  /** When true, the title tracks the OS-reported terminal title. */
  autoTitle: boolean
  emoji: string
  color: string
  backgroundImage: string | null
  backgroundOpacity: number
  backgroundBlur: number
  /** null = inherit from settings. */
  fontSize: number | null
  /** Working directory; defaults to the project path. */
  cwd: string
  command: string | null
  presetId: string | null
  shellId: string | null
  createdAt: number
}

export interface AppSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  defaultShellId: string | null
  /** Re-launch every saved terminal when the app starts. */
  autoStartTerminals: boolean
  confirmOnCloseRunning: boolean
  sidebarWidth: number
  sidebarVisible: boolean
  copyOnSelect: boolean
  rightClickPaste: boolean
  /** Global default background applied to terminals that have none. */
  defaultBackgroundImage: string | null
  defaultBackgroundOpacity: number
  defaultBackgroundBlur: number
  editorCommand: string
  /** Default `rojo` executable when a project doesn't override it. */
  rojoBinary: string
  /** First port handed to a new project; each new project takes the next free one. */
  rojoBasePort: number
  /** Editor preferences for the built-in code editor. */
  editorFontSize: number
  editorTabSize: number
  editorWordWrap: boolean
  editorMinimap: boolean
  /** Poll interval for terminal resource stats, in ms. 0 disables monitoring. */
  statsIntervalMs: number
  /** Notion integration token, encrypted at rest by the OS keystore. */
  notionTokenSet: boolean
}

export interface WindowBounds {
  x: number | null
  y: number | null
  width: number
  height: number
  maximized: boolean
}

/** A game idea kept in the app rather than scattered across notes apps. */
export interface GameIdea {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  /** Optional link back to a project once an idea starts being built. */
  projectId: string | null
  createdAt: number
  updatedAt: number
}

/** A YouTube link saved for later, played in the Watch panel. */
export interface SavedVideo {
  id: string
  url: string
  title: string
  addedAt: number
}

/**
 * The renderer owns this document and writes it wholesale. Window bounds live
 * in a separate file because the main process writes those, and sharing one
 * file would let the two sides clobber each other.
 */
export interface AppState {
  /** Bumped when a one-shot data migration is added; see store.ts. */
  schemaVersion: number
  projects: Project[]
  terminals: TerminalConfig[]
  presets: LaunchPreset[]
  settings: AppSettings
  ideas: GameIdea[]
  videos: SavedVideo[]
}

export interface PtyStartOptions {
  terminalId: string
  /** Lets the main process attach this project's task tools to a Claude session. */
  projectId: string | null
  /**
   * Token minted by the renderer before starting. Every event for this run is
   * tagged with it, so output from a previous run that is still in flight can
   * be discarded instead of bleeding into the restarted session.
   */
  runId: string
  cwd: string
  shellId: string | null
  command: string | null
  cols: number
  rows: number
}

export interface PtyDataEvent {
  terminalId: string
  runId: string
  data: string
  /** Total characters emitted by this run up to and including this chunk. */
  seq: number
}

export interface PtyStatusEvent {
  terminalId: string
  runId: string
  status: PtyStatus
  exitCode?: number
  signal?: number
  pid?: number
  /** Human readable failure reason when the session could not start. */
  error?: string
}

/** Aggregated resource use for one terminal's whole process tree. */
export interface TerminalStats {
  terminalId: string
  /** Percentage of total machine CPU, already divided by core count. */
  cpu: number
  /** Resident memory across the tree, in bytes. */
  memory: number
  /** Number of live processes in the tree. */
  processes: number
  /** Command name of the deepest/most recently started child, for display. */
  topProcess: string | null
  pid: number | null
  /** Milliseconds since the session started. */
  uptimeMs: number
}

export type RojoStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface RojoState {
  projectId: string
  status: RojoStatus
  port: number
  pid: number | null
  /** Populated when status is 'error'. */
  message: string | null
  startedAt: number | null
}

export interface RojoLogEvent {
  projectId: string
  chunk: string
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: number
}

export interface ReadFileResult {
  ok: boolean
  path: string
  content: string
  /** Detected from the extension; drives Monaco's syntax highlighting. */
  language: string
  /** Set when the file was refused (too large, binary, missing). */
  error: string | null
  /** mtime at read time, used to detect external edits before saving. */
  modified: number
}

/** Notion's palette name for a select option, e.g. "yellow" or "default". */
export type NotionColor = string

export interface NotionOption {
  name: string
  color: NotionColor
}

/** An editable column on the board: a status, select or multi-select property. */
export interface NotionField {
  name: string
  type: 'status' | 'select' | 'multi_select'
  options: NotionOption[]
}

export interface NotionTask {
  id: string
  title: string
  done: boolean
  /** Name of the primary status/select value, when the source has one. */
  status: string | null
  url: string | null
  lastEdited: number | null
  /**
   * Chosen option names per property. Single-valued properties hold at most one
   * entry, so one shape covers select, status and multi-select alike.
   */
  values: Record<string, string[]>
}

export interface NotionBoard {
  ok: boolean
  kind: 'database' | 'page' | null
  title: string | null
  tasks: NotionTask[]
  /** Options for the primary status property, when the source is a database. */
  statusOptions: string[]
  /** Every editable select-ish column, in the order Notion reports them. */
  fields: NotionField[]
  error: string | null
}

export interface NotionTaskPatch {
  title?: string
  done?: boolean
  status?: string
  /** Property name -> option names. An empty array clears the property. */
  values?: Record<string, string[]>
}

export interface PtyAttachResult {
  status: PtyStatus
  runId: string
  /** Replay of everything the session has produced (capped ring buffer). */
  buffer: string
  /**
   * Sequence number at the end of `buffer`. The renderer discards any data
   * event with `seq <= this`, so a reattach can't duplicate or drop output.
   */
  seq: number
  pid?: number
  exitCode?: number
}

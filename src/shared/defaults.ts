import type {
  AppSettings,
  DiscordConfig,
  LaunchPreset,
  NotionConfig,
  RobloxConfig,
  RojoConfig,
  WindowBounds
} from './types'

/**
 * Current data schema. Bump this when adding a one-shot migration in store.ts.
 *  2 — move terminals off PowerShell onto cmd.exe (Claude's TUI needs it).
 */
export const SCHEMA_VERSION = 2

/** Accent palette offered in the colour picker. */
export const PALETTE = [
  '#7c8cff', // indigo
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // amber
  '#22c55e', // green
  '#14b8a6', // teal
  '#38bdf8', // sky
  '#64748b'  // slate
]

export const EMOJI_CHOICES = [
  '🤖', '🧠', '⚡', '🔨', '🚀', '🔥', '💻', '🐍', '🦀', '🟩',
  '📦', '🧪', '🐛', '🔒', '🌐', '📊', '🎨', '🎮', '🎬', '🎧',
  '📝', '📁', '⭐', '💎', '🌙', '☀️', '🌊', '🍀', '🍕', '☕'
]

export const DEFAULT_SETTINGS: AppSettings = {
  fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 10000,
  defaultShellId: null,
  autoStartTerminals: false,
  confirmOnCloseRunning: true,
  sidebarWidth: 260,
  sidebarVisible: true,
  copyOnSelect: false,
  rightClickPaste: true,
  defaultBackgroundImage: null,
  defaultBackgroundOpacity: 0.18,
  defaultBackgroundBlur: 0,
  editorCommand: 'code',
  rojoBinary: 'rojo',
  rojoBasePort: 34872,
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: false,
  editorMinimap: true,
  statsIntervalMs: 2500,
  // Long enough to sit through the pause between a model's tool calls, short
  // enough that a finished session is noticed while you still care.
  attentionIdleMs: 6000,
  attentionNotify: true,
  notionTokenSet: false
}

/** Rojo's own default port; each new project is offered the next free one. */
export const DEFAULT_ROJO_PORT = 34872

export const DEFAULT_ROJO: RojoConfig = {
  projectFile: null,
  port: DEFAULT_ROJO_PORT,
  binary: null,
  autoStart: false
}

export const DEFAULT_ROBLOX: RobloxConfig = {
  placeFile: null,
  placeId: null,
  universeId: null,
  placeName: null,
  creatorType: 'user',
  creatorId: null
}

export const DEFAULT_NOTION: NotionConfig = {
  target: null,
  kind: null
}

export const DEFAULT_DISCORD: DiscordConfig = {
  channel: null,
  channelName: null
}

export const DEFAULT_WINDOW: WindowBounds = {
  x: null,
  y: null,
  width: 1440,
  height: 900,
  maximized: false
}

/**
 * Built-in launch presets. `builtin` presets can be edited or unpinned but the
 * set is re-seeded (by id) on startup so a bad edit can't leave you stranded.
 */
export const BUILTIN_PRESETS: LaunchPreset[] = [
  {
    id: 'claude',
    label: 'Claude',
    emoji: '🤖',
    command: 'claude',
    color: '#d97757',
    pinned: true,
    builtin: true
  },
  {
    id: 'claude-resume',
    label: 'Claude — Resume',
    emoji: '⏪',
    command: 'claude --resume',
    color: '#7c8cff',
    pinned: true,
    builtin: true
  },
  {
    id: 'claude-continue',
    label: 'Claude — Continue last',
    emoji: '⏩',
    command: 'claude --continue',
    color: '#38bdf8',
    pinned: false,
    builtin: true
  },
  {
    id: 'claude-yolo',
    label: 'Claude — Skip permissions',
    emoji: '☠️',
    command: 'claude --dangerously-skip-permissions',
    color: '#f43f5e',
    pinned: true,
    builtin: true
  },
  {
    id: 'claude-resume-yolo',
    label: 'Claude — Resume + skip permissions',
    emoji: '💀',
    command: 'claude --resume --dangerously-skip-permissions',
    color: '#f97316',
    pinned: false,
    builtin: true
  },
  {
    id: 'shell',
    label: 'Shell',
    emoji: '💻',
    command: null,
    color: '#64748b',
    pinned: true,
    builtin: true
  }
]

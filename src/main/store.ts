import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  AppState,
  GameIdea,
  LaunchPreset,
  Project,
  SavedVideo,
  TerminalConfig,
  WindowBounds
} from '@shared/types'
import {
  BUILTIN_PRESETS,
  DEFAULT_DISCORD,
  DEFAULT_NOTION,
  DEFAULT_ROBLOX,
  DEFAULT_ROJO,
  DEFAULT_SETTINGS,
  DEFAULT_WINDOW,
  SCHEMA_VERSION
} from '@shared/defaults'

/**
 * Tiny JSON-file store. Writes are debounced and atomic (temp file + rename) so
 * a crash mid-write can't truncate the user's project list.
 */
class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null
  private pending: T | null = null

  constructor(
    private readonly file: string,
    private readonly fallback: T
  ) {}

  read(): T {
    try {
      if (!existsSync(this.file)) return this.fallback
      const raw = readFileSync(this.file, 'utf8')
      // A UTF-8 BOM makes JSON.parse throw, which would silently discard every
      // project. Editors on Windows add one readily, so strip it.
      const text = raw.replace(/^﻿/, '')
      if (!text.trim()) return this.fallback
      return JSON.parse(text) as T
    } catch (err) {
      console.error(`[store] failed to read ${this.file}:`, err)
      return this.fallback
    }
  }

  write(value: T, immediate = false): void {
    this.pending = value
    if (immediate) {
      this.flush()
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 250)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending === null) return
    const value = this.pending
    this.pending = null
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error(`[store] failed to write ${this.file}:`, err)
    }
  }
}

let stateFile: JsonFile<AppState>
let layoutFile: JsonFile<unknown>
let windowFile: JsonFile<WindowBounds>

const EMPTY_STATE: AppState = {
  schemaVersion: SCHEMA_VERSION,
  projects: [],
  terminals: [],
  presets: BUILTIN_PRESETS,
  settings: DEFAULT_SETTINGS,
  ideas: [],
  videos: []
}

/** Shell ids that Claude's TUI does not render correctly under. */
const POWERSHELL_IDS = new Set(['pwsh', 'powershell'])

/** Fill in fields added by newer versions of the app. */
function migrate(raw: Partial<AppState> | null): AppState {
  const fromVersion = typeof raw?.schemaVersion === 'number' ? raw.schemaVersion : 1
  const state: AppState = {
    schemaVersion: SCHEMA_VERSION,
    projects: Array.isArray(raw?.projects) ? raw!.projects : [],
    terminals: Array.isArray(raw?.terminals) ? raw!.terminals : [],
    presets: Array.isArray(raw?.presets) ? raw!.presets : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
    ideas: Array.isArray(raw?.ideas) ? raw!.ideas.map(normalizeIdea) : [],
    videos: Array.isArray(raw?.videos) ? raw!.videos.map(normalizeVideo) : []
  }

  state.projects = state.projects.map((p, i) => normalizeProject(p, i))
  const projectIds = new Set(state.projects.map((p) => p.id))
  state.terminals = state.terminals
    .filter((t) => t && projectIds.has(t.projectId))
    .map((t) => normalizeTerminal(t))

  // v2: Claude Code's TUI misbehaves under PowerShell, so existing sessions are
  // moved onto cmd.exe once. Choosing PowerShell again afterwards sticks,
  // because this only runs while the stored version is below 2.
  if (fromVersion < 2) {
    if (state.settings.defaultShellId && POWERSHELL_IDS.has(state.settings.defaultShellId)) {
      state.settings.defaultShellId = 'cmd'
    }
    state.terminals = state.terminals.map((t) =>
      t.shellId && POWERSHELL_IDS.has(t.shellId) ? { ...t, shellId: 'cmd' } : t
    )
  }

  // Re-seed built-ins by id so an edit can never delete them outright, while
  // keeping any user customisation of label/emoji/command.
  const byId = new Map(state.presets.filter((p) => p && p.id).map((p) => [p.id, p]))
  for (const builtin of BUILTIN_PRESETS) {
    const existing = byId.get(builtin.id)
    byId.set(builtin.id, existing ? { ...builtin, ...existing, builtin: true } : { ...builtin })
  }
  const order = [...BUILTIN_PRESETS.map((p) => p.id)]
  for (const p of state.presets) if (p?.id && !order.includes(p.id)) order.push(p.id)
  state.presets = order.map((id) => byId.get(id)!).filter(Boolean)

  return state
}

function normalizeProject(p: Partial<Project>, index: number): Project {
  return {
    id: p.id ?? crypto.randomUUID(),
    name: p.name ?? 'Untitled',
    path: p.path ?? '',
    color: p.color ?? '#7c8cff',
    emoji: p.emoji ?? '📁',
    backgroundImage: p.backgroundImage ?? null,
    backgroundOpacity: p.backgroundOpacity ?? 0.18,
    backgroundBlur: p.backgroundBlur ?? 0,
    order: typeof p.order === 'number' ? p.order : index,
    collapsed: p.collapsed ?? false,
    createdAt: p.createdAt ?? Date.now(),
    lastOpenedAt: p.lastOpenedAt ?? null,
    rojo: { ...DEFAULT_ROJO, ...(p.rojo ?? {}) },
    roblox: { ...DEFAULT_ROBLOX, ...(p.roblox ?? {}) },
    notion: { ...DEFAULT_NOTION, ...(p.notion ?? {}) },
    discord: { ...DEFAULT_DISCORD, ...(p.discord ?? {}) }
  }
}

function normalizeIdea(i: Partial<GameIdea>): GameIdea {
  const now = Date.now()
  return {
    id: i.id ?? crypto.randomUUID(),
    title: i.title ?? 'Untitled idea',
    body: i.body ?? '',
    tags: Array.isArray(i.tags) ? i.tags.filter((t) => typeof t === 'string') : [],
    images: Array.isArray(i.images) ? i.images.filter((p) => typeof p === 'string') : [],
    pinned: i.pinned ?? false,
    projectId: i.projectId ?? null,
    createdAt: i.createdAt ?? now,
    updatedAt: i.updatedAt ?? i.createdAt ?? now
  }
}

function normalizeVideo(v: Partial<SavedVideo>): SavedVideo {
  return {
    id: v.id ?? crypto.randomUUID(),
    url: v.url ?? '',
    title: v.title ?? 'Untitled',
    addedAt: v.addedAt ?? Date.now()
  }
}

function normalizeTerminal(t: Partial<TerminalConfig>): TerminalConfig {
  return {
    id: t.id ?? crypto.randomUUID(),
    projectId: t.projectId!,
    title: t.title ?? 'Terminal',
    autoTitle: t.autoTitle ?? false,
    emoji: t.emoji ?? '💻',
    color: t.color ?? '#7c8cff',
    backgroundImage: t.backgroundImage ?? null,
    backgroundOpacity: t.backgroundOpacity ?? 0.18,
    backgroundBlur: t.backgroundBlur ?? 0,
    fontSize: t.fontSize ?? null,
    cwd: t.cwd ?? '',
    command: t.command ?? null,
    presetId: t.presetId ?? null,
    shellId: t.shellId ?? null,
    paused: t.paused ?? false,
    createdAt: t.createdAt ?? Date.now()
  }
}

export function initStore(): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  stateFile = new JsonFile<AppState>(join(dir, 'state.json'), EMPTY_STATE)
  layoutFile = new JsonFile<unknown>(join(dir, 'layout.json'), null)
  windowFile = new JsonFile<WindowBounds>(join(dir, 'window.json'), DEFAULT_WINDOW)
}

export function loadWindow(): WindowBounds {
  return { ...DEFAULT_WINDOW, ...(windowFile.read() ?? {}) }
}

export function saveWindow(bounds: WindowBounds): void {
  windowFile.write(bounds)
}

export function loadState(): AppState {
  return migrate(stateFile.read() as Partial<AppState>)
}

export function saveState(state: AppState, immediate = false): void {
  stateFile.write(state, immediate)
}

export function loadLayout(): unknown {
  return layoutFile.read()
}

export function saveLayout(layout: unknown): void {
  layoutFile.write(layout)
}

export function flushAll(): void {
  stateFile?.flush()
  layoutFile?.flush()
  windowFile?.flush()
}

export type { AppSettings, LaunchPreset, Project, TerminalConfig }

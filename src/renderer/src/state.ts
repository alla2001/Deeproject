import { create } from 'zustand'
import type {
  AppSettings,
  AppState,
  DiscordConfig,
  GameIdea,
  LaunchPreset,
  SavedVideo,
  NotionConfig,
  Project,
  PtyStatus,
  RobloxConfig,
  RojoConfig,
  RojoState,
  ShellInfo,
  TerminalConfig,
  TerminalStats
} from '@shared/types'
import {
  DEFAULT_DISCORD,
  DEFAULT_NOTION,
  DEFAULT_ROBLOX,
  DEFAULT_ROJO,
  DEFAULT_SETTINGS,
  PALETTE,
  SCHEMA_VERSION
} from '@shared/defaults'

export type Modal =
  | { kind: 'project'; projectId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'settings' }
  | { kind: 'presets' }
  | { kind: 'embed' }
  | { kind: 'transfer' }
  | null

interface Store {
  ready: boolean
  projects: Project[]
  terminals: TerminalConfig[]
  presets: LaunchPreset[]
  settings: AppSettings
  ideas: GameIdea[]
  videos: SavedVideo[]
  shells: ShellInfo[]
  statuses: Record<string, PtyStatus>
  stats: Record<string, TerminalStats>
  rojoStates: Record<string, RojoState>
  notionTokenSet: boolean
  discordTokenSet: boolean
  robloxKeySet: boolean
  activeTerminalId: string | null
  /** Ids of terminals that currently have a tab in the dock. */
  openPanels: string[]
  modal: Modal
  paletteOpen: boolean
  quickOpen: boolean

  init(): Promise<void>
  setStatus(id: string, status: PtyStatus): void
  setStats(all: TerminalStats[]): void
  setRojoState(state: RojoState): void
  setNotionTokenSet(value: boolean): void
  setDiscordTokenSet(value: boolean): void
  setRobloxKeySet(value: boolean): void
  setActiveTerminal(id: string | null): void
  setOpenPanels(ids: string[]): void
  setQuickOpen(open: boolean): void
  setModal(modal: Modal): void
  setPaletteOpen(open: boolean): void

  addProjects(): Promise<Project[]>
  updateProject(id: string, patch: Partial<Project>): void
  updateRojo(id: string, patch: Partial<RojoConfig>): void
  updateRoblox(id: string, patch: Partial<RobloxConfig>): void
  updateNotion(id: string, patch: Partial<NotionConfig>): void
  updateDiscord(id: string, patch: Partial<DiscordConfig>): void
  removeProject(id: string): void
  moveProject(id: string, targetId: string, before: boolean): void

  createTerminal(input: {
    projectId: string
    title?: string
    emoji?: string
    color?: string
    command?: string | null
    presetId?: string | null
    shellId?: string | null
    cwd?: string
  }): TerminalConfig | null
  updateTerminal(id: string, patch: Partial<TerminalConfig>): void
  removeTerminal(id: string): void

  /** `immediate: false` for continuous input such as dragging a slider. */
  updateSettings(patch: Partial<AppSettings>, immediate?: boolean): void

  addIdea(): GameIdea
  /** `immediate: false` while typing into the editor. */
  updateIdea(id: string, patch: Partial<GameIdea>, immediate?: boolean): void
  removeIdea(id: string): void

  addVideo(url: string, title: string): SavedVideo | null
  removeVideo(id: string): void
  updatePreset(id: string, patch: Partial<LaunchPreset>): void
  addPreset(): LaunchPreset
  removePreset(id: string): void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function snapshot(): AppState {
  const { projects, terminals, presets, settings, ideas, videos } = useStore.getState()
  return { schemaVersion: SCHEMA_VERSION, projects, terminals, presets, settings, ideas, videos }
}

/**
 * Write-through of the serialisable slice of the store.
 *
 * Structural edits (adding a project, closing a terminal, changing a setting)
 * save straight away; only high-frequency changes such as dragging the sidebar
 * divider or a slider are debounced, so an abrupt exit can lose at most a
 * cosmetic tweak.
 */
function persist(immediate = true): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (immediate) {
    void window.api.state.save(snapshot(), true)
    return
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void window.api.state.save(snapshot(), false)
  }, 200)
}

/** Last-chance save when the window is going away. */
export function flushState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void window.api.state.save(snapshot(), true)
  window.api.state.flush()
}

/** Deterministic-ish accent so new projects aren't all the same colour. */
function nextColor(index: number): string {
  return PALETTE[index % PALETTE.length]
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  projects: [],
  terminals: [],
  presets: [],
  settings: DEFAULT_SETTINGS,
  ideas: [],
  videos: [],
  shells: [],
  statuses: {},
  stats: {},
  rojoStates: {},
  notionTokenSet: false,
  discordTokenSet: false,
  robloxKeySet: false,
  activeTerminalId: null,
  openPanels: [],
  modal: null,
  paletteOpen: false,
  quickOpen: false,

  async init() {
    const [state, shells, statuses, rojoStates, notionTokenSet, discordTokenSet, robloxKeySet] =
      await Promise.all([
        window.api.state.load(),
        window.api.shells.list(),
        window.api.pty.statuses(),
        window.api.rojo.states(),
        window.api.notion.hasToken(),
        window.api.discord.hasToken(),
        window.api.roblox.hasApiKey()
      ])
    set({
      projects: [...state.projects].sort((a, b) => a.order - b.order),
      terminals: state.terminals,
      presets: state.presets,
      settings: state.settings,
      ideas: state.ideas ?? [],
      videos: state.videos ?? [],
      shells,
      statuses,
      rojoStates: Object.fromEntries(rojoStates.map((r) => [r.projectId, r])),
      notionTokenSet,
      discordTokenSet,
      robloxKeySet,
      ready: true
    })
    window.api.stats.setInterval(state.settings.statsIntervalMs)
  },

  setStatus(id, status) {
    set((s) => ({ statuses: { ...s.statuses, [id]: status } }))
  },

  setStats(all) {
    set((s) => {
      const next = { ...s.stats }
      for (const entry of all) next[entry.terminalId] = entry
      return { stats: next }
    })
  },

  setRojoState(state) {
    set((s) => ({ rojoStates: { ...s.rojoStates, [state.projectId]: state } }))
  },

  setNotionTokenSet(value) {
    set({ notionTokenSet: value })
  },

  setDiscordTokenSet(value) {
    set({ discordTokenSet: value })
  },

  setRobloxKeySet(value) {
    set({ robloxKeySet: value })
  },

  setQuickOpen(quickOpen) {
    set({ quickOpen })
  },

  setActiveTerminal(id) {
    set({ activeTerminalId: id })
  },

  setOpenPanels(ids) {
    const current = get().openPanels
    if (current.length === ids.length && current.every((v, i) => v === ids[i])) return
    set({ openPanels: ids })
  },

  setModal(modal) {
    set({ modal })
  },

  setPaletteOpen(paletteOpen) {
    set({ paletteOpen })
  },

  async addProjects() {
    const picked = await window.api.dialog.pickFolder()
    if (!picked.length) return []
    const existing = get().projects
    const known = new Set(existing.map((p) => p.path.toLowerCase()))
    const usedPorts = new Set(existing.map((p) => p.rojo.port))
    const basePort = get().settings.rojoBasePort
    const created: Project[] = []

    picked.forEach((entry, i) => {
      if (known.has(entry.path.toLowerCase())) return
      // Give each project its own Rojo port so several can serve at once.
      let port = basePort
      while (usedPorts.has(port)) port++
      usedPorts.add(port)

      created.push({
        id: crypto.randomUUID(),
        name: entry.name,
        path: entry.path,
        color: nextColor(existing.length + i),
        emoji: '📁',
        backgroundImage: null,
        backgroundOpacity: 0.18,
        backgroundBlur: 0,
        order: existing.length + i,
        collapsed: false,
        createdAt: Date.now(),
        lastOpenedAt: null,
        rojo: { ...DEFAULT_ROJO, port },
        roblox: { ...DEFAULT_ROBLOX },
        notion: { ...DEFAULT_NOTION },
        discord: { ...DEFAULT_DISCORD }
      })
    })
    if (created.length) {
      set({ projects: [...existing, ...created] })
      persist()
    }
    return created
  },

  updateProject(id, patch) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
    persist()
  },

  updateRojo(id, patch) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, rojo: { ...p.rojo, ...patch } } : p))
    }))
    persist()
  },

  updateRoblox(id, patch) {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, roblox: { ...p.roblox, ...patch } } : p
      )
    }))
    persist()
  },

  updateNotion(id, patch) {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, notion: { ...p.notion, ...patch } } : p
      )
    }))
    persist()
  },

  updateDiscord(id, patch) {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, discord: { ...p.discord, ...patch } } : p
      )
    }))
    persist()
  },

  removeProject(id) {
    const doomed = get().terminals.filter((t) => t.projectId === id)
    for (const t of doomed) void window.api.pty.dispose(t.id)
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      terminals: s.terminals.filter((t) => t.projectId !== id)
    }))
    persist()
  },

  moveProject(id, targetId, before) {
    if (id === targetId) return
    const list = [...get().projects]
    const from = list.findIndex((p) => p.id === id)
    if (from === -1) return
    const [moved] = list.splice(from, 1)
    let to = list.findIndex((p) => p.id === targetId)
    if (to === -1) return
    if (!before) to += 1
    list.splice(to, 0, moved)
    set({ projects: list.map((p, i) => ({ ...p, order: i })) })
    persist()
  },

  createTerminal(input) {
    const project = get().projects.find((p) => p.id === input.projectId)
    if (!project) return null
    const term: TerminalConfig = {
      id: crypto.randomUUID(),
      projectId: project.id,
      title: input.title ?? project.name,
      autoTitle: false,
      emoji: input.emoji ?? project.emoji,
      color: input.color ?? project.color,
      backgroundImage: project.backgroundImage,
      backgroundOpacity: project.backgroundOpacity,
      backgroundBlur: project.backgroundBlur,
      fontSize: null,
      cwd: input.cwd ?? project.path,
      command: input.command ?? null,
      presetId: input.presetId ?? null,
      shellId: input.shellId ?? get().settings.defaultShellId,
      paused: false,
      createdAt: Date.now()
    }
    set((s) => ({
      terminals: [...s.terminals, term],
      projects: s.projects.map((p) =>
        p.id === project.id ? { ...p, lastOpenedAt: Date.now() } : p
      )
    }))
    persist()
    return term
  },

  updateTerminal(id, patch) {
    set((s) => ({ terminals: s.terminals.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    persist()
  },

  removeTerminal(id) {
    void window.api.pty.dispose(id)
    set((s) => ({
      terminals: s.terminals.filter((t) => t.id !== id),
      activeTerminalId: s.activeTerminalId === id ? null : s.activeTerminalId
    }))
    persist()
  },

  updateSettings(patch, immediate = true) {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
    if (patch.statsIntervalMs !== undefined) {
      window.api.stats.setInterval(patch.statsIntervalMs)
    }
    persist(immediate)
  },

  addIdea() {
    const now = Date.now()
    const idea: GameIdea = {
      id: crypto.randomUUID(),
      title: 'New idea',
      body: '',
      tags: [],
      images: [],
      pinned: false,
      projectId: null,
      createdAt: now,
      updatedAt: now
    }
    set((s) => ({ ideas: [idea, ...s.ideas] }))
    persist()
    return idea
  },

  updateIdea(id, patch, immediate = true) {
    set((s) => ({
      ideas: s.ideas.map((i) => (i.id === id ? { ...i, ...patch, updatedAt: Date.now() } : i))
    }))
    persist(immediate)
  },

  removeIdea(id) {
    set((s) => ({ ideas: s.ideas.filter((i) => i.id !== id) }))
    persist()
  },

  addVideo(url, title) {
    const trimmed = url.trim()
    if (!trimmed) return null
    const video: SavedVideo = {
      id: crypto.randomUUID(),
      url: trimmed,
      title: title.trim() || trimmed,
      addedAt: Date.now()
    }
    set((s) => ({ videos: [video, ...s.videos.filter((v) => v.url !== trimmed)] }))
    persist()
    return video
  },

  removeVideo(id) {
    set((s) => ({ videos: s.videos.filter((v) => v.id !== id) }))
    persist()
  },

  updatePreset(id, patch) {
    set((s) => ({ presets: s.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
    persist()
  },

  addPreset() {
    const preset: LaunchPreset = {
      id: crypto.randomUUID(),
      label: 'New preset',
      emoji: '⚡',
      command: '',
      color: '#7c8cff',
      pinned: false,
      builtin: false
    }
    set((s) => ({ presets: [...s.presets, preset] }))
    persist()
    return preset
  },

  removePreset(id) {
    set((s) => ({ presets: s.presets.filter((p) => p.id !== id || p.builtin) }))
    persist()
  }
}))

export const selectProject = (id: string) => (s: Store): Project | undefined =>
  s.projects.find((p) => p.id === id)

export const selectTerminal = (id: string) => (s: Store): TerminalConfig | undefined =>
  s.terminals.find((t) => t.id === id)

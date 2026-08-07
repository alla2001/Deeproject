import type { LaunchPreset, TerminalConfig } from '@shared/types'
import { useStore } from '../state'
import { closePanel, markAutoStart, openAuxPanel, openPanel } from './dock'
import { beginRun, disposeTerminal, getEntry, writeNotice } from './terminals'

/** Spawn (or respawn) the PTY behind a terminal tab. */
export async function startTerminal(id: string): Promise<void> {
  const state = useStore.getState()
  const term = state.terminals.find((t) => t.id === id)
  if (!term) return

  const entry = getEntry(id)
  const runId = crypto.randomUUID()
  // Claim the run before starting so late output from a prior run is dropped.
  if (entry) beginRun(id, runId)

  state.setStatus(id, 'starting')
  await window.api.pty.start({
    terminalId: id,
    projectId: term.projectId,
    runId,
    cwd: term.cwd,
    shellId: term.shellId,
    command: term.command,
    cols: entry?.term.cols ?? 80,
    rows: entry?.term.rows ?? 24
  })
}

export async function restartTerminal(id: string): Promise<void> {
  await window.api.pty.kill(id)
  await startTerminal(id)
}

export async function stopTerminal(id: string): Promise<void> {
  await window.api.pty.kill(id)
  writeNotice(id, '[session stopped]')
}

/**
 * Close a tab and forget the terminal. Prompts first when something is still
 * running, unless the user turned that off.
 */
export async function closeTerminal(id: string, skipConfirm = false): Promise<void> {
  const state = useStore.getState()
  const term = state.terminals.find((t) => t.id === id)
  const status = state.statuses[id]

  if (!skipConfirm && state.settings.confirmOnCloseRunning && status === 'running') {
    const ok = await window.api.dialog.confirm({
      title: 'Close terminal',
      message: `Close "${term?.title ?? 'terminal'}"?`,
      detail: 'The process running in this terminal will be terminated.',
      confirmLabel: 'Close'
    })
    if (!ok) return
  }

  closePanel(id)
  disposeTerminal(id)
  state.removeTerminal(id)
}

/** Close the tab but keep the terminal in the sidebar so it can be reopened. */
export function hideTerminal(id: string): void {
  closePanel(id)
}

export function launchPreset(projectId: string, preset: LaunchPreset): TerminalConfig | null {
  const state = useStore.getState()
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) return null

  const term = state.createTerminal({
    projectId,
    title: project.name,
    emoji: preset.emoji,
    color: preset.color ?? project.color,
    command: preset.command,
    presetId: preset.id
  })
  if (!term) return null

  markAutoStart(term.id)
  openPanel(term)
  return term
}

/** Reopen a saved terminal's tab, starting it if it isn't running. */
export function openTerminal(id: string): void {
  const state = useStore.getState()
  const term = state.terminals.find((t) => t.id === id)
  if (!term) return
  const status = state.statuses[id] ?? 'stopped'
  if (status === 'stopped' || status === 'exited') markAutoStart(id)
  openPanel(term)
}

export function projectPresets(): LaunchPreset[] {
  return useStore.getState().presets
}

// ---- editor / files --------------------------------------------------------

export function openEditor(projectId: string, root: string, filePath: string): void {
  const id = `editor:${filePath.toLowerCase()}`
  openAuxPanel(id, 'editor', fileLabel(filePath), { projectId, root, filePath })
}

export function openFilesPanel(projectId: string): void {
  const project = useStore.getState().projects.find((p) => p.id === projectId)
  if (!project) return
  openAuxPanel(`files:${projectId}`, 'files', `${project.emoji} files`, { projectId })
}

export function openRojoPanel(projectId: string): void {
  const project = useStore.getState().projects.find((p) => p.id === projectId)
  if (!project) return
  openAuxPanel(`rojo:${projectId}`, 'rojo', `🧩 rojo · ${project.name}`, { projectId })
}

export function openNotionPanel(projectId: string): void {
  const project = useStore.getState().projects.find((p) => p.id === projectId)
  if (!project) return
  openAuxPanel(`notion:${projectId}`, 'notion', `✅ tasks · ${project.name}`, { projectId })
}

export function openDiscordPanel(projectId: string): void {
  const project = useStore.getState().projects.find((p) => p.id === projectId)
  if (!project) return
  openAuxPanel(`discord:${projectId}`, 'discord', `🐛 reports · ${project.name}`, { projectId })
}

/** Panels that belong to the workspace rather than a single project. */
export function openWatchPanel(): void {
  openAuxPanel('watch', 'watch', '▶ watch', {})
}

export function openIdeasPanel(): void {
  openAuxPanel('ideas', 'ideas', '💡 ideas', {})
}

/**
 * Open a tab for an already-attached native window. The picker attaches first
 * so a failure is reported there rather than by an empty panel.
 */
export function openEmbedPanel(hwnd: number, title: string, exe: string): void {
  const label = exe ? (exe.split(/[\\/]/).pop() ?? title) : title
  openAuxPanel(`embed:${hwnd}`, 'embed', `⬚ ${label.replace(/\.exe$/i, '')}`, {
    hwnd,
    title,
    exe
  })
}

function fileLabel(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

// ---- rojo ------------------------------------------------------------------

export async function startRojo(projectId: string): Promise<void> {
  const state = useStore.getState()
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) return
  await window.api.rojo.start({
    projectId,
    projectPath: project.path,
    projectFile: project.rojo.projectFile,
    port: project.rojo.port,
    binary: project.rojo.binary || state.settings.rojoBinary
  })
}

export async function stopRojo(projectId: string): Promise<void> {
  await window.api.rojo.stop(projectId)
}

export async function toggleRojo(projectId: string): Promise<void> {
  const status = useStore.getState().rojoStates[projectId]?.status ?? 'stopped'
  if (status === 'running' || status === 'starting') await stopRojo(projectId)
  else await startRojo(projectId)
}

// ---- roblox ----------------------------------------------------------------

export async function openInStudio(projectId: string): Promise<void> {
  const state = useStore.getState()
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) return

  const result = await window.api.roblox.open(project.path, project.roblox, project.id)
  if (result.ok) {
    // Remember what Studio called it, so a later launch can find the window.
    if (result.placeName && result.placeName !== project.roblox.placeName) {
      state.updateRoblox(project.id, { placeName: result.placeName })
    }
    return
  }

  // Nothing linked yet: send them to the place where they can link it.
  const configure = await window.api.dialog.confirm({
    title: 'Open in Roblox Studio',
    message: result.error ?? 'Could not open Roblox Studio.',
    detail: 'Link a place file or place ID in this project’s settings.',
    confirmLabel: 'Open settings'
  })
  if (configure) state.setModal({ kind: 'project', projectId })
}

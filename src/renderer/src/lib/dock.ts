import type { DockviewApi } from 'dockview'
import type { TerminalConfig } from '@shared/types'

let dockApi: DockviewApi | null = null

/** Terminals created this session that should launch as soon as they mount. */
const pendingAutoStart = new Set<string>()

export function setDockApi(api: DockviewApi | null): void {
  dockApi = api
}

export function getDockApi(): DockviewApi | null {
  return dockApi
}

export function markAutoStart(id: string): void {
  pendingAutoStart.add(id)
}

export function consumeAutoStart(id: string): boolean {
  return pendingAutoStart.delete(id)
}

export function isPanelOpen(id: string): boolean {
  return Boolean(dockApi?.getPanel(id))
}

export function openPanel(term: TerminalConfig, activate = true): void {
  if (!dockApi) return
  const existing = dockApi.getPanel(term.id)
  if (existing) {
    if (activate) existing.api.setActive()
    return
  }
  dockApi.addPanel({
    id: term.id,
    component: 'terminal',
    title: term.title,
    params: { terminalId: term.id },
    inactive: !activate
  })
}

/**
 * Open a non-terminal panel (editor, file tree, Rojo log, Notion board).
 * Re-focuses an existing panel rather than opening a duplicate.
 */
export function openAuxPanel(
  id: string,
  component: string,
  title: string,
  params: Record<string, unknown>
): void {
  if (!dockApi) return
  const existing = dockApi.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return
  }
  dockApi.addPanel({ id, component, title, params })
}

export function closePanel(id: string): void {
  const panel = dockApi?.getPanel(id)
  if (panel && dockApi) dockApi.removePanel(panel)
}

export function focusPanel(id: string): void {
  dockApi?.getPanel(id)?.api.setActive()
}

export function setPanelTitle(id: string, title: string): void {
  dockApi?.getPanel(id)?.api.setTitle(title)
}

/** Ids of open panels in visual tab order. */
export function openPanelIds(): string[] {
  if (!dockApi) return []
  return dockApi.panels.map((p) => p.id)
}

export function activePanelId(): string | null {
  return dockApi?.activePanel?.id ?? null
}

export function cyclePanel(delta: number): void {
  const ids = openPanelIds()
  if (ids.length < 2) return
  const current = activePanelId()
  const index = current ? ids.indexOf(current) : -1
  const next = ids[(((index + delta) % ids.length) + ids.length) % ids.length]
  focusPanel(next)
}

export function focusPanelByIndex(oneBased: number): void {
  const ids = openPanelIds()
  const id = ids[oneBased - 1]
  if (id) focusPanel(id)
}

export type ArrangeMode = 'grid' | 'columns' | 'rows' | 'stack'

/**
 * Tile every open terminal. Each mode first collapses the dock into a single
 * group so the result is the same no matter what the layout looked like before.
 */
export function arrangePanels(mode: ArrangeMode): void {
  const api = dockApi
  if (!api) return

  const panels = [...api.panels]
  if (panels.length < 2) return

  const [first, ...rest] = panels
  for (const p of rest) p.api.moveTo({ group: first.api.group })
  if (mode === 'stack') {
    first.api.setActive()
    return
  }

  if (mode === 'columns' || mode === 'rows') {
    const position = mode === 'columns' ? 'right' : 'bottom'
    let ref = first.api.group
    for (const p of rest) {
      p.api.moveTo({ group: ref, position })
      ref = p.api.group
    }
    first.api.setActive()
    return
  }

  // Square-ish grid: lay out the column heads, then fill each column downwards.
  const columns = Math.ceil(Math.sqrt(panels.length))
  const queue = [...rest]
  const tails = [first.api.group]

  let ref = first.api.group
  for (let c = 1; c < columns && queue.length > 0; c++) {
    const p = queue.shift()!
    p.api.moveTo({ group: ref, position: 'right' })
    ref = p.api.group
    tails.push(ref)
  }

  queue.forEach((p, i) => {
    const column = i % tails.length
    p.api.moveTo({ group: tails[column], position: 'bottom' })
    tails[column] = p.api.group
  })

  first.api.setActive()
}

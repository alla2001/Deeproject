import { useEffect } from 'react'
import { flushState, useStore } from './state'
import { Dock } from './components/Dock'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { CommandPalette } from './components/CommandPalette'
import { QuickOpen } from './components/QuickOpen'
import { ContextMenuHost } from './components/ContextMenu'
import { PresetsDialog, ProjectDialog, SettingsDialog, TerminalDialog } from './components/dialogs'
import { pushData } from './lib/terminals'
import { altDigit, matches, SHORTCUTS } from './lib/keys'
import { cyclePanel, focusPanelByIndex } from './lib/dock'
import { closeTerminal, launchPreset, restartTerminal, startRojo } from './lib/actions'
import { dirtyFiles } from './lib/editors'

/** True when the event landed in a text field, where plain chords should type. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const modal = useStore((s) => s.modal)
  const sidebarVisible = useStore((s) => s.settings.sidebarVisible)

  useEffect(() => {
    void init()
  }, [init])

  // Bridge PTY traffic, resource samples and Rojo state from main.
  useEffect(() => {
    const offData = window.api.pty.onData((e) => pushData(e.terminalId, e.runId, e.seq, e.data))
    const offStatus = window.api.pty.onStatus((e) => {
      useStore.getState().setStatus(e.terminalId, e.status)
    })
    const offStats = window.api.stats.onUpdate((all) => useStore.getState().setStats(all))
    const offRojo = window.api.rojo.onState((state) => useStore.getState().setRojoState(state))
    return () => {
      offData()
      offStatus()
      offStats()
      offRojo()
    }
  }, [])

  // Dropping a file anywhere except a terminal would otherwise make the window
  // navigate to it, blanking the app.
  useEffect(() => {
    const swallow = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  // Nothing in flight is lost when the window goes away, and unsaved editor
  // buffers get a chance to be rescued first.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      flushState()
      const dirty = dirtyFiles()
      if (dirty.length > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    // Periodic safety net for anything a crash would otherwise take with it.
    const timer = window.setInterval(() => window.api.state.flush(), 15_000)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.clearInterval(timer)
    }
  }, [])

  // Bring up Rojo servers that are configured to start with the app.
  useEffect(() => {
    if (!ready) return
    for (const project of useStore.getState().projects) {
      if (project.rojo.autoStart) void startRojo(project.id)
    }
  }, [ready])

  // Global chords. Captured before xterm sees them.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const store = useStore.getState()

      if (matches(e, SHORTCUTS.palette)) {
        e.preventDefault()
        store.setPaletteOpen(!store.paletteOpen)
        return
      }
      // Ctrl+P belongs to the shell while a terminal has focus, and to the
      // caret while the user is typing in a field.
      if (matches(e, SHORTCUTS.quickOpen) && !isTyping(e.target)) {
        const inTerminal = (e.target as HTMLElement | null)?.closest('.term-panel')
        if (!inTerminal) {
          e.preventDefault()
          store.setQuickOpen(!store.quickOpen)
          return
        }
      }
      if (matches(e, SHORTCUTS.toggleSidebar)) {
        e.preventDefault()
        store.updateSettings({ sidebarVisible: !store.settings.sidebarVisible })
        return
      }
      if (matches(e, SHORTCUTS.addProject)) {
        e.preventDefault()
        void store.addProjects()
        return
      }
      if (matches(e, SHORTCUTS.settings)) {
        e.preventDefault()
        store.setModal({ kind: 'settings' })
        return
      }
      if (matches(e, SHORTCUTS.nextTab)) {
        e.preventDefault()
        cyclePanel(1)
        return
      }
      if (matches(e, SHORTCUTS.prevTab)) {
        e.preventDefault()
        cyclePanel(-1)
        return
      }
      const digit = altDigit(e)
      if (digit !== null) {
        e.preventDefault()
        focusPanelByIndex(digit)
        return
      }

      const activeId = store.activeTerminalId
      if (matches(e, SHORTCUTS.newTerminal)) {
        e.preventDefault()
        // Reuse the active terminal's project, else the most recent one.
        const active = store.terminals.find((t) => t.id === activeId)
        const projectId =
          active?.projectId ??
          [...store.projects].sort(
            (a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt)
          )[0]?.id
        if (!projectId) return
        const preset = store.presets.find((p) => p.pinned) ?? store.presets[0]
        if (preset) launchPreset(projectId, preset)
        return
      }
      if (!activeId) return

      if (matches(e, SHORTCUTS.closeTerminal)) {
        e.preventDefault()
        void closeTerminal(activeId)
      } else if (matches(e, SHORTCUTS.restartTerminal)) {
        e.preventDefault()
        void restartTerminal(activeId)
      } else if (matches(e, SHORTCUTS.find)) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('dp:find', { detail: activeId }))
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark">◫</div>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        {sidebarVisible && <Sidebar />}
        <main className="workspace">
          <Dock />
        </main>
      </div>

      {modal?.kind === 'project' && <ProjectDialog projectId={modal.projectId} />}
      {modal?.kind === 'terminal' && <TerminalDialog terminalId={modal.terminalId} />}
      {modal?.kind === 'settings' && <SettingsDialog />}
      {modal?.kind === 'presets' && <PresetsDialog />}

      <CommandPalette />
      <QuickOpen />
      <ContextMenuHost />
    </div>
  )
}

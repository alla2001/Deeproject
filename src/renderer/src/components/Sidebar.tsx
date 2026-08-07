import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, TerminalConfig } from '@shared/types'
import { useStore } from '../state'
import { useMenu, type MenuItem } from './ContextMenu'
import {
  closeTerminal,
  launchPreset,
  openDiscordPanel,
  openFilesPanel,
  openIdeasPanel,
  openInStudio,
  openNotionPanel,
  openRojoPanel,
  openTerminal,
  restartTerminal,
  stopTerminal,
  togglePause,
  toggleRojo,
  openWatchPanel
} from '../lib/actions'

/** Short enough to sit in a sidebar row without pushing the title out. */
const ATTENTION_BADGE: Record<'bell' | 'quiet' | 'exited', string> = {
  bell: 'asking',
  quiet: 'idle',
  exited: 'done'
}

const ATTENTION_TITLE: Record<'bell' | 'quiet' | 'exited', string> = {
  bell: 'This terminal rang for you.',
  quiet: 'This terminal has gone quiet — finished, or waiting on you.',
  exited: 'This terminal finished.'
}

function StatusDot({ id }: { id: string }): JSX.Element {
  const status = useStore((s) => s.statuses[id] ?? 'stopped')
  return <span className={`dot dot--${status}`} title={status} />
}

/** Clicking the running-port chip stops the server. */
async function stopRojoFromChip(projectId: string): Promise<void> {
  await window.api.rojo.stop(projectId)
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return ''
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(0)}M`
  return `${(mb / 1024).toFixed(1)}G`
}

function TerminalRow({
  term,
  projectName
}: {
  term: TerminalConfig
  projectName: string
}): JSX.Element {
  const status = useStore((s) => s.statuses[term.id] ?? 'stopped')
  const active = useStore((s) => s.activeTerminalId === term.id)
  const isOpen = useStore((s) => s.openPanels.includes(term.id))
  const stats = useStore((s) => s.stats[term.id])
  const attention = useStore((s) => s.attention[term.id])
  const preset = useStore((s) => s.presets.find((p) => p.id === term.presetId))
  const setModal = useStore((s) => s.setModal)
  const openMenu = useMenu((s) => s.open)

  // Terminals default to the project's name, which reads as a duplicate of the
  // header they sit under. Show what the terminal actually runs instead, unless
  // the title has been customised.
  const label =
    term.title === projectName ? (preset?.label ?? term.command ?? 'shell') : term.title

  const items: MenuItem[] = [
    { label: 'Customise…', onClick: () => setModal({ kind: 'terminal', terminalId: term.id }) },
    { separator: true },
    { label: 'Restart', onClick: () => void restartTerminal(term.id) },
    { label: 'Stop', onClick: () => void stopTerminal(term.id), disabled: status !== 'running' },
    {
      label: term.paused ? 'Resume' : 'Pause (free its resources)',
      onClick: () => void togglePause(term.id)
    },
    { separator: true },
    { label: 'Close terminal', onClick: () => void closeTerminal(term.id), danger: true }
  ]

  const wants = attention?.needsYou === true && !term.paused
  const working = attention?.activity === 'busy' && status === 'running' && !term.paused

  return (
    <div
      className={`term-row${active ? ' term-row--active' : ''}${wants ? ' term-row--wants' : ''}`}
      style={{ ['--accent' as string]: term.color }}
      onClick={() => openTerminal(term.id)}
      onContextMenu={(e) => openMenu(e, items)}
      title={
        wants
          ? `${ATTENTION_TITLE[attention!.reason ?? 'quiet']}\n\n${attention!.tail || 'No output to show.'}`
          : `${term.command ?? 'shell'}\n${term.cwd}`
      }
    >
      <span className="term-row-emoji">{term.emoji}</span>
      <span className="term-row-title">{label}</span>
      {/* A terminal that wants you says so instead of showing its memory use. */}
      {wants ? (
        <span className="term-row-wants">{ATTENTION_BADGE[attention!.reason ?? 'quiet']}</span>
      ) : (
        status === 'running' &&
        !term.paused &&
        stats && (
          <span
            className="term-row-stats"
            title={`${stats.cpu.toFixed(1)}% CPU · ${stats.processes} processes`}
          >
            {stats.cpu >= 1 ? `${stats.cpu.toFixed(0)}%` : ''} {formatBytes(stats.memory)}
          </span>
        )
      )}
      {term.paused && <span className="term-row-badge term-row-badge--paused">paused</span>}
      {!isOpen && !term.paused && <span className="term-row-badge">closed</span>}
      {term.paused ? (
        <span className="dot dot--paused" title="paused" />
      ) : working ? (
        <span className="dot dot--working" title="working" />
      ) : (
        <StatusDot id={term.id} />
      )}
    </div>
  )
}

function ProjectGroup({
  project,
  filter,
  onDragStart,
  onDropOn
}: {
  project: Project
  filter: string
  onDragStart: (id: string) => void
  onDropOn: (id: string, before: boolean) => void
}): JSX.Element {
  // Select the stable array and narrow it here: a selector that builds a new
  // array would re-fire useSyncExternalStore on every render.
  const allTerminals = useStore((s) => s.terminals)
  const terminals = useMemo(
    () => allTerminals.filter((t) => t.projectId === project.id),
    [allTerminals, project.id]
  )
  const presets = useStore((s) => s.presets)
  const updateProject = useStore((s) => s.updateProject)
  const removeProject = useStore((s) => s.removeProject)
  const setModal = useStore((s) => s.setModal)
  const editorCommand = useStore((s) => s.settings.editorCommand)
  const rojoState = useStore((s) => s.rojoStates[project.id])
  const openMenu = useMenu((s) => s.open)
  const [missing, setMissing] = useState(false)
  const [dropEdge, setDropEdge] = useState<'top' | 'bottom' | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.sys.pathExists(project.path).then((ok) => {
      if (alive) setMissing(!ok)
    })
    return () => {
      alive = false
    }
  }, [project.path])

  const rojoStatus = rojoState?.status ?? 'stopped'
  const rojoRunning = rojoStatus === 'running' || rojoStatus === 'starting'
  const rojoPort = rojoState?.port ?? project.rojo.port
  // The ＋ button launches this one; everything else is a click away in ⋯.
  const defaultPreset = presets.find((p) => p.pinned) ?? presets[0]
  const visibleTerminals = filter
    ? terminals.filter((t) => t.title.toLowerCase().includes(filter))
    : terminals
  const collapsed = project.collapsed && !filter

  const menuItems: MenuItem[] = [
    // Every preset lives here now that the row only has a single ＋ button.
    ...presets.map((preset) => ({
      label: `${preset.emoji}  ${preset.label}`,
      hint: preset.command ?? 'shell',
      onClick: () => launchPreset(project.id, preset)
    })),
    { separator: true },
    {
      label: 'Configure project…',
      hint: 'look, Rojo, Roblox, tasks',
      onClick: () => setModal({ kind: 'project', projectId: project.id })
    },
    { separator: true },
    { label: 'Browse files', onClick: () => openFilesPanel(project.id) },
    { label: 'Tasks (Notion)', onClick: () => openNotionPanel(project.id) },
    { label: 'Bug reports (Discord)', onClick: () => openDiscordPanel(project.id) },
    {
      label: rojoRunning ? `Stop Rojo (:${rojoPort})` : `Start Rojo (:${rojoPort})`,
      onClick: () => void toggleRojo(project.id)
    },
    { label: 'Rojo output', onClick: () => openRojoPanel(project.id) },
    { label: 'Open in Roblox Studio', onClick: () => void openInStudio(project.id) },
    { separator: true },
    { label: 'Open in file explorer', onClick: () => void window.api.sys.reveal(project.path) },
    {
      label: 'Open in external editor',
      onClick: () => void window.api.sys.openInEditor(project.path, editorCommand)
    },
    { separator: true },
    {
      label: 'Remove project',
      danger: true,
      onClick: async () => {
        const ok = await window.api.dialog.confirm({
          title: 'Remove project',
          message: `Remove "${project.name}"?`,
          detail: `Its ${terminals.length} terminal(s) will be closed. The folder on disk is not touched.`,
          confirmLabel: 'Remove'
        })
        if (!ok) return
        for (const t of terminals) await closeTerminal(t.id, true)
        removeProject(project.id)
      }
    }
  ]

  return (
    <div
      className={`project${collapsed ? '' : ' project--open'}${dropEdge ? ` project--drop-${dropEdge}` : ''}`}
      style={{ ['--accent' as string]: project.color }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(project.id)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        setDropEdge(e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom')
      }}
      onDragLeave={() => setDropEdge(null)}
      onDrop={(e) => {
        e.preventDefault()
        const before = dropEdge === 'top'
        setDropEdge(null)
        onDropOn(project.id, before)
      }}
    >
      <div
        className="project-row"
        onClick={() => updateProject(project.id, { collapsed: !project.collapsed })}
        onContextMenu={(e) => openMenu(e, menuItems)}
        title={project.path}
      >
        <span className={`chevron${collapsed ? '' : ' chevron--open'}`}>▸</span>
        <span className="project-emoji">{project.emoji}</span>
        <span className="project-name">{project.name}</span>
        {missing && (
          <span className="project-warn" title="Folder not found on disk">
            !
          </span>
        )}
        {/* Only while collapsed — expanded projects show state on the Rojo pill. */}
        {collapsed && rojoRunning && (
          <span
            className={`rojo-chip rojo-chip--${rojoStatus}`}
            title={`Rojo serving on port ${rojoPort} — click to stop`}
            onClick={(e) => {
              e.stopPropagation()
              void stopRojoFromChip(project.id)
            }}
          >
            ⬤ {rojoPort}
          </span>
        )}
        {collapsed && rojoStatus === 'error' && (
          <span className="rojo-chip rojo-chip--error" title={rojoState?.message ?? 'Rojo error'}>
            rojo !
          </span>
        )}
        <span className="project-count">{terminals.length || ''}</span>

        {/* Two controls only: start the usual thing, or open everything else. */}
        <span className="project-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="row-btn row-btn--primary"
            title={
              defaultPreset
                ? `New terminal — ${defaultPreset.label}\n${defaultPreset.command ?? 'shell'}`
                : 'New terminal'
            }
            disabled={!defaultPreset}
            onClick={() => defaultPreset && launchPreset(project.id, defaultPreset)}
          >
            ＋
          </button>
          <button
            className="row-btn"
            title="Configure project"
            onClick={() => setModal({ kind: 'project', projectId: project.id })}
          >
            ⚙
          </button>
          <button
            className="row-btn"
            title="More actions"
            onClick={(e) => openMenu(e, menuItems)}
          >
            ⋯
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="project-tools" onClick={(e) => e.stopPropagation()}>
          <button className="tool" onClick={() => openFilesPanel(project.id)}>
            <span className="tool-icon">📂</span>Files
          </button>
          <button className="tool" onClick={() => openNotionPanel(project.id)}>
            <span className="tool-icon">✅</span>Tasks
          </button>
          <button
            className="tool"
            title="Bug reports from this project's Discord forum"
            onClick={() => openDiscordPanel(project.id)}
          >
            <span className="tool-icon">🐛</span>Reports
          </button>
          <button
            className={`tool${rojoRunning ? ' tool--on' : ''}${rojoStatus === 'error' ? ' tool--bad' : ''}`}
            title={
              rojoStatus === 'error'
                ? (rojoState?.message ?? 'Rojo failed — right-click for the log')
                : `${rojoRunning ? 'Stop' : 'Start'} the Rojo server on port ${rojoPort}\nRight-click for output`
            }
            onClick={() => void toggleRojo(project.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              openRojoPanel(project.id)
            }}
          >
            <span className="tool-icon">🧩</span>
            {rojoRunning ? `Rojo :${rojoPort}` : 'Rojo'}
          </button>
          <button
            className="tool"
            title="Open this project in Roblox Studio"
            onClick={() => void openInStudio(project.id)}
          >
            <span className="tool-icon">🎮</span>Studio
          </button>
          <button
            className="tool"
            title="Configure this project — look, Rojo, Roblox and tasks"
            onClick={() => setModal({ kind: 'project', projectId: project.id })}
          >
            <span className="tool-icon">⚙</span>Config
          </button>
        </div>
      )}

      {!collapsed && (
        <div className="project-terminals">
          {visibleTerminals.map((t) => (
            <TerminalRow key={t.id} term={t} projectName={project.name} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Sidebar(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const terminals = useStore((s) => s.terminals)
  const width = useStore((s) => s.settings.sidebarWidth)
  const addProjects = useStore((s) => s.addProjects)
  const moveProject = useStore((s) => s.moveProject)
  const updateSettings = useStore((s) => s.updateSettings)
  const setModal = useStore((s) => s.setModal)
  const [filter, setFilter] = useState('')
  const dragId = useRef<string | null>(null)

  const normalized = filter.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!normalized) return projects
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(normalized) ||
        p.path.toLowerCase().includes(normalized) ||
        terminals.some(
          (t) => t.projectId === p.id && t.title.toLowerCase().includes(normalized)
        )
    )
  }, [projects, terminals, normalized])

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: MouseEvent): void => {
      const next = Math.min(520, Math.max(180, startWidth + ev.clientX - startX))
      updateSettings({ sidebarWidth: next })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <input
          className="search"
          placeholder="Filter projects…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="icon-btn"
          title="Add project folder  (Ctrl+Shift+N)"
          onClick={() => void addProjects()}
        >
          +
        </button>
      </div>

      <div className="project-list">
        {visible.length === 0 && (
          <div className="sidebar-empty">
            {projects.length === 0 ? (
              <>
                <p>No projects yet.</p>
                <button className="btn" onClick={() => void addProjects()}>
                  Add a folder
                </button>
              </>
            ) : (
              <p>Nothing matches “{filter}”.</p>
            )}
          </div>
        )}
        {visible.map((p) => (
          <ProjectGroup
            key={p.id}
            project={p}
            filter={normalized}
            onDragStart={(id) => {
              dragId.current = id
            }}
            onDropOn={(targetId, before) => {
              if (dragId.current) moveProject(dragId.current, targetId, before)
              dragId.current = null
            }}
          />
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => openIdeasPanel()} title="Game ideas">
          💡 Ideas
        </button>
        <button className="foot-btn" onClick={() => openWatchPanel()} title="Watch a YouTube video">
          ▶ Watch
        </button>
        <button
          className="foot-btn"
          onClick={() => setModal({ kind: 'embed' })}
          title="Dock a running application into a tab"
        >
          ⬚ Dock app
        </button>
      </div>
      <div className="sidebar-foot">
        <button className="foot-btn" onClick={() => setModal({ kind: 'presets' })}>
          ⚡ Presets
        </button>
        <button
          className="foot-btn"
          onClick={() => setModal({ kind: 'transfer' })}
          title="Move this setup to another computer"
        >
          ⇄ Transfer
        </button>
        <button className="foot-btn" onClick={() => setModal({ kind: 'settings' })}>
          ⚙ Settings
        </button>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} />
    </aside>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state'
import {
  launchPreset,
  openFilesPanel,
  openIdeasPanel,
  openInStudio,
  openNotionPanel,
  openRojoPanel,
  openTerminal,
  openWatchPanel,
  restartTerminal,
  toggleRojo
} from '../lib/actions'
import { arrangePanels } from '../lib/dock'

interface Command {
  id: string
  label: string
  detail?: string
  icon: string
  run: () => void
}

/** Subsequence match — "cr" hits "claude resume". Returns null when no match. */
function score(haystack: string, needle: string): number | null {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  const direct = h.indexOf(n)
  if (direct !== -1) return direct === 0 ? 1000 : 500 - direct

  let hi = 0
  let hits = 0
  let gapPenalty = 0
  for (const ch of n) {
    const found = h.indexOf(ch, hi)
    if (found === -1) return null
    gapPenalty += found - hi
    hi = found + 1
    hits++
  }
  return hits * 10 - gapPenalty
}

export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const projects = useStore((s) => s.projects)
  const terminals = useStore((s) => s.terminals)
  const presets = useStore((s) => s.presets)
  const setModal = useStore((s) => s.setModal)
  const addProjects = useStore((s) => s.addProjects)
  const activeTerminalId = useStore((s) => s.activeTerminalId)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []

    for (const project of projects) {
      for (const preset of presets) {
        list.push({
          id: `launch:${project.id}:${preset.id}`,
          label: `${project.name} — ${preset.label}`,
          detail: preset.command ?? 'shell',
          icon: preset.emoji,
          run: () => launchPreset(project.id, preset)
        })
      }
    }

    for (const term of terminals) {
      const project = projects.find((p) => p.id === term.projectId)
      list.push({
        id: `focus:${term.id}`,
        label: `Go to ${term.title}`,
        detail: [project?.name, term.command ?? 'shell'].filter(Boolean).join(' · '),
        icon: term.emoji,
        run: () => openTerminal(term.id)
      })
    }

    for (const project of projects) {
      list.push(
        {
          id: `files:${project.id}`,
          label: `Browse files — ${project.name}`,
          detail: project.path,
          icon: '📂',
          run: () => openFilesPanel(project.id)
        },
        {
          id: `tasks:${project.id}`,
          label: `Tasks — ${project.name}`,
          detail: project.notion.target ?? 'not linked to Notion yet',
          icon: '✅',
          run: () => openNotionPanel(project.id)
        },
        {
          id: `rojo-toggle:${project.id}`,
          label: `Toggle Rojo server — ${project.name}`,
          detail: `port ${project.rojo.port}`,
          icon: '🧩',
          run: () => void toggleRojo(project.id)
        },
        {
          id: `rojo-log:${project.id}`,
          label: `Rojo output — ${project.name}`,
          detail: `port ${project.rojo.port}`,
          icon: '📜',
          run: () => openRojoPanel(project.id)
        },
        {
          id: `studio:${project.id}`,
          label: `Open in Roblox Studio — ${project.name}`,
          detail: project.roblox.placeId
            ? `place ${project.roblox.placeId}`
            : (project.roblox.placeFile ?? 'not linked yet'),
          icon: '🎮',
          run: () => void openInStudio(project.id)
        },
        {
          id: `reveal:${project.id}`,
          label: `Open ${project.name} in file explorer`,
          detail: project.path,
          icon: '🗂️',
          run: () => void window.api.sys.reveal(project.path)
        }
      )
    }

    list.push(
      { id: 'tile-grid', label: 'Tile terminals as a grid', icon: '▦', run: () => arrangePanels('grid') },
      {
        id: 'tile-columns',
        label: 'Tile terminals as columns',
        icon: '▥',
        run: () => arrangePanels('columns')
      },
      { id: 'tile-rows', label: 'Tile terminals as rows', icon: '▤', run: () => arrangePanels('rows') },
      {
        id: 'tile-stack',
        label: 'Stack terminals into one group',
        icon: '▣',
        run: () => arrangePanels('stack')
      },
      { id: 'ideas', label: 'Game ideas', icon: '💡', run: () => openIdeasPanel() },
      { id: 'watch', label: 'Watch a YouTube video', icon: '▶', run: () => openWatchPanel() },
      {
        id: 'embed',
        label: 'Dock an application into a tab',
        icon: '⬚',
        run: () => setModal({ kind: 'embed' })
      },
      { id: 'add-project', label: 'Add project folder', icon: '➕', run: () => void addProjects() },
      { id: 'presets', label: 'Edit launch presets', icon: '⚡', run: () => setModal({ kind: 'presets' }) },
      { id: 'settings', label: 'Open settings', icon: '⚙', run: () => setModal({ kind: 'settings' }) }
    )

    if (activeTerminalId) {
      list.push({
        id: 'restart-active',
        label: 'Restart active terminal',
        icon: '🔄',
        run: () => void restartTerminal(activeTerminalId)
      })
    }

    return list
  }, [projects, terminals, presets, activeTerminalId, addProjects, setModal])

  const results = useMemo(() => {
    if (!query.trim()) return commands.slice(0, 40)
    const scored: { cmd: Command; s: number }[] = []
    for (const cmd of commands) {
      const s = score(`${cmd.label} ${cmd.detail ?? ''}`, query.trim())
      if (s !== null) scored.push({ cmd, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 40).map((x) => x.cmd)
  }, [commands, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('.palette-row--on')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  function choose(cmd: Command | undefined): void {
    if (!cmd) return
    setOpen(false)
    cmd.run()
  }

  return (
    <div className="modal-scrim modal-scrim--top" onMouseDown={() => setOpen(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Launch a project, jump to a terminal…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((cmd, i) => (
            <button
              key={cmd.id}
              className={`palette-row${i === index ? ' palette-row--on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(cmd)}
            >
              <span className="palette-icon">{cmd.icon}</span>
              <span className="palette-label">{cmd.label}</span>
              {cmd.detail && <span className="palette-detail">{cmd.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

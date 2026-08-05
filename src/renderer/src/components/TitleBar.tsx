import { useStore } from '../state'
import { arrangePanels, type ArrangeMode } from '../lib/dock'

const ARRANGE: { mode: ArrangeMode; icon: string; label: string }[] = [
  { mode: 'grid', icon: '▦', label: 'Tile as grid' },
  { mode: 'columns', icon: '▥', label: 'Tile as columns' },
  { mode: 'rows', icon: '▤', label: 'Tile as rows' },
  { mode: 'stack', icon: '▣', label: 'Stack into one group' }
]

export function TitleBar(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)
  const projects = useStore((s) => s.projects)
  const openCount = useStore((s) => s.openPanels.length)
  const running = useStore((s) => Object.values(s.statuses).filter((v) => v === 'running').length)

  return (
    <header className="titlebar">
      <button
        className="icon-btn no-drag"
        title="Toggle sidebar  (Ctrl+Shift+B)"
        onClick={() => updateSettings({ sidebarVisible: !settings.sidebarVisible })}
      >
        ☰
      </button>
      <span className="titlebar-brand">Deeproject</span>
      <span className="titlebar-meta">
        {projects.length} project{projects.length === 1 ? '' : 's'} · {running} running
      </span>
      <button
        className="titlebar-search no-drag"
        onClick={() => setPaletteOpen(true)}
        title="Command palette"
      >
        <span>Search projects & terminals</span>
        <kbd>Ctrl+Shift+P</kbd>
      </button>
      <div className="arrange-group">
        {ARRANGE.map((a) => (
          <button
            key={a.mode}
            className="icon-btn no-drag"
            title={a.label}
            disabled={openCount < 2}
            onClick={() => arrangePanels(a.mode)}
          >
            {a.icon}
          </button>
        ))}
      </div>
      <div className="titlebar-spacer" />
    </header>
  )
}

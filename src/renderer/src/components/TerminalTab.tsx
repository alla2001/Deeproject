import type { IDockviewPanelHeaderProps } from 'dockview'
import { useStore } from '../state'
import { useMenu } from './ContextMenu'
import {
  closeTerminal,
  hideTerminal,
  restartTerminal,
  stopTerminal,
  togglePause
} from '../lib/actions'
import { disposeFile, useEditors } from '../lib/editors'
import type { TerminalPanelParams } from './TerminalPanel'

type AnyParams = Partial<TerminalPanelParams> & {
  projectId?: string
  filePath?: string
}

function TerminalTabBody(props: IDockviewPanelHeaderProps<TerminalPanelParams>): JSX.Element {
  const id = props.params.terminalId
  const term = useStore((s) => s.terminals.find((t) => t.id === id))
  const project = useStore((s) => s.projects.find((p) => p.id === term?.projectId))
  const status = useStore((s) => s.statuses[id] ?? 'stopped')
  const stats = useStore((s) => s.stats[id])
  const setModal = useStore((s) => s.setModal)
  const openMenu = useMenu((s) => s.open)

  if (!term) return <div className="tab">Unknown</div>

  const tooltip = [
    project?.name,
    term.command ?? 'shell',
    term.cwd,
    stats ? `${stats.cpu.toFixed(1)}% CPU · ${formatBytes(stats.memory)}` : null
  ]
    .filter(Boolean)
    .join('  ·  ')

  return (
    <div
      className={`tab tab--${status}`}
      style={{ ['--accent' as string]: term.color }}
      title={tooltip}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void closeTerminal(id)
        }
      }}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Customise…', onClick: () => setModal({ kind: 'terminal', terminalId: id }) },
          { separator: true },
          { label: 'Restart', onClick: () => void restartTerminal(id), hint: 'Ctrl+Shift+R' },
          { label: 'Stop', onClick: () => void stopTerminal(id), disabled: status !== 'running' },
          {
            label: term.paused ? 'Resume' : 'Pause (free its resources)',
            onClick: () => void togglePause(id)
          },
          { separator: true },
          { label: 'Hide tab (keep terminal)', onClick: () => hideTerminal(id) },
          {
            label: 'Close terminal',
            onClick: () => void closeTerminal(id),
            danger: true,
            hint: 'Ctrl+Shift+W'
          }
        ])
      }
    >
      <span className="tab-emoji">{term.emoji}</span>
      <span className="tab-title">{term.title}</span>
      {term.paused ? (
        <span className="tab-paused" title="Paused — using no resources">
          ❚❚
        </span>
      ) : (
        <span className={`tab-dot tab-dot--${status}`} />
      )}
      <button
        className="tab-close"
        title="Close terminal"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void closeTerminal(id)
        }}
      >
        ✕
      </button>
    </div>
  )
}

function AuxTabBody(props: IDockviewPanelHeaderProps<AnyParams>): JSX.Element {
  const panelId = props.api.id
  const key = props.params.filePath ? `editor:${props.params.filePath.toLowerCase()}` : null
  const file = useEditors((s) => (key ? s.files[key] : undefined))
  const title = props.api.title ?? 'Panel'

  function close(): void {
    if (key) disposeFile(key)
    props.api.close()
  }

  async function confirmClose(): Promise<void> {
    if (file?.dirty) {
      const discard = await window.api.dialog.confirm({
        title: 'Unsaved changes',
        message: `"${file.name}" has unsaved changes.`,
        detail: 'Closing this tab will discard them.',
        confirmLabel: 'Discard and close'
      })
      if (!discard) return
    }
    close()
  }

  return (
    <div
      className={`tab tab--aux${file?.dirty ? ' tab--dirty' : ''}`}
      title={props.params.filePath ?? panelId}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void confirmClose()
        }
      }}
    >
      <span className="tab-title">{title}</span>
      <button
        className="tab-close"
        title="Close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void confirmClose()
        }}
      >
        ✕
      </button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** Single tab renderer for every panel type the dock hosts. */
export function PanelTab(props: IDockviewPanelHeaderProps<AnyParams>): JSX.Element {
  if (typeof props.params?.terminalId === 'string') {
    return <TerminalTabBody {...(props as IDockviewPanelHeaderProps<TerminalPanelParams>)} />
  }
  return <AuxTabBody {...props} />
}

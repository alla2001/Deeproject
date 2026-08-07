import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { ISearchOptions } from '@xterm/addon-search'
import { useStore } from '../state'
import { consumeAutoStart } from '../lib/dock'
import {
  applyConfig,
  getEntry,
  getOrCreate,
  pathToken,
  safeFit,
  syncFromMain
} from '../lib/terminals'
import { restartTerminal, resumeTerminal, startTerminal } from '../lib/actions'

export interface TerminalPanelParams extends Record<string, unknown> {
  terminalId: string
}

export function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>): JSX.Element {
  const id = props.params.terminalId
  const term = useStore((s) => s.terminals.find((t) => t.id === id))
  const settings = useStore((s) => s.settings)
  const status = useStore((s) => s.statuses[id] ?? 'stopped')
  const stats = useStore((s) => s.stats[id])
  const hostRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findValue, setFindValue] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)

  // Mount the (persistent) xterm element into this panel. The instance itself
  // outlives the panel so dragging a tab around never loses scrollback.
  useEffect(() => {
    const current = useStore.getState().terminals.find((t) => t.id === id)
    const host = hostRef.current
    // A paused terminal deliberately has no xterm instance at all.
    if (!current || current.paused || !host) return

    const entry = getOrCreate(current, useStore.getState().settings)
    host.appendChild(entry.container)
    safeFit(entry)

    const store = useStore.getState()
    const firstMount = !entry.synced
    const idle = (store.statuses[id] ?? 'stopped') === 'stopped'

    if (consumeAutoStart(id)) {
      void startTerminal(id)
    } else if (firstMount && idle && store.settings.autoStartTerminals) {
      // Restoring a saved workspace: relaunch instead of showing a dead tab.
      void startTerminal(id)
    } else if (firstMount) {
      // Only replay on the very first mount; a remount already has the buffer.
      void syncFromMain(id)
    }

    const ro = new ResizeObserver(() => safeFit(entry))
    ro.observe(host)

    return () => {
      ro.disconnect()
      entry.container.remove()
    }
    // Re-runs when paused flips, so resuming rebuilds the instance.
  }, [id, term?.paused])

  // Re-fit and focus as the panel is shown, resized, or activated.
  useEffect(() => {
    const disposables = [
      props.api.onDidDimensionsChange(() => {
        const entry = getEntry(id)
        if (entry) safeFit(entry)
      }),
      props.api.onDidVisibilityChange((e) => {
        if (!e.isVisible) return
        const entry = getEntry(id)
        if (entry) requestAnimationFrame(() => safeFit(entry))
      }),
      props.api.onDidActiveChange((e) => {
        if (!e.isActive) return
        useStore.getState().setActiveTerminal(id)
        const entry = getEntry(id)
        if (entry) {
          requestAnimationFrame(() => {
            safeFit(entry)
            entry.term.focus()
          })
        }
      })
    ]
    if (props.api.isActive) useStore.getState().setActiveTerminal(id)
    return () => disposables.forEach((d) => d.dispose())
  }, [id, props.api])

  // Push appearance changes into the live instance.
  useEffect(() => {
    const entry = getEntry(id)
    if (entry && term) applyConfig(entry, term, settings)
  }, [id, term, settings])

  // Keep the dock tab title in sync with the config.
  useEffect(() => {
    if (term) props.api.setTitle(term.title)
  }, [term?.title, props.api])

  useEffect(() => {
    function onFind(e: Event): void {
      const detail = (e as CustomEvent<string>).detail
      if (detail !== id) return
      setFindOpen(true)
      requestAnimationFrame(() => findInputRef.current?.select())
    }
    window.addEventListener('dp:find', onFind)
    return () => window.removeEventListener('dp:find', onFind)
  }, [id])

  function runSearch(value: string, back = false): void {
    const entry = getEntry(id)
    if (!entry || !value) return
    const opts: ISearchOptions = {
      decorations: {
        activeMatchBackground: '#f0c674',
        activeMatchColorOverviewRuler: '#f0c674',
        matchBackground: '#3d4a66',
        matchOverviewRuler: '#3d4a66'
      }
    }
    if (back) entry.search.findPrevious(value, opts)
    else entry.search.findNext(value, opts)
  }

  function closeFind(): void {
    setFindOpen(false)
    getEntry(id)?.search.clearDecorations()
    getEntry(id)?.term.focus()
  }

  if (!term) {
    return <div className="term-panel term-panel--missing">This terminal no longer exists.</div>
  }

  if (term.paused) {
    return (
      <div className="term-panel term-paused" style={{ ['--accent' as string]: term.color }}>
        <div className="term-paused-mark">{term.emoji}</div>
        <h3>Paused</h3>
        <p>
          Its process tree and terminal buffer are released, so it is using nothing. Resuming starts
          a fresh session in {term.cwd}.
        </p>
        <button className="btn btn--primary" onClick={() => void resumeTerminal(id)}>
          ▶ Resume
        </button>
        {term.command && <code className="term-paused-cmd">{term.command}</code>}
      </div>
    )
  }

  const bgPath = term.backgroundImage ?? settings.defaultBackgroundImage
  const bgOpacity = term.backgroundImage ? term.backgroundOpacity : settings.defaultBackgroundOpacity
  const bgBlur = term.backgroundImage ? term.backgroundBlur : settings.defaultBackgroundBlur

  /**
   * Hand files to whatever is running here by typing their paths. A PTY carries
   * bytes rather than attachments, and every CLI that takes a file takes a path
   * to one — so this is the same thing the drop target and an image paste do.
   */
  function attach(paths: string[]): void {
    const tokens = paths.filter(Boolean).map(pathToken)
    if (tokens.length === 0) return
    window.api.pty.write(id, tokens.join(''))
    getEntry(id)?.term.focus()
  }

  /** Dropping files types their paths, which is how you hand Claude an image. */
  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    setDropActive(false)
    attach(Array.from(e.dataTransfer.files).map((file) => window.api.sys.pathForFile(file)))
  }

  async function pickAndAttach(): Promise<void> {
    // Opening in the terminal's own folder saves the usual navigation, since
    // that is where the file being talked about nearly always is.
    attach(await window.api.dialog.pickFiles(term?.cwd))
  }

  return (
    <div
      className={`term-panel${dropActive ? ' term-panel--drop' : ''}`}
      style={{ ['--accent' as string]: term.color }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropActive(true)
      }}
      onDragLeave={(e) => {
        // Ignore the transient leave fired when crossing a child element.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropActive(false)
      }}
      onDrop={onDrop}
    >
      {bgPath && (
        <div
          className="term-bg"
          style={{
            backgroundImage: `url("${window.api.sys.mediaUrl(bgPath)}")`,
            opacity: bgOpacity,
            filter: bgBlur ? `blur(${bgBlur}px)` : undefined
          }}
        />
      )}
      <div className="term-accent-edge" />
      <div className="term-host-wrap" ref={hostRef} />

      {dropActive && (
        <div className="term-drop">
          <span>Drop to paste the file path</span>
        </div>
      )}

      {/* Hidden while the find bar is up, which claims the same corner. */}
      {!findOpen && (
        <div className="term-tools">
          <button
            className="term-tool"
            onClick={() => void pickAndAttach()}
            disabled={status !== 'running'}
            title={
              status === 'running'
                ? 'Attach files — types their paths into this terminal'
                : 'Nothing is running in this terminal'
            }
          >
            📎
          </button>
        </div>
      )}

      {findOpen && (
        <div className="find-bar">
          <input
            ref={findInputRef}
            value={findValue}
            placeholder="Find in terminal"
            onChange={(e) => {
              setFindValue(e.target.value)
              runSearch(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(findValue, e.shiftKey)
              if (e.key === 'Escape') closeFind()
              e.stopPropagation()
            }}
          />
          <button onClick={() => runSearch(findValue, true)} title="Previous (Shift+Enter)">
            ↑
          </button>
          <button onClick={() => runSearch(findValue)} title="Next (Enter)">
            ↓
          </button>
          <button onClick={closeFind} title="Close (Esc)">
            ✕
          </button>
        </div>
      )}

      {(status === 'exited' || status === 'stopped') && (
        <div className="term-dead">
          <span>{status === 'exited' ? 'Process exited' : 'Not running'}</span>
          <button onClick={() => void restartTerminal(id)}>Restart</button>
        </div>
      )}

      {status === 'running' && settings.statsIntervalMs > 0 && (
        <div className="term-stats" title="Resource use across this terminal's whole process tree">
          <span className="term-stat">
            <b>{(stats?.cpu ?? 0).toFixed(1)}%</b> cpu
          </span>
          <span className="term-stat">
            <b>{formatBytes(stats?.memory ?? 0)}</b> ram
          </span>
          <span className="term-stat">
            <b>{stats?.processes ?? 0}</b> proc
          </span>
          {stats?.topProcess && <span className="term-stat term-stat--name">{stats.topProcess}</span>}
          {stats?.pid && <span className="term-stat">pid {stats.pid}</span>}
          <span className="term-stat">{formatUptime(stats?.uptimeMs ?? 0)}</span>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

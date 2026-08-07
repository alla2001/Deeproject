import { useEffect, useMemo, useState } from 'react'
import type { EmbedCandidate } from '@shared/types'
import { useStore } from '../state'
import { openEmbedPanel } from '../lib/actions'
import { Modal } from './ui'

/** Executable path -> a friendlier name than the raw file name. */
function appName(candidate: EmbedCandidate): string {
  const file = candidate.exe.split(/[\\/]/).pop() ?? ''
  return file.replace(/\.exe$/i, '') || candidate.className
}

/**
 * Picks a running window to dock, or launches an application to dock.
 *
 * The list is a snapshot: HWNDs are only meaningful while their window exists,
 * so it is re-read every time this opens rather than cached in the store.
 */
export function EmbedPicker(): JSX.Element {
  const setModal = useStore((s) => s.setModal)
  const [candidates, setCandidates] = useState<EmbedCandidate[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  async function refresh(): Promise<void> {
    setLoading(true)
    const availability = await window.api.embed.available()
    if (!availability.ok) {
      setError(availability.error ?? 'Window embedding is not available on this machine.')
      setCandidates([])
      setLoading(false)
      return
    }
    setCandidates(await window.api.embed.list())
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.exe.toLowerCase().includes(q) ||
        c.className.toLowerCase().includes(q)
    )
  }, [candidates, query])

  async function dock(candidate: EmbedCandidate): Promise<void> {
    if (candidate.unsupported) {
      setError(candidate.unsupported)
      return
    }
    setBusy(true)
    const result = await window.api.embed.attach(candidate.hwnd)
    setBusy(false)
    if (!result.ok || !result.state) {
      setError(result.error ?? 'Could not dock that window.')
      return
    }
    openEmbedPanel(result.state.hwnd, candidate.title, candidate.exe)
    setModal(null)
  }

  async function launchAndDock(): Promise<void> {
    const exePath = await window.api.embed.pickExe()
    if (!exePath) return
    setBusy(true)
    setError(null)
    const hwnd = await window.api.embed.launch(exePath)
    if (hwnd === null) {
      setBusy(false)
      setError('Launched it, but no window appeared within 30 seconds.')
      void refresh()
      return
    }
    const result = await window.api.embed.attach(hwnd)
    setBusy(false)
    if (!result.ok || !result.state) {
      setError(result.error ?? 'Could not dock that window.')
      return
    }
    openEmbedPanel(result.state.hwnd, result.state.title || exePath, exePath)
    setModal(null)
  }

  return (
    <Modal title="Dock an application" wide onClose={() => setModal(null)}>
      <p className="embed-note">
        Pick a running window to pull it into a tab. It keeps running in its own process, and
        closing the tab hands it back to the desktop.
      </p>

      <div className="embed-toolbar">
        <input
          placeholder="Search windows…"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn--tiny" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        <button
          className="btn btn--tiny btn--primary"
          onClick={() => void launchAndDock()}
          disabled={busy}
        >
          Launch an app…
        </button>
      </div>

      {error && <div className="embed-error">{error}</div>}
      {busy && <div className="embed-note">Working…</div>}

      <div className="embed-list">
        {loading && <div className="embed-list-empty">Looking for windows…</div>}
        {!loading && filtered.length === 0 && (
          <div className="embed-list-empty">No windows match.</div>
        )}
        {filtered.map((candidate) => (
          <button
            key={candidate.hwnd}
            className={`embed-row${candidate.unsupported ? ' embed-row--off' : ''}`}
            onClick={() => void dock(candidate)}
            disabled={busy}
            title={candidate.unsupported ?? candidate.exe}
          >
            <span className="embed-row-app">{appName(candidate)}</span>
            <span className="embed-row-title">{candidate.title}</span>
            {candidate.unsupported && <span className="embed-row-warn">not dockable</span>}
          </button>
        ))}
      </div>
    </Modal>
  )
}

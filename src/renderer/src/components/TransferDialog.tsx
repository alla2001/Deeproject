import { useEffect, useState } from 'react'
import type { BundleSummary } from '@shared/types'
import { useStore } from '../state'
import { Field, Modal } from './ui'

function mb(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const value = bytes / 1024 / 1024
  return value < 1024 ? `${value.toFixed(0)} MB` : `${(value / 1024).toFixed(1)} GB`
}

export function TransferDialog(): JSX.Element {
  const close = useStore((s) => s.setModal)
  const init = useStore((s) => s.init)

  const [tab, setTab] = useState<'export' | 'import'>('export')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Export
  const [withConversations, setWithConversations] = useState(true)
  const [conversationBytes, setConversationBytes] = useState(0)

  // Import
  const [bundleDir, setBundleDir] = useState<string | null>(null)
  const [summary, setSummary] = useState<BundleSummary | null>(null)
  const [paths, setPaths] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'replace' | 'merge'>('replace')

  useEffect(() => {
    void window.api.transfer.estimate().then(setConversationBytes)
  }, [])

  async function runExport(): Promise<void> {
    const dir = await window.api.transfer.pickDir('export')
    if (!dir) return
    setBusy(true)
    setError(null)
    setNote(null)
    const result = await window.api.transfer.export(dir, withConversations)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Export failed.')
      return
    }
    setNote(
      `Wrote ${result.projects} project(s)${
        result.conversations ? ` and ${result.conversations} conversation set(s)` : ''
      } — ${mb(result.bytes ?? 0)}. Copy that folder to the other machine and import it there.`
    )
  }

  async function chooseBundle(): Promise<void> {
    const dir = await window.api.transfer.pickDir('import')
    if (!dir) return
    setBusy(true)
    setError(null)
    setNote(null)
    const probed = await window.api.transfer.probe(dir)
    setBusy(false)
    if (!probed.ok) {
      setError(probed.error ?? 'Could not read that bundle.')
      setSummary(null)
      return
    }
    setBundleDir(dir)
    setSummary(probed)
    setPaths(Object.fromEntries((probed.projects ?? []).map((p) => [p.projectId, p.resolvedPath])))
  }

  async function relocate(projectId: string): Promise<void> {
    const picked = await window.api.dialog.pickFolder()
    if (picked.length === 0) return
    setPaths((prev) => ({ ...prev, [projectId]: picked[0].path }))
  }

  async function runImport(): Promise<void> {
    if (!bundleDir || !summary) return
    const missing = (summary.projects ?? []).filter((p) => !paths[p.projectId])
    const confirmed = await window.api.dialog.confirm({
      title: mode === 'replace' ? 'Replace everything' : 'Merge bundle',
      message:
        mode === 'replace'
          ? 'Replace this machine’s projects, terminals, layout and ideas with the bundle?'
          : 'Add anything from the bundle that is not already here?',
      detail:
        (mode === 'replace'
          ? 'Your current setup is backed up to state.before-import-<time>.json in the app data folder first. '
          : '') +
        (missing.length > 0 ? `${missing.length} project folder(s) are still unresolved. ` : '') +
        'Claude conversations are merged in without overwriting any already on this machine.',
      confirmLabel: mode === 'replace' ? 'Replace' : 'Merge'
    })
    if (!confirmed) return

    setBusy(true)
    const result = await window.api.transfer.apply(bundleDir, mode, paths)
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Import failed.')
      return
    }
    // Pull the freshly written state back into the running app.
    await init()
    setNote(
      `Imported ${result.imported} project(s)${
        result.conversations ? ` and ${result.conversations} conversation set(s)` : ''
      }. Restart the app to rebuild the saved layout.`
    )
  }

  const unresolved = (summary?.projects ?? []).filter((p) => !p.exists && !paths[p.projectId])

  return (
    <Modal title="Move between computers" wide onClose={() => close(null)}>
      <div className="tabstrip">
        <button
          className={`tabstrip-btn${tab === 'export' ? ' tabstrip-btn--on' : ''}`}
          onClick={() => setTab('export')}
        >
          Export
        </button>
        <button
          className={`tabstrip-btn${tab === 'import' ? ' tabstrip-btn--on' : ''}`}
          onClick={() => setTab('import')}
        >
          Import
        </button>
      </div>

      {error && <div className="notion-error">{error}</div>}
      {note && <div className="notion-note">{note}</div>}

      {tab === 'export' ? (
        <>
          <p className="muted">
            Writes a bundle folder holding your projects, terminals, dock layout, presets, settings
            and ideas with their images. Copy it to the other machine — a cloud-synced folder works
            well, since only what changed gets re-uploaded.
          </p>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={withConversations}
              onChange={(e) => setWithConversations(e.target.checked)}
            />
            include Claude conversations ({mb(conversationBytes)})
          </label>

          <p className="muted">
            Without them the tabs still arrive intact, but <code>claude --resume</code> starts fresh
            over there — Claude keeps its history in <code>~/.claude</code>, not in Deeproject.
          </p>

          <div className="row">
            <button className="btn btn--primary" disabled={busy} onClick={() => void runExport()}>
              {busy ? 'Exporting…' : 'Export bundle…'}
            </button>
          </div>

          <p className="muted">
            <b>Not included:</b> your Notion, Discord and Roblox tokens. They are encrypted with this
            Windows account and cannot be read on another machine, so enter them again there. Claude
            Code’s own credentials are never touched.
          </p>
        </>
      ) : (
        <>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void chooseBundle()}>
              {bundleDir ? 'Choose a different bundle…' : 'Choose bundle folder…'}
            </button>
            {summary?.machine && (
              <span className="muted">
                from {summary.machine} ·{' '}
                {summary.exportedAt ? new Date(summary.exportedAt).toLocaleString() : ''}
              </span>
            )}
          </div>

          {summary?.counts && (
            <p className="muted">
              {summary.counts.projects} projects · {summary.counts.terminals} terminals ·{' '}
              {summary.counts.ideas} ideas · {summary.counts.images} images
            </p>
          )}

          {summary?.projects && summary.projects.length > 0 && (
            <>
              <h3 className="section">Where the projects live here</h3>
              <div className="relocate-list">
                {summary.projects.map((probe) => {
                  const chosen = paths[probe.projectId] ?? ''
                  const ok = Boolean(chosen)
                  return (
                    <div
                      className={`relocate${ok ? '' : ' relocate--missing'}`}
                      key={probe.projectId}
                    >
                      <div className="relocate-name">
                        {probe.name}
                        {probe.guessed && ok && <span className="relocate-tag">found</span>}
                        {!ok && <span className="relocate-tag relocate-tag--bad">not found</span>}
                      </div>
                      <div className="relocate-paths">
                        <span className="relocate-old" title={probe.originalPath}>
                          was {probe.originalPath}
                        </span>
                        <span className="relocate-new" title={chosen}>
                          {chosen || 'pick a folder…'}
                        </span>
                      </div>
                      <button
                        className="btn btn--tiny"
                        onClick={() => void relocate(probe.projectId)}
                      >
                        Locate…
                      </button>
                    </div>
                  )
                })}
              </div>
              {unresolved.length > 0 && (
                <p className="muted">
                  {unresolved.length} folder(s) could not be found. You can still import — those
                  projects keep their old path and their terminals will fall back to your home
                  folder until you point them somewhere real.
                </p>
              )}
            </>
          )}

          {summary && (
            <>
              <Field label="How to apply it">
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'replace' | 'merge')}
                >
                  <option value="replace">Replace everything (mirror the other machine)</option>
                  <option value="merge">Merge (only add what is missing here)</option>
                </select>
              </Field>

              <div className="row">
                <button className="btn btn--primary" disabled={busy} onClick={() => void runImport()}>
                  {busy ? 'Importing…' : mode === 'replace' ? 'Replace and import' : 'Merge in'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

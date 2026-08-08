import { useEffect, useMemo, useState } from 'react'
import type { RobloxUploadResult } from '@shared/types'
import { useStore } from '../state'
import { BackgroundPicker, ColorPicker, EmojiPicker, Field, Modal } from './ui'
import {
  openDiscordPanel,
  openNotionPanel,
  openRojoPanel,
  restartTerminal,
  startRojo,
  stopRojo
} from '../lib/actions'

type ProjectTab = 'look' | 'rojo' | 'roblox' | 'notion' | 'discord'

export function ProjectDialog({ projectId }: { projectId: string }): JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const allTerminals = useStore((s) => s.terminals)
  const terminals = useMemo(
    () => allTerminals.filter((t) => t.projectId === projectId),
    [allTerminals, projectId]
  )
  const update = useStore((s) => s.updateProject)
  const updateTerminal = useStore((s) => s.updateTerminal)
  const close = useStore((s) => s.setModal)
  const [tab, setTab] = useState<ProjectTab>('look')

  if (!project) return null

  /** Copy the project's look onto every terminal that belongs to it. */
  function applyToTerminals(): void {
    if (!project) return
    for (const t of terminals) {
      updateTerminal(t.id, {
        color: project.color,
        emoji: project.emoji,
        backgroundImage: project.backgroundImage,
        backgroundOpacity: project.backgroundOpacity,
        backgroundBlur: project.backgroundBlur
      })
    }
  }

  const tabs: { id: ProjectTab; label: string }[] = [
    { id: 'look', label: 'Look' },
    { id: 'rojo', label: 'Rojo' },
    { id: 'roblox', label: 'Roblox' },
    { id: 'notion', label: 'Tasks' },
    { id: 'discord', label: 'Reports' }
  ]

  return (
    <Modal title={project.name} onClose={() => close(null)} wide>
      <div className="tabstrip">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tabstrip-btn${tab === t.id ? ' tabstrip-btn--on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'look' && (
        <>
          <Field label="Name">
            <input
              value={project.name}
              onChange={(e) => update(project.id, { name: e.target.value })}
            />
          </Field>

          <Field label="Folder">
            <div className="row">
              <input value={project.path} readOnly className="mono" />
              <button className="btn" onClick={() => void window.api.sys.reveal(project.path)}>
                Reveal
              </button>
            </div>
          </Field>

          <Field label="Accent colour">
            <ColorPicker value={project.color} onChange={(color) => update(project.id, { color })} />
          </Field>

          <Field label="Emoji">
            <EmojiPicker value={project.emoji} onChange={(emoji) => update(project.id, { emoji })} />
          </Field>

          <Field label="Background image" hint="inherited by new terminals">
            <BackgroundPicker
              image={project.backgroundImage}
              opacity={project.backgroundOpacity}
              blur={project.backgroundBlur}
              onChange={(patch) => update(project.id, patch)}
            />
          </Field>

          <div className="row">
            <button className="btn" onClick={applyToTerminals} disabled={terminals.length === 0}>
              Apply look to {terminals.length} existing terminal(s)
            </button>
          </div>
        </>
      )}

      {tab === 'rojo' && <RojoSettings projectId={projectId} />}
      {tab === 'roblox' && <RobloxSettings projectId={projectId} />}
      {tab === 'notion' && <NotionSettings projectId={projectId} />}
      {tab === 'discord' && <DiscordSettings projectId={projectId} />}
    </Modal>
  )
}

function DiscordSettings({ projectId }: { projectId: string }): JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const tokenSet = useStore((s) => s.discordTokenSet)
  const updateDiscord = useStore((s) => s.updateDiscord)
  const setModal = useStore((s) => s.setModal)
  const [draft, setDraft] = useState(project?.discord.channel ?? '')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(project?.discord.channel ?? '')
  }, [project?.discord.channel])

  if (!project) return null

  async function link(): Promise<void> {
    const channel = draft.trim()
    if (!channel) {
      updateDiscord(projectId, { channel: null, channelName: null })
      setNote('Unlinked.')
      return
    }
    setBusy(true)
    const board = await window.api.discord.list(channel, false)
    setBusy(false)
    if (!board.ok) {
      setNote(board.error)
      return
    }
    updateDiscord(projectId, { channel, channelName: board.channelName })
    setNote(`Linked to ${board.channelName ?? 'the forum'} — ${board.posts.length} open post(s).`)
  }

  return (
    <>
      {!tokenSet && (
        <p className="muted">
          No Discord bot token yet.{' '}
          <button className="link-btn" onClick={() => setModal({ kind: 'settings' })}>
            Add one in Settings
          </button>{' '}
          first.
        </p>
      )}

      <Field label="Forum channel" hint="right-click the channel → Copy Link">
        <div className="row">
          <input
            className="mono"
            placeholder="https://discord.com/channels/…  or the channel id"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn btn--primary" disabled={busy || !tokenSet} onClick={() => void link()}>
            {busy ? 'Checking…' : 'Link'}
          </button>
        </div>
      </Field>

      <p className="muted">
        This must be a <b>forum</b> channel — the kind where each bug report is its own post. The
        bot needs View Channel and Read Message History on it, plus Manage Threads if you want to
        retag or close posts from Deeproject.
      </p>

      {note && <p className="muted">{note}</p>}

      {project.discord.channel && (
        <div className="row">
          <button className="btn" onClick={() => openDiscordPanel(projectId)}>
            Open reports
          </button>
          <button
            className="btn"
            onClick={() => {
              updateDiscord(projectId, { channel: null, channelName: null })
              setDraft('')
              setNote('Unlinked.')
            }}
          >
            Unlink
          </button>
        </div>
      )}
    </>
  )
}

function RojoSettings({ projectId }: { projectId: string }): JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const projects = useStore((s) => s.projects)
  const defaultBinary = useStore((s) => s.settings.rojoBinary)
  const state = useStore((s) => s.rojoStates[projectId])
  const updateRojo = useStore((s) => s.updateRojo)
  const [candidates, setCandidates] = useState<string[]>([])
  const [portNote, setPortNote] = useState<string | null>(null)

  useEffect(() => {
    if (project) void window.api.rojo.projectFiles(project.path).then(setCandidates)
  }, [project?.path])

  if (!project) return null

  const clash = projects.find((p) => p.id !== projectId && p.rojo.port === project.rojo.port)

  return (
    <>
      <Field label="Project file" hint="*.project.json in this folder">
        <div className="row">
          <select
            value={project.rojo.projectFile ?? ''}
            onChange={(e) => updateRojo(projectId, { projectFile: e.target.value || null })}
          >
            <option value="">
              {candidates.length > 0 ? `Auto (${candidates[0]})` : 'Auto — none found'}
            </option>
            {candidates.map((file) => (
              <option key={file} value={file}>
                {file}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => void window.api.rojo.projectFiles(project.path).then(setCandidates)}
          >
            Rescan
          </button>
        </div>
      </Field>

      <Field label="Port" hint={clash ? `also used by ${clash.name}` : undefined}>
        <div className="row">
          <input
            type="number"
            min={1024}
            max={65535}
            value={project.rojo.port}
            onChange={(e) => updateRojo(projectId, { port: Number(e.target.value) || 34872 })}
          />
          <button
            className="btn"
            onClick={async () => {
              const free = await window.api.rojo.portFree(project.rojo.port)
              setPortNote(free ? 'Port is free.' : 'Something is already listening on that port.')
              window.setTimeout(() => setPortNote(null), 4000)
            }}
          >
            Test
          </button>
        </div>
      </Field>
      {portNote && <p className="muted">{portNote}</p>}

      <Field label="Rojo executable" hint={`blank uses "${defaultBinary}"`}>
        <input
          className="mono"
          placeholder={defaultBinary}
          value={project.rojo.binary ?? ''}
          onChange={(e) => updateRojo(projectId, { binary: e.target.value || null })}
        />
      </Field>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={project.rojo.autoStart}
          onChange={(e) => updateRojo(projectId, { autoStart: e.target.checked })}
        />
        start this server when Deeproject launches
      </label>

      <div className="row">
        <button className="btn btn--primary" onClick={() => void startRojo(projectId)}>
          Start server
        </button>
        <button className="btn" onClick={() => void stopRojo(projectId)}>
          Stop
        </button>
        <button className="btn" onClick={() => openRojoPanel(projectId)}>
          Show output
        </button>
      </div>

      {state && (
        <p className="muted">
          Status: {state.status}
          {state.pid ? ` · pid ${state.pid}` : ''}
          {state.message ? ` · ${state.message}` : ''}
        </p>
      )}
    </>
  )
}

function RobloxSettings({ projectId }: { projectId: string }): JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const updateRoblox = useStore((s) => s.updateRoblox)
  const [places, setPlaces] = useState<string[]>([])
  const [studio, setStudio] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (project) void window.api.roblox.placeFiles(project.path).then(setPlaces)
  }, [project?.path])

  useEffect(() => {
    void window.api.roblox.studioPath().then(setStudio)
  }, [])

  if (!project) return null

  const usingCloud = Boolean(project.roblox.placeId?.trim())

  async function lookup(): Promise<void> {
    const placeId = project?.roblox.placeId?.trim()
    if (!placeId) return
    setBusy(true)
    const universeId = await window.api.roblox.lookupUniverse(placeId)
    setBusy(false)
    if (universeId === null) {
      setNote(
        `Roblox does not return a universe for place ${placeId}. That happens when the place is ` +
          'private, unpublished or deleted — open it on the Roblox site and paste the experience ' +
          'ID below by hand.'
      )
      return
    }
    updateRoblox(projectId, { universeId: String(universeId) })
    setNote(`Found universe ${universeId}.`)
  }

  async function open(): Promise<void> {
    if (!project) return
    setBusy(true)
    const result = await window.api.roblox.open(project.path, project.roblox, project.id)
    setBusy(false)
    if (result.ok) {
      // Cache whatever the launch had to resolve so the next one is instant.
      if (result.universeId) updateRoblox(projectId, { universeId: String(result.universeId) })
      if (result.placeName) updateRoblox(projectId, { placeName: result.placeName })
      setNote(result.focused ? 'Studio was already open — brought to the front.' : 'Launching Roblox Studio…')
      return
    }
    setNote(result.error ?? 'Could not open Roblox Studio.')
  }

  return (
    <>
      <p className="muted">
        Link a local place file, or a cloud place by ID. A place ID takes priority. Studio needs the
        universe that owns the place as well — Deeproject looks it up automatically for published
        places.
      </p>

      <Field label="Place file" hint=".rbxl / .rbxlx in this folder">
        <div className="row">
          <select
            value={project.roblox.placeFile ?? ''}
            onChange={(e) => updateRoblox(projectId, { placeFile: e.target.value || null })}
            disabled={usingCloud}
          >
            <option value="">None</option>
            {places.map((file) => (
              <option key={file} value={file}>
                {file}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => void window.api.roblox.placeFiles(project.path).then(setPlaces)}
          >
            Rescan
          </button>
        </div>
      </Field>

      <Field label="Place ID" hint="the number in the Roblox website URL">
        <div className="row">
          <input
            className="mono"
            inputMode="numeric"
            placeholder="e.g. 1818"
            value={project.roblox.placeId ?? ''}
            onChange={(e) => updateRoblox(projectId, { placeId: e.target.value.trim() || null })}
          />
          <button
            className="btn"
            disabled={busy || !project.roblox.placeId?.trim()}
            onClick={() => void lookup()}
          >
            {busy ? 'Looking up…' : 'Find universe'}
          </button>
        </div>
      </Field>

      <Field label="Universe ID" hint="required by Studio; looked up automatically">
        <input
          className="mono"
          inputMode="numeric"
          placeholder="resolved on launch when the place is public"
          value={project.roblox.universeId ?? ''}
          onChange={(e) => updateRoblox(projectId, { universeId: e.target.value.trim() || null })}
        />
      </Field>

      {note && <p className="muted">{note}</p>}

      <div className="row">
        <button className="btn btn--primary" disabled={busy} onClick={() => void open()}>
          🎮 Open in Roblox Studio
        </button>
      </div>

      <p className="muted">
        {studio ? `Studio: ${studio}` : 'Roblox Studio was not found in the usual install folders.'}
      </p>

      <hr className="rule" />
      <h3 className="section">Asset uploads</h3>
      <AssetUploader projectId={projectId} />
    </>
  )
}

/** Uploads files from this project to Roblox and reports the asset ids back. */
function AssetUploader({ projectId }: { projectId: string }): JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const keySet = useStore((s) => s.robloxKeySet)
  const updateRoblox = useStore((s) => s.updateRoblox)
  const setModal = useStore((s) => s.setModal)
  const [results, setResults] = useState<RobloxUploadResult[]>([])
  const [busy, setBusy] = useState(false)

  if (!project) return null
  const creatorId = project.roblox.creatorId?.trim() ?? ''

  async function upload(files: string[]): Promise<void> {
    if (!project || files.length === 0) return
    setBusy(true)
    setResults([])
    // Sequential: Roblox rate limits asset creation, and per-file feedback is
    // more useful than one combined failure.
    for (const filePath of files) {
      const result = await window.api.roblox.upload({
        filePath,
        creator: { type: project.roblox.creatorType, id: creatorId }
      })
      setResults((prev) => [...prev, result])
    }
    setBusy(false)
  }

  return (
    <>
      {!keySet && (
        <p className="muted">
          No Roblox API key yet.{' '}
          <button className="link-btn" onClick={() => setModal({ kind: 'settings' })}>
            Add one in Settings
          </button>{' '}
          first.
        </p>
      )}

      <Field label="Assets are owned by" hint="uploads are created under this account">
        <div className="row">
          <select
            value={project.roblox.creatorType}
            onChange={(e) =>
              updateRoblox(projectId, { creatorType: e.target.value as 'user' | 'group' })
            }
          >
            <option value="user">My user</option>
            <option value="group">A group</option>
          </select>
          <input
            className="mono"
            inputMode="numeric"
            placeholder={project.roblox.creatorType === 'group' ? 'group id' : 'your user id'}
            value={creatorId}
            onChange={(e) => updateRoblox(projectId, { creatorId: e.target.value.trim() || null })}
          />
        </div>
      </Field>

      <div className="row">
        <button
          className="btn btn--primary"
          disabled={busy || !keySet || !creatorId}
          onClick={async () => {
            const files = await window.api.roblox.pickAssets()
            void upload(files)
          }}
        >
          {busy ? 'Uploading…' : '⬆ Upload assets…'}
        </button>
        {results.length > 0 && (
          <button className="btn" onClick={() => setResults([])}>
            Clear
          </button>
        )}
      </div>

      {results.length > 0 && (
        <div className="upload-results">
          {results.map((result, i) => (
            <div key={i} className={`upload-row${result.ok ? '' : ' upload-row--bad'}`}>
              <span className="upload-file">{result.file}</span>
              {result.ok ? (
                <>
                  <span className="upload-id mono">rbxassetid://{result.assetId}</span>
                  <button
                    className="btn btn--tiny"
                    onClick={() =>
                      void window.api.sys.writeClipboard(`rbxassetid://${result.assetId}`)
                    }
                  >
                    Copy
                  </button>
                </>
              ) : (
                <span className="upload-error">{result.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="muted">
        Images upload as Decals, audio as Audio, meshes as Models. Roblox moderates every upload, so
        an id can take a few seconds — and audio in particular is often held for review.
      </p>
    </>
  )
}

function NotionSettings({ projectId }: { projectId: string }): JSX.Element | null {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const tokenSet = useStore((s) => s.notionTokenSet)
  const updateNotion = useStore((s) => s.updateNotion)
  const setModal = useStore((s) => s.setModal)
  const [draft, setDraft] = useState(project?.notion.target ?? '')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(project?.notion.target ?? '')
  }, [project?.notion.target])

  if (!project) return null

  async function link(): Promise<void> {
    const target = draft.trim()
    if (!target) {
      updateNotion(projectId, { target: null, kind: null })
      setNote('Unlinked.')
      return
    }
    setBusy(true)
    const result = await window.api.notion.resolve(target)
    setBusy(false)
    if (!result.ok) {
      setNote(result.error)
      return
    }
    updateNotion(projectId, { target, kind: result.kind })
    setNote(`Linked to a Notion ${result.kind}.`)
  }

  return (
    <>
      {!tokenSet && (
        <p className="muted">
          No Notion token yet.{' '}
          <button className="link-btn" onClick={() => setModal({ kind: 'settings' })}>
            Add one in Settings
          </button>{' '}
          first.
        </p>
      )}

      <Field label="Notion database or page" hint="paste the share link">
        <div className="row">
          <input
            className="mono"
            placeholder="https://www.notion.so/…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn btn--primary" disabled={busy || !tokenSet} onClick={() => void link()}>
            {busy ? 'Checking…' : 'Link'}
          </button>
        </div>
      </Field>

      <p className="muted">
        Remember to share the page with your integration inside Notion (••• → Connections), or the
        API cannot see it.
      </p>

      {note && <p className="muted">{note}</p>}

      {project.notion.target && (
        <div className="row">
          <button className="btn" onClick={() => openNotionPanel(projectId)}>
            Open task board
          </button>
          <button
            className="btn"
            onClick={() => {
              updateNotion(projectId, { target: null, kind: null })
              setDraft('')
              setNote('Unlinked.')
            }}
          >
            Unlink
          </button>
        </div>
      )}
    </>
  )
}

export function TerminalDialog({ terminalId }: { terminalId: string }): JSX.Element | null {
  const term = useStore((s) => s.terminals.find((t) => t.id === terminalId))
  const shells = useStore((s) => s.shells)
  const presets = useStore((s) => s.presets)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateTerminal)
  const close = useStore((s) => s.setModal)

  if (!term) return null

  return (
    <Modal
      title="Terminal"
      onClose={() => close(null)}
      footer={
        <button className="btn btn--primary" onClick={() => void restartTerminal(term.id)}>
          Restart with these settings
        </button>
      }
    >
      <Field label="Title">
        <div className="row">
          <input value={term.title} onChange={(e) => update(term.id, { title: e.target.value })} />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={term.autoTitle}
              onChange={(e) => update(term.id, { autoTitle: e.target.checked })}
            />
            follow shell
          </label>
        </div>
      </Field>

      <Field label="Command" hint="runs on start; the shell stays open afterwards">
        <input
          className="mono"
          placeholder="e.g. claude --resume"
          value={term.command ?? ''}
          onChange={(e) => update(term.id, { command: e.target.value || null })}
        />
      </Field>

      <Field label="Quick fill">
        <div className="chips">
          {presets.map((p) => (
            <button
              key={p.id}
              className="chip"
              onClick={() =>
                update(term.id, { command: p.command, presetId: p.id, emoji: p.emoji })
              }
            >
              {p.emoji} {p.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Working directory">
        <input className="mono" value={term.cwd} onChange={(e) => update(term.id, { cwd: e.target.value })} />
      </Field>

      <Field label="Shell">
        <select
          value={term.shellId ?? ''}
          onChange={(e) => update(term.id, { shellId: e.target.value || null })}
        >
          <option value="">Default ({shells[0]?.label ?? 'system'})</option>
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.icon} {s.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Accent colour">
        <ColorPicker value={term.color} onChange={(color) => update(term.id, { color })} />
      </Field>

      <Field label="Emoji">
        <EmojiPicker value={term.emoji} onChange={(emoji) => update(term.id, { emoji })} />
      </Field>

      <Field label="Font size" hint={term.fontSize ? `${term.fontSize}px` : `inherit (${settings.fontSize}px)`}>
        <div className="row">
          <input
            type="range"
            min={8}
            max={28}
            step={1}
            value={term.fontSize ?? settings.fontSize}
            onChange={(e) => update(term.id, { fontSize: Number(e.target.value) })}
          />
          <button className="btn" onClick={() => update(term.id, { fontSize: null })}>
            Reset
          </button>
        </div>
      </Field>

      <Field label="Background image">
        <BackgroundPicker
          image={term.backgroundImage}
          opacity={term.backgroundOpacity}
          blur={term.backgroundBlur}
          onChange={(patch) => update(term.id, patch)}
        />
      </Field>
    </Modal>
  )
}

export function SettingsDialog(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const shells = useStore((s) => s.shells)
  const update = useStore((s) => s.updateSettings)
  const close = useStore((s) => s.setModal)

  return (
    <Modal title="Settings" onClose={() => close(null)}>
      <Field label="Font family">
        <input
          className="mono"
          value={settings.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
        />
      </Field>

      <Field label="Font size" hint={`${settings.fontSize}px`}>
        <input
          type="range"
          min={8}
          max={28}
          value={settings.fontSize}
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
        />
      </Field>

      <Field label="Line height" hint={settings.lineHeight.toFixed(2)}>
        <input
          type="range"
          min={1}
          max={2}
          step={0.05}
          value={settings.lineHeight}
          onChange={(e) => update({ lineHeight: Number(e.target.value) })}
        />
      </Field>

      <Field label="Cursor">
        <div className="row">
          <select
            value={settings.cursorStyle}
            onChange={(e) => update({ cursorStyle: e.target.value as typeof settings.cursorStyle })}
          >
            <option value="bar">Bar</option>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
          </select>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.cursorBlink}
              onChange={(e) => update({ cursorBlink: e.target.checked })}
            />
            blink
          </label>
        </div>
      </Field>

      <Field label="Scrollback" hint={`${settings.scrollback} lines`}>
        <input
          type="range"
          min={1000}
          max={100000}
          step={1000}
          value={settings.scrollback}
          onChange={(e) => update({ scrollback: Number(e.target.value) })}
        />
      </Field>

      <Field label="Default shell">
        <select
          value={settings.defaultShellId ?? ''}
          onChange={(e) => update({ defaultShellId: e.target.value || null })}
        >
          <option value="">Auto ({shells[0]?.label ?? 'system'})</option>
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.icon} {s.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Editor command" hint="used by “Open in editor”">
        <input
          className="mono"
          value={settings.editorCommand}
          onChange={(e) => update({ editorCommand: e.target.value })}
        />
      </Field>

      <Field label="Mouse">
        <div className="col">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.copyOnSelect}
              onChange={(e) => update({ copyOnSelect: e.target.checked })}
            />
            copy on select
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.rightClickPaste}
              onChange={(e) => update({ rightClickPaste: e.target.checked })}
            />
            right click pastes (or copies a selection)
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.confirmOnCloseRunning}
              onChange={(e) => update({ confirmOnCloseRunning: e.target.checked })}
            />
            confirm before closing a running terminal
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.autoStartTerminals}
              onChange={(e) => update({ autoStartTerminals: e.target.checked })}
            />
            relaunch saved terminals when the app starts
          </label>
        </div>
      </Field>

      <hr className="rule" />
      <h3 className="section">Code editor</h3>

      <Field label="Editor font size" hint={`${settings.editorFontSize}px`}>
        <input
          type="range"
          min={9}
          max={24}
          value={settings.editorFontSize}
          onChange={(e) => update({ editorFontSize: Number(e.target.value) }, false)}
          onMouseUp={() => update({}, true)}
        />
      </Field>

      <Field label="Tab size" hint={`${settings.editorTabSize} spaces`}>
        <input
          type="range"
          min={2}
          max={8}
          step={1}
          value={settings.editorTabSize}
          onChange={(e) => update({ editorTabSize: Number(e.target.value) }, false)}
          onMouseUp={() => update({}, true)}
        />
      </Field>

      <div className="col">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.editorWordWrap}
            onChange={(e) => update({ editorWordWrap: e.target.checked })}
          />
          word wrap
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.editorMinimap}
            onChange={(e) => update({ editorMinimap: e.target.checked })}
          />
          show minimap
        </label>
      </div>

      <hr className="rule" />
      <h3 className="section">Rojo</h3>

      <Field label="Rojo executable" hint="used when a project doesn't override it">
        <input
          className="mono"
          value={settings.rojoBinary}
          onChange={(e) => update({ rojoBinary: e.target.value })}
        />
      </Field>

      <Field label="Base port" hint="new projects get the next free port from here">
        <input
          type="number"
          min={1024}
          max={65535}
          value={settings.rojoBasePort}
          onChange={(e) => update({ rojoBasePort: Number(e.target.value) || 34872 })}
        />
      </Field>

      <hr className="rule" />
      <h3 className="section">Resource monitor</h3>

      <Field
        label="Sample interval"
        hint={settings.statsIntervalMs === 0 ? 'off' : `${(settings.statsIntervalMs / 1000).toFixed(1)}s`}
      >
        <input
          type="range"
          min={0}
          max={10000}
          step={500}
          value={settings.statsIntervalMs}
          onChange={(e) => update({ statsIntervalMs: Number(e.target.value) }, false)}
          onMouseUp={() => update({}, true)}
        />
      </Field>
      <p className="muted">
        Slide to 0 to stop sampling entirely. Each sample walks the process tree of every running
        terminal.
      </p>

      <hr className="rule" />
      <h3 className="section">Attention</h3>

      <Field
        label="Flag a terminal after"
        hint={
          settings.attentionIdleMs === 0 ? 'off' : `${(settings.attentionIdleMs / 1000).toFixed(1)}s`
        }
      >
        <input
          type="range"
          min={0}
          max={30000}
          step={1000}
          value={settings.attentionIdleMs}
          onChange={(e) => update({ attentionIdleMs: Number(e.target.value) }, false)}
          onMouseUp={() => update({}, true)}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.attentionNotify}
          disabled={settings.attentionIdleMs === 0}
          onChange={(e) => update({ attentionNotify: e.target.checked }, true)}
        />
        also show a Windows notification
      </label>
      <p className="muted">
        A running terminal that goes quiet for this long — with nothing left in its process tree —
        is marked in the sidebar as wanting you, as is one that rings the bell or exits. Claude
        rings when it stops to ask a question. The mark clears when you open that terminal. Slide to
        0 to switch it off; raise it if sessions that are only thinking get flagged.
      </p>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.runInBackground}
          onChange={(e) => update({ runInBackground: e.target.checked }, true)}
        />
        keep running when the window is closed
      </label>
      <p className="muted">
        Terminals are child processes of Deeproject, so quitting ends every one of them. With this
        on, the close button puts the app in the notification area instead: sessions carry on and
        can still tell you when they finish. Quit for real from the tray icon&rsquo;s menu. Turn it
        off and the close button ends everything, as it used to.
      </p>

      <hr className="rule" />
      <h3 className="section">Notion</h3>
      <NotionTokenField />

      <hr className="rule" />
      <h3 className="section">Discord</h3>
      <DiscordTokenField />

      <hr className="rule" />
      <h3 className="section">Roblox</h3>
      <RobloxKeyField />

      <hr className="rule" />
      <h3 className="section">Appearance</h3>

      <Field label="Default background" hint="used by terminals with no image of their own">
        <BackgroundPicker
          image={settings.defaultBackgroundImage}
          opacity={settings.defaultBackgroundOpacity}
          blur={settings.defaultBackgroundBlur}
          onChange={(patch) =>
            update({
              defaultBackgroundImage:
                patch.backgroundImage !== undefined
                  ? patch.backgroundImage
                  : settings.defaultBackgroundImage,
              defaultBackgroundOpacity: patch.backgroundOpacity ?? settings.defaultBackgroundOpacity,
              defaultBackgroundBlur: patch.backgroundBlur ?? settings.defaultBackgroundBlur
            })
          }
        />
      </Field>
    </Modal>
  )
}

function NotionTokenField(): JSX.Element {
  const tokenSet = useStore((s) => s.notionTokenSet)
  const setTokenSet = useStore((s) => s.setNotionTokenSet)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    const token = draft.trim()
    if (!token) return
    setBusy(true)
    await window.api.notion.setToken(token)
    const result = await window.api.notion.verify()
    setBusy(false)
    setTokenSet(result.ok)
    setDraft('')
    setNote(result.ok ? `Connected as ${result.user}.` : (result.error ?? 'Could not verify.'))
  }

  return (
    <>
      <Field
        label="Internal integration token"
        hint={tokenSet ? 'a token is saved' : 'not set'}
      >
        <div className="row">
          <input
            type="password"
            className="mono"
            placeholder={tokenSet ? '•••••••••• (replace)' : 'ntn_… or secret_…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
          <button className="btn btn--primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
            {busy ? 'Checking…' : 'Save'}
          </button>
        </div>
      </Field>

      <div className="row">
        <button
          className="btn"
          disabled={busy || !tokenSet}
          onClick={async () => {
            setBusy(true)
            const result = await window.api.notion.verify()
            setBusy(false)
            setNote(result.ok ? `Connected as ${result.user}.` : (result.error ?? 'Failed.'))
          }}
        >
          Test connection
        </button>
        <button
          className="btn"
          disabled={!tokenSet}
          onClick={async () => {
            await window.api.notion.setToken(null)
            setTokenSet(false)
            setNote('Token removed.')
          }}
        >
          Remove token
        </button>
      </div>

      {note && <p className="muted">{note}</p>}
      <p className="muted">
        Create one at notion.so/my-integrations, then share each page or database with it from the
        ••• → Connections menu. The token is encrypted with your Windows account key.
      </p>
    </>
  )
}

function DiscordTokenField(): JSX.Element {
  const tokenSet = useStore((s) => s.discordTokenSet)
  const setTokenSet = useStore((s) => s.setDiscordTokenSet)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    const token = draft.trim()
    if (!token) return
    setBusy(true)
    await window.api.discord.setToken(token)
    const result = await window.api.discord.verify()
    setBusy(false)
    setTokenSet(result.ok)
    setDraft('')
    setNote(result.ok ? `Connected as ${result.user}.` : (result.error ?? 'Could not verify.'))
  }

  return (
    <>
      <Field label="Bot token" hint={tokenSet ? 'a token is saved' : 'not set'}>
        <div className="row">
          <input
            type="password"
            className="mono"
            placeholder={tokenSet ? '•••••••••• (replace)' : 'bot token'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
          <button
            className="btn btn--primary"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Checking…' : 'Save'}
          </button>
        </div>
      </Field>

      <div className="row">
        <button
          className="btn"
          disabled={busy || !tokenSet}
          onClick={async () => {
            setBusy(true)
            const result = await window.api.discord.verify()
            setBusy(false)
            setNote(result.ok ? `Connected as ${result.user}.` : (result.error ?? 'Failed.'))
          }}
        >
          Test connection
        </button>
        <button
          className="btn"
          disabled={!tokenSet}
          onClick={async () => {
            await window.api.discord.setToken(null)
            setTokenSet(false)
            setNote('Token removed.')
          }}
        >
          Remove token
        </button>
      </div>

      {note && <p className="muted">{note}</p>}

      <ol className="setup-steps">
        <li>
          Create an app at <b>discord.com/developers/applications</b> → New Application, then open
          the <b>Bot</b> tab and Reset Token to copy one.
        </li>
        <li>
          On that same Bot tab, switch on <b>Message Content Intent</b> under Privileged Gateway
          Intents. Without it Discord strips the text out of every post.
        </li>
        <li>
          Invite it with the link below, choosing the server with your bug forum.{' '}
          <button
            className="link-btn"
            onClick={() => {
              const url =
                'https://discord.com/developers/applications'
              window.open(url, '_blank')
            }}
          >
            Open the developer portal
          </button>
        </li>
        <li>Paste the token above and hit Save, then link a forum in a project’s Reports tab.</li>
      </ol>

      <Field label="Invite link" hint="fill in your application id">
        <input
          className="mono"
          readOnly
          value={INVITE_URL}
          onFocus={(e) => e.currentTarget.select()}
        />
      </Field>

      <p className="muted">
        Those permissions are View Channel, Read Message History and Manage Threads — read the
        forum, and retag or close posts. Discord has no read-only API for guild content and a
        personal account token breaks their terms, so a bot is the supported route. The token is
        encrypted with your Windows account key.
      </p>
    </>
  )
}

/**
 * View Channel (1<<10) + Read Message History (1<<16) + Manage Threads (1<<34).
 */
const INVITE_URL =
  'https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=17179935744'

function RobloxKeyField(): JSX.Element {
  const keySet = useStore((s) => s.robloxKeySet)
  const setKeySet = useStore((s) => s.setRobloxKeySet)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    const key = draft.trim()
    if (!key) return
    setBusy(true)
    await window.api.roblox.setApiKey(key)
    const result = await window.api.roblox.verifyApiKey()
    setBusy(false)
    setKeySet(result.ok)
    setDraft('')
    setNote(result.ok ? 'Key accepted.' : (result.error ?? 'Could not verify.'))
  }

  return (
    <>
      <Field label="Open Cloud API key" hint={keySet ? 'a key is saved' : 'not set'}>
        <div className="row">
          <input
            type="password"
            className="mono"
            placeholder={keySet ? '•••••••••• (replace)' : 'Open Cloud API key'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
          <button
            className="btn btn--primary"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Checking…' : 'Save'}
          </button>
        </div>
      </Field>

      <div className="row">
        <button
          className="btn"
          disabled={busy || !keySet}
          onClick={async () => {
            setBusy(true)
            const result = await window.api.roblox.verifyApiKey()
            setBusy(false)
            setNote(result.ok ? 'Key accepted.' : (result.error ?? 'Failed.'))
          }}
        >
          Test key
        </button>
        <button
          className="btn"
          disabled={!keySet}
          onClick={async () => {
            await window.api.roblox.setApiKey(null)
            setKeySet(false)
            setNote('Key removed.')
          }}
        >
          Remove key
        </button>
      </div>

      {note && <p className="muted">{note}</p>}

      <ol className="setup-steps">
        <li>
          Open <b>create.roblox.com/dashboard/credentials</b> → Create API Key.
        </li>
        <li>
          Add the <b>Assets</b> API system, pick your user (or group) under it, and tick{' '}
          <b>write</b> — plus <b>read</b> so uploads can be polled.
        </li>
        <li>
          Under Security, add <b>0.0.0.0/0</b> to accepted IPs unless you have a fixed address, set
          an expiry, then save and copy the key.
        </li>
        <li>Paste it above, then set each project’s creator id in its Roblox tab.</li>
      </ol>

      <p className="muted">
        This uploads real, publicly-owned assets to your account and cannot be undone from here —
        uploads are moderated by Roblox and count against your limits. The key is encrypted with
        your Windows account key.
      </p>
    </>
  )
}

export function PresetsDialog(): JSX.Element {
  const presets = useStore((s) => s.presets)
  const update = useStore((s) => s.updatePreset)
  const add = useStore((s) => s.addPreset)
  const remove = useStore((s) => s.removePreset)
  const close = useStore((s) => s.setModal)

  return (
    <Modal
      title="Launch presets"
      wide
      onClose={() => close(null)}
      footer={
        <button className="btn btn--primary" onClick={() => add()}>
          Add preset
        </button>
      }
    >
      <p className="muted">
        Pinned presets appear as one-click buttons on every project row in the sidebar.
      </p>
      <div className="preset-list">
        {presets.map((p) => (
          <div className="preset" key={p.id} style={{ ['--accent' as string]: p.color ?? '#7c8cff' }}>
            <input
              className="preset-emoji"
              value={p.emoji}
              maxLength={4}
              onChange={(e) => update(p.id, { emoji: e.target.value })}
            />
            <input
              className="preset-label"
              value={p.label}
              onChange={(e) => update(p.id, { label: e.target.value })}
            />
            <input
              className="preset-cmd mono"
              placeholder="(plain shell)"
              value={p.command ?? ''}
              onChange={(e) => update(p.id, { command: e.target.value || null })}
            />
            <input
              type="color"
              className="preset-color"
              value={p.color ?? '#7c8cff'}
              onChange={(e) => update(p.id, { color: e.target.value })}
            />
            <label className="checkbox" title="Show on project rows">
              <input
                type="checkbox"
                checked={p.pinned}
                onChange={(e) => update(p.id, { pinned: e.target.checked })}
              />
              pin
            </label>
            <button
              className="icon-btn"
              disabled={p.builtin}
              title={p.builtin ? 'Built-in presets cannot be deleted' : 'Delete preset'}
              onClick={() => remove(p.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

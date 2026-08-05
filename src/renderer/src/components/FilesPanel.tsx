import { useCallback, useEffect, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { FileEntry } from '@shared/types'
import { useStore } from '../state'
import { useMenu } from './ContextMenu'
import { openEditor } from '../lib/actions'

export interface FilesPanelParams extends Record<string, unknown> {
  projectId: string
}

const ICONS: Record<string, string> = {
  ts: '🟦',
  tsx: '🟦',
  js: '🟨',
  jsx: '🟨',
  json: '🟧',
  lua: '🌙',
  luau: '🌙',
  md: '📝',
  rs: '🦀',
  py: '🐍',
  toml: '⚙️',
  yml: '⚙️',
  yaml: '⚙️',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  svg: '🖼️',
  rbxl: '🎮',
  rbxlx: '🎮'
}

function iconFor(entry: FileEntry): string {
  if (entry.isDirectory) return '📁'
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
  return ICONS[ext] ?? '📄'
}

function Node({
  entry,
  root,
  projectId,
  depth
}: {
  entry: FileEntry
  root: string
  projectId: string
  depth: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const openMenu = useMenu((s) => s.open)

  const load = useCallback(async () => {
    setLoading(true)
    const list = await window.api.fs.list(root, entry.path)
    setChildren(list)
    setLoading(false)
  }, [root, entry.path])

  async function toggle(): Promise<void> {
    if (!open && children === null) await load()
    setOpen((v) => !v)
  }

  return (
    <>
      <div
        className="file-row"
        style={{ paddingLeft: 6 + depth * 12 }}
        title={entry.path}
        onClick={() => {
          if (entry.isDirectory) void toggle()
          else openEditor(projectId, root, entry.path)
        }}
        onContextMenu={(e) =>
          openMenu(e, [
            ...(entry.isDirectory
              ? []
              : [
                  {
                    label: 'Open in editor',
                    onClick: () => openEditor(projectId, root, entry.path)
                  }
                ]),
            { label: 'Reveal in Explorer', onClick: () => void window.api.sys.reveal(entry.path) },
            ...(entry.isDirectory && open
              ? [{ label: 'Refresh', onClick: () => void load() }]
              : [])
          ])
        }
      >
        {entry.isDirectory ? (
          <span className={`chevron${open ? ' chevron--open' : ''}`}>▸</span>
        ) : (
          <span className="chevron chevron--leaf" />
        )}
        <span className="file-icon">{iconFor(entry)}</span>
        <span className="file-name">{entry.name}</span>
      </div>
      {open && loading && (
        <div className="file-row file-row--muted" style={{ paddingLeft: 18 + depth * 12 }}>
          loading…
        </div>
      )}
      {open &&
        children?.map((child) => (
          <Node key={child.path} entry={child} root={root} projectId={projectId} depth={depth + 1} />
        ))}
      {open && children?.length === 0 && (
        <div className="file-row file-row--muted" style={{ paddingLeft: 18 + depth * 12 }}>
          empty
        </div>
      )}
    </>
  )
}

export function FilesPanel(props: IDockviewPanelProps<FilesPanelParams>): JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === props.params.projectId))
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    if (!project) return
    setEntries(await window.api.fs.list(project.path, project.path))
  }, [project?.path])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (project) props.api.setTitle(`${project.emoji} files`)
  }, [project?.emoji, project?.name, props.api])

  if (!project) return <div className="files-panel">This project no longer exists.</div>

  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? (entries ?? []).filter((e) => e.name.toLowerCase().includes(needle))
    : (entries ?? [])

  return (
    <div className="files-panel" style={{ ['--accent' as string]: project.color }}>
      <div className="files-head">
        <input
          className="search"
          placeholder="Filter this folder…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()}>
          ⟳
        </button>
      </div>
      <div className="files-tree">
        {entries === null && <div className="file-row file-row--muted">loading…</div>}
        {visible.map((entry) => (
          <Node
            key={entry.path}
            entry={entry}
            root={project.path}
            projectId={project.id}
            depth={0}
          />
        ))}
        {entries !== null && visible.length === 0 && (
          <div className="file-row file-row--muted">nothing here</div>
        )}
      </div>
    </div>
  )
}

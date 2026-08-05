import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { NotionBoard, NotionField, NotionTask, NotionTaskPatch } from '@shared/types'
import { useStore } from '../state'
import { useMenu, type MenuItem } from './ContextMenu'

export interface NotionPanelParams extends Record<string, unknown> {
  projectId: string
}

/** Notion's option palette, matched to the app's darker surfaces. */
const COLORS: Record<string, string> = {
  default: '#8b94a7',
  gray: '#8b94a7',
  brown: '#b08968',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#38bdf8',
  purple: '#a78bfa',
  pink: '#f472b6',
  red: '#f43f5e'
}

function colorFor(field: NotionField | undefined, value: string): string {
  const option = field?.options.find((o) => o.name === value)
  return COLORS[option?.color ?? 'default'] ?? COLORS.default
}

function Badge({
  field,
  values,
  onChange
}: {
  field: NotionField
  values: string[]
  onChange: (next: string[]) => void
}): JSX.Element {
  const openMenu = useMenu((s) => s.open)

  const items: MenuItem[] =
    field.type === 'multi_select'
      ? field.options.map((option) => ({
          label: `${values.includes(option.name) ? '✓ ' : '   '}${option.name}`,
          onClick: () =>
            onChange(
              values.includes(option.name)
                ? values.filter((v) => v !== option.name)
                : [...values, option.name]
            )
        }))
      : [
          { label: '— none —', onClick: () => onChange([]) },
          { separator: true },
          ...field.options.map((option) => ({
            label: `${values[0] === option.name ? '✓ ' : '   '}${option.name}`,
            onClick: () => onChange([option.name])
          }))
        ]

  if (values.length === 0) {
    return (
      <button className="cell cell--empty" title={`Set ${field.name}`} onClick={(e) => openMenu(e, items)}>
        —
      </button>
    )
  }

  return (
    <button className="cell" title={`${field.name} — click to change`} onClick={(e) => openMenu(e, items)}>
      {values.map((value) => (
        <span
          key={value}
          className="pill"
          style={{ ['--pill' as string]: colorFor(field, value) }}
        >
          {value}
        </span>
      ))}
    </button>
  )
}

function Row({
  task,
  fields,
  onPatch,
  onDelete
}: {
  task: NotionTask
  fields: NotionField[]
  onPatch: (task: NotionTask, patch: NotionTaskPatch) => void
  onDelete: (task: NotionTask) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const openMenu = useMenu((s) => s.open)

  useEffect(() => {
    if (!editing) setDraft(task.title)
  }, [task.title, editing])

  function commit(): void {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== task.title) onPatch(task, { title: next })
    else setDraft(task.title)
  }

  return (
    <div
      className={`task-row${task.done ? ' task-row--done' : ''}`}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Rename', onClick: () => setEditing(true) },
          {
            label: task.done ? 'Mark as not done' : 'Mark as done',
            onClick: () => onPatch(task, { done: !task.done })
          },
          ...(task.url
            ? [{ label: 'Open in Notion', onClick: () => window.open(task.url!, '_blank') }]
            : []),
          { separator: true as const },
          { label: 'Delete', danger: true, onClick: () => onDelete(task) }
        ])
      }
    >
      <input
        type="checkbox"
        checked={task.done}
        onChange={() => onPatch(task, { done: !task.done })}
        title={task.done ? 'Mark as not done' : 'Mark as done'}
      />

      {editing ? (
        <input
          className="task-edit"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(task.title)
              setEditing(false)
            }
            e.stopPropagation()
          }}
        />
      ) : (
        <span
          className="task-title"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {task.title}
        </span>
      )}

      <span className="task-cells">
        {fields.map((field) => (
          <Badge
            key={field.name}
            field={field}
            values={task.values[field.name] ?? []}
            onChange={(next) => onPatch(task, { values: { [field.name]: next } })}
          />
        ))}
      </span>
    </div>
  )
}

export function NotionPanel(props: IDockviewPanelProps<NotionPanelParams>): JSX.Element {
  const projectId = props.params.projectId
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const tokenSet = useStore((s) => s.notionTokenSet)
  const setModal = useStore((s) => s.setModal)
  const [board, setBoard] = useState<NotionBoard | null>(null)
  const [busy, setBusy] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [query, setQuery] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [groupBy, setGroupBy] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const target = project?.notion.target ?? null
  const reqId = useRef(0)

  const refresh = useCallback(async () => {
    if (!target) return
    const id = ++reqId.current
    setBusy(true)
    const result = await window.api.notion.list(target)
    // Ignore a response that a newer request has already superseded.
    if (id !== reqId.current) return
    setBoard(result)
    setError(result.ok ? null : result.error)
    setBusy(false)
  }, [target])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (project) props.api.setTitle(`✅ tasks · ${project.name}`)
  }, [project?.name, props.api])

  const fields = board?.fields ?? []
  const allTasks = useMemo(() => board?.tasks ?? [], [board])

  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allTasks.filter((task) => {
      if (hideDone && task.done) return false
      if (!needle) return true
      if (task.title.toLowerCase().includes(needle)) return true
      // Searching "bug" or "high" should narrow by column value too.
      return Object.values(task.values).some((values) =>
        values.some((v) => v.toLowerCase().includes(needle))
      )
    })
  }, [allTasks, query, hideDone])

  /** Bucket the visible rows under the chosen column, mirroring a Notion group. */
  const groups = useMemo(() => {
    if (!groupBy) return [{ key: '', label: '', tasks: visibleTasks }]
    const field = fields.find((f) => f.name === groupBy)
    const order = field ? field.options.map((o) => o.name) : []
    const buckets = new Map<string, NotionTask[]>()
    for (const task of visibleTasks) {
      const keys = task.values[groupBy]?.length ? task.values[groupBy] : ['—']
      for (const key of keys) {
        const list = buckets.get(key)
        if (list) list.push(task)
        else buckets.set(key, [task])
      }
    }
    return [...buckets.entries()]
      .sort((a, b) => {
        const ai = order.indexOf(a[0])
        const bi = order.indexOf(b[0])
        // Options keep Notion's own order; anything unknown sinks to the bottom.
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return a[0].localeCompare(b[0])
      })
      .map(([key, tasks]) => ({ key, label: key, tasks }))
  }, [visibleTasks, groupBy, fields])

  async function patch(task: NotionTask, change: NotionTaskPatch): Promise<void> {
    // Apply locally first so the board doesn't feel like it stalls on the network.
    setBoard((prev) =>
      prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) =>
              t.id === task.id
                ? {
                    ...t,
                    ...(change.title !== undefined ? { title: change.title } : {}),
                    ...(change.done !== undefined ? { done: change.done } : {}),
                    values: { ...t.values, ...(change.values ?? {}) }
                  }
                : t
            )
          }
        : prev
    )
    if (!target) return
    const result = await window.api.notion.update(target, task.id, change)
    if (!result.ok) setError(result.error ?? 'Notion rejected that change.')
    await refresh()
  }

  async function remove(task: NotionTask): Promise<void> {
    setBoard((prev) => (prev ? { ...prev, tasks: prev.tasks.filter((t) => t.id !== task.id) } : prev))
    if (!target) return
    const result = await window.api.notion.remove(target, task.id)
    if (!result.ok) setError(result.error ?? 'Could not delete that task.')
    await refresh()
  }

  if (!project) return <div className="notion-panel">This project no longer exists.</div>

  if (!tokenSet) {
    return (
      <div className="notion-panel notion-panel--empty">
        <h3>Connect Notion</h3>
        <p>
          Add an internal integration token in Settings, then share the page or database with that
          integration from Notion’s ••• → Connections menu.
        </p>
        <button className="btn btn--primary" onClick={() => setModal({ kind: 'settings' })}>
          Open settings
        </button>
      </div>
    )
  }

  if (!target) {
    return (
      <div className="notion-panel notion-panel--empty">
        <h3>No Notion page linked</h3>
        <p>Paste a Notion database or page link into this project’s settings.</p>
        <button className="btn btn--primary" onClick={() => setModal({ kind: 'project', projectId })}>
          Link a page
        </button>
      </div>
    )
  }

  const filtering = query.trim().length > 0 || hideDone

  return (
    <div className="notion-panel" style={{ ['--accent' as string]: project.color }}>
      <div className="notion-bar">
        <span className="notion-title">{board?.title ?? 'Tasks'}</span>
        <input
          className="notion-search"
          placeholder="Search tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
        {filtering && (
          <span className="notion-count">
            {visibleTasks.length}/{allTasks.length}
          </span>
        )}
        {fields.length > 0 && (
          <select
            className="notion-groupby"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            title="Group rows by a column"
          >
            <option value="">No grouping</option>
            {fields.map((field) => (
              <option key={field.name} value={field.name}>
                Group by {field.name}
              </option>
            ))}
          </select>
        )}
        <button
          className={`btn btn--tiny${hideDone ? ' btn--primary' : ''}`}
          onClick={() => setHideDone((v) => !v)}
        >
          {hideDone ? 'Open only' : 'Hide done'}
        </button>
        <button className="btn btn--tiny" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
        <button className="btn btn--tiny" onClick={() => setModal({ kind: 'project', projectId })}>
          Configure
        </button>
      </div>

      {error && <div className="notion-error">{error}</div>}

      <form
        className="notion-add"
        onSubmit={async (e) => {
          e.preventDefault()
          const title = newTitle.trim()
          if (!title) return
          setNewTitle('')
          const result = await window.api.notion.create(target, title)
          if (!result.ok) setError(result.error ?? 'Could not add that task.')
          await refresh()
        }}
      >
        <input
          placeholder="Add a task…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button className="btn btn--tiny btn--primary" type="submit" disabled={!newTitle.trim()}>
          Add
        </button>
      </form>

      {fields.length > 0 && (
        <div className="task-head">
          <span className="task-head-name">Name</span>
          <span className="task-cells">
            {fields.map((field) => (
              <span key={field.name} className="task-head-cell">
                {field.name}
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="task-list">
        {allTasks.length === 0 && !busy && <div className="notion-empty">No tasks yet.</div>}
        {allTasks.length > 0 && visibleTasks.length === 0 && (
          <div className="notion-empty">
            {query.trim() ? `Nothing matches “${query.trim()}”.` : 'Every task is done.'}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.key} className="task-group">
            {groupBy && (
              <button
                className="task-group-head"
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
                }
              >
                <span className={`chevron${collapsed[group.key] ? '' : ' chevron--open'}`}>▸</span>
                <span
                  className="pill"
                  style={{
                    ['--pill' as string]: colorFor(
                      fields.find((f) => f.name === groupBy),
                      group.label
                    )
                  }}
                >
                  {group.label}
                </span>
                <span className="task-group-count">{group.tasks.length}</span>
              </button>
            )}
            {!collapsed[group.key] &&
              group.tasks.map((task) => (
                <Row
                  key={`${group.key}:${task.id}`}
                  task={task}
                  fields={fields}
                  onPatch={(t, c) => void patch(t, c)}
                  onDelete={(t) => void remove(t)}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}

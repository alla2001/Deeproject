import { useEffect, useMemo, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { useStore } from '../state'
import { useMenu } from './ContextMenu'

export type IdeasPanelParams = Record<string, unknown>

function ago(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function IdeasPanel(_props: IDockviewPanelProps<IdeasPanelParams>): JSX.Element {
  const ideas = useStore((s) => s.ideas)
  const projects = useStore((s) => s.projects)
  const addIdea = useStore((s) => s.addIdea)
  const updateIdea = useStore((s) => s.updateIdea)
  const removeIdea = useStore((s) => s.removeIdea)
  const openMenu = useMenu((s) => s.open)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [dropActive, setDropActive] = useState(false)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? ideas.filter(
          (i) =>
            i.title.toLowerCase().includes(needle) ||
            i.body.toLowerCase().includes(needle) ||
            i.tags.some((t) => t.toLowerCase().includes(needle))
        )
      : ideas
    // Pinned first, then most recently touched.
    return [...matched].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }, [ideas, query])

  const selected = ideas.find((i) => i.id === selectedId) ?? null

  // Keep a sensible selection as the list changes underneath.
  useEffect(() => {
    if (selected) return
    setSelectedId(visible[0]?.id ?? null)
  }, [visible, selected])

  useEffect(() => {
    setTagDraft('')
  }, [selectedId])

  function create(): void {
    const idea = addIdea()
    setSelectedId(idea.id)
    setQuery('')
  }

  /** Copy files into the app's store and record them on the selected idea. */
  async function attach(sources: string[]): Promise<void> {
    if (!selected || sources.length === 0) return
    const stored = await window.api.ideas.attach(selected.id, sources)
    if (stored.length === 0) return
    updateIdea(selected.id, { images: [...selected.images, ...stored] })
  }

  async function pick(): Promise<void> {
    const chosen = await window.api.ideas.pickImages()
    await attach(chosen)
  }

  async function pasteImage(): Promise<void> {
    // Reuses the same clipboard-to-file path the terminals use.
    const saved = await window.api.sys.clipboardImage()
    if (saved) await attach([saved])
  }

  async function detach(image: string): Promise<void> {
    if (!selected) return
    updateIdea(selected.id, { images: selected.images.filter((i) => i !== image) })
    await window.api.ideas.removeImage(image)
  }

  async function remove(id: string, title: string): Promise<void> {
    const ok = await window.api.dialog.confirm({
      title: 'Delete idea',
      message: `Delete “${title}”?`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    removeIdea(id)
    if (selectedId === id) setSelectedId(null)
  }

  return (
    <div className="ideas-panel">
      <div className="ideas-list">
        <div className="ideas-head">
          <input
            className="search"
            placeholder="Search ideas…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button className="icon-btn" title="New idea" onClick={create}>
            +
          </button>
        </div>

        <div className="ideas-scroll">
          {ideas.length === 0 && (
            <div className="ideas-empty">
              <p>No ideas yet.</p>
              <button className="btn" onClick={create}>
                Write the first one
              </button>
            </div>
          )}
          {ideas.length > 0 && visible.length === 0 && (
            <div className="ideas-empty">
              <p>Nothing matches “{query.trim()}”.</p>
            </div>
          )}
          {visible.map((idea) => (
            <button
              key={idea.id}
              className={`idea-row${idea.id === selectedId ? ' idea-row--on' : ''}`}
              onClick={() => setSelectedId(idea.id)}
              onContextMenu={(e) =>
                openMenu(e, [
                  {
                    label: idea.pinned ? 'Unpin' : 'Pin to top',
                    onClick: () => updateIdea(idea.id, { pinned: !idea.pinned })
                  },
                  { separator: true },
                  { label: 'Delete', danger: true, onClick: () => void remove(idea.id, idea.title) }
                ])
              }
            >
              <span className="idea-row-title">
                {idea.pinned && <span className="idea-pin">★</span>}
                {idea.title || 'Untitled idea'}
              </span>
              <span className="idea-row-meta">
                {idea.tags.slice(0, 2).map((tag) => (
                  <span key={tag} className="idea-tag">
                    {tag}
                  </span>
                ))}
                <span className="idea-age">{ago(idea.updatedAt)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="ideas-editor">
        {!selected ? (
          <div className="ideas-empty ideas-empty--center">
            <div className="watch-mark">💡</div>
            <p>Pick an idea, or start a new one.</p>
          </div>
        ) : (
          <>
            <div className="ideas-editor-head">
              <input
                className="idea-title"
                value={selected.title}
                placeholder="Idea title"
                onChange={(e) => updateIdea(selected.id, { title: e.target.value }, false)}
                onBlur={() => updateIdea(selected.id, {}, true)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <button
                className={`btn btn--tiny${selected.pinned ? ' btn--primary' : ''}`}
                onClick={() => updateIdea(selected.id, { pinned: !selected.pinned })}
                title="Pin to the top of the list"
              >
                ★
              </button>
              <button
                className="btn btn--tiny"
                onClick={() => void remove(selected.id, selected.title)}
              >
                Delete
              </button>
            </div>

            <div className="idea-meta-row">
              <select
                value={selected.projectId ?? ''}
                onChange={(e) => updateIdea(selected.id, { projectId: e.target.value || null })}
                title="Link this idea to a project once you start building it"
              >
                <option value="">Not linked to a project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.emoji} {project.name}
                  </option>
                ))}
              </select>

              <div className="idea-tags">
                {selected.tags.map((tag) => (
                  <button
                    key={tag}
                    className="idea-tag idea-tag--removable"
                    title="Click to remove"
                    onClick={() =>
                      updateIdea(selected.id, { tags: selected.tags.filter((t) => t !== tag) })
                    }
                  >
                    {tag} ✕
                  </button>
                ))}
                <input
                  className="idea-tag-input"
                  placeholder="add tag"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key !== 'Enter') return
                    const tag = tagDraft.trim()
                    if (tag && !selected.tags.includes(tag)) {
                      updateIdea(selected.id, { tags: [...selected.tags, tag] })
                    }
                    setTagDraft('')
                  }}
                />
              </div>
            </div>

            <div
              className={`idea-images${dropActive ? ' idea-images--drop' : ''}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return
                e.preventDefault()
                setDropActive(true)
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setDropActive(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDropActive(false)
                const paths = Array.from(e.dataTransfer.files)
                  .map((f) => window.api.sys.pathForFile(f))
                  .filter(Boolean)
                void attach(paths)
              }}
            >
              {selected.images.map((image) => (
                <div className="idea-image" key={image}>
                  <img
                    src={window.api.sys.mediaUrl(image)}
                    alt=""
                    onClick={() => void window.api.sys.reveal(image)}
                    title="Click to open"
                  />
                  <button
                    className="idea-image-remove"
                    title="Remove"
                    onClick={() => void detach(image)}
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button className="idea-image-add" onClick={() => void pick()} title="Attach images">
                <span>＋</span>
                <span className="idea-image-hint">
                  {selected.images.length === 0 ? 'Add, paste or drop images' : 'Add'}
                </span>
              </button>
            </div>

            <textarea
              className="idea-body"
              onPaste={(e) => {
                // An image on the clipboard becomes an attachment rather than
                // pasting nothing into the text.
                if (!Array.from(e.clipboardData.items).some((i) => i.type.startsWith('image/'))) {
                  return
                }
                e.preventDefault()
                void pasteImage()
              }}
              placeholder="What is it? Why is it fun? What's the hook?"
              value={selected.body}
              // Debounced while typing; the blur below forces a final write.
              onChange={(e) => updateIdea(selected.id, { body: e.target.value }, false)}
              onBlur={() => updateIdea(selected.id, {}, true)}
              onKeyDown={(e) => e.stopPropagation()}
            />

            <div className="idea-footer">
              saved · edited {ago(selected.updatedAt)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

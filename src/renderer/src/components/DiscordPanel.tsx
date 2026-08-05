import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { DiscordBoard, DiscordDetail, DiscordPost } from '@shared/types'
import { useStore } from '../state'
import { useMenu, type MenuItem } from './ContextMenu'

export interface DiscordPanelParams extends Record<string, unknown> {
  projectId: string
}

/** Colour tags by meaning so severity reads at a glance, as it does in Discord. */
const TAG_COLORS: { match: RegExp; color: string }[] = [
  { match: /^(critical|blocker|urgent)$/i, color: '#f43f5e' },
  { match: /^(major|high)$/i, color: '#f97316' },
  { match: /^(minor|low)$/i, color: '#eab308' },
  { match: /^(open|new|todo)$/i, color: '#38bdf8' },
  { match: /^(fixed|done|resolved|closed)$/i, color: '#22c55e' },
  { match: /^(cant-repro|can't-repro|wont-fix|won't-fix|invalid|duplicate)$/i, color: '#8b94a7' }
]

function tagColor(name: string): string {
  return TAG_COLORS.find((t) => t.match.test(name))?.color ?? '#a78bfa'
}

function relativeAge(at: number | null): string {
  if (!at) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function Post({
  post,
  board,
  onTags,
  onArchive,
  onToNotion,
  notionLinked
}: {
  post: DiscordPost
  board: DiscordBoard
  onTags: (post: DiscordPost, tagIds: string[]) => void
  onArchive: (post: DiscordPost, archived: boolean) => void
  onToNotion: (post: DiscordPost) => void
  notionLinked: boolean
}): JSX.Element {
  const openMenu = useMenu((s) => s.open)
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<DiscordDetail | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetched on first expand only; the board request deliberately keeps its
  // payload small, so the full text and replies are pulled on demand.
  async function toggle(): Promise<void> {
    const next = !open
    setOpen(next)
    if (!next || detail || loading) return
    setLoading(true)
    const result = await window.api.discord.get(post.id, 30)
    setDetail(result)
    setLoading(false)
  }

  const tagItems: MenuItem[] = board.tags.map((tag) => ({
    label: `${post.tagIds.includes(tag.id) ? '✓ ' : '   '}${tag.emoji ? tag.emoji + ' ' : ''}${tag.name}`,
    onClick: () =>
      onTags(
        post,
        post.tagIds.includes(tag.id)
          ? post.tagIds.filter((id) => id !== tag.id)
          : [...post.tagIds, tag.id]
      )
  }))

  const menu: MenuItem[] = [
    ...tagItems,
    { separator: true },
    {
      label: post.archived ? 'Reopen post' : 'Close (archive) post',
      onClick: () => onArchive(post, !post.archived)
    },
    ...(notionLinked
      ? [{ label: 'Create Notion task from this', onClick: () => onToNotion(post) }]
      : []),
    ...(post.url ? [{ label: 'Open in Discord', onClick: () => window.open(post.url!, '_blank') }] : [])
  ]

  return (
    <div
      className={`report${post.archived ? ' report--archived' : ''}${open ? ' report--open' : ''}`}
      onContextMenu={(e) => openMenu(e, menu)}
    >
      <div className="report-tags">
        {post.tags.map((tag) => (
          <span key={tag} className="pill" style={{ ['--pill' as string]: tagColor(tag) }}>
            {tag}
          </span>
        ))}
        <button
          className="report-tag-edit"
          title="Change tags"
          onClick={(e) => openMenu(e, tagItems)}
        >
          +
        </button>
      </div>

      <button className="report-title" onClick={() => void toggle()} title="Click to read in full">
        <span className={`chevron${open ? ' chevron--open'  : ''}`}>▸</span>
        {post.title}
      </button>

      {!open && post.excerpt && <div className="report-excerpt">{post.excerpt}</div>}

      {open && (
        <div className="report-full">
          {loading && <div className="report-loading">Loading the full report…</div>}
          {detail && !detail.ok && <div className="report-loading">{detail.error}</div>}
          {detail?.ok && (
            <>
              <div className="report-body">{detail.body || '(no text in the opening post)'}</div>

              {detail.attachments.length > 0 && (
                <div className="report-shots">
                  {detail.attachments.map((url) => (
                    <img
                      key={url}
                      src={url}
                      alt="attachment"
                      loading="lazy"
                      onClick={() => window.open(url, '_blank')}
                    />
                  ))}
                </div>
              )}

              {detail.replies.length > 0 && (
                <div className="report-replies">
                  {detail.replies.map((reply, i) => (
                    <div className="report-reply" key={i}>
                      <span className="report-reply-author">{reply.author}</span>
                      <span className="report-reply-body">{reply.content || '(attachment only)'}</span>
                      <span className="report-reply-age">{relativeAge(reply.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="report-meta">
        {post.author && <span>{post.author}</span>}
        <span>💬 {post.messageCount}</span>
        <span>{relativeAge(post.createdAt)}</span>
        {post.archived && <span className="report-closed">closed</span>}
        <span className="spacer" />
        {notionLinked && (
          <button className="btn btn--tiny" onClick={() => onToNotion(post)} title="Add to the Notion board">
            → Notion
          </button>
        )}
        <button className="btn btn--tiny" onClick={() => void toggle()}>
          {open ? 'Collapse' : 'Read'}
        </button>
        {post.url && (
          <button className="btn btn--tiny" onClick={() => window.open(post.url!, '_blank')}>
            Discord
          </button>
        )}
      </div>
    </div>
  )
}

export function DiscordPanel(props: IDockviewPanelProps<DiscordPanelParams>): JSX.Element {
  const projectId = props.params.projectId
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const tokenSet = useStore((s) => s.discordTokenSet)
  const setModal = useStore((s) => s.setModal)
  const updateDiscord = useStore((s) => s.updateDiscord)
  const [board, setBoard] = useState<DiscordBoard | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [showClosed, setShowClosed] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const channel = project?.discord.channel ?? null
  const notionTarget = project?.notion.target ?? null
  const reqId = useRef(0)

  const refresh = useCallback(async () => {
    if (!channel) return
    const id = ++reqId.current
    setBusy(true)
    const result = await window.api.discord.list(channel, true)
    if (id !== reqId.current) return
    setBoard(result)
    setError(result.ok ? null : result.error)
    setBusy(false)
    if (result.ok && result.channelName) {
      updateDiscord(projectId, { channelName: result.channelName })
    }
  }, [channel, projectId, updateDiscord])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (project) props.api.setTitle(`🐛 reports · ${project.name}`)
  }, [project?.name, props.api])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (board?.posts ?? []).filter((post) => {
      if (!showClosed && post.archived) return false
      if (tagFilter && !post.tags.includes(tagFilter)) return false
      if (!needle) return true
      return (
        post.title.toLowerCase().includes(needle) ||
        post.excerpt.toLowerCase().includes(needle) ||
        post.tags.some((t) => t.toLowerCase().includes(needle))
      )
    })
  }, [board, query, tagFilter, showClosed])

  /**
   * Discord blanks `content` for apps without the Message Content intent, so a
   * board full of posts with no body almost always means that toggle is off
   * rather than that everyone posted empty reports.
   */
  const missingContent =
    (board?.posts.length ?? 0) > 0 && (board?.posts ?? []).every((p) => p.excerpt === '')

  async function setTags(post: DiscordPost, tagIds: string[]): Promise<void> {
    setBoard((prev) =>
      prev
        ? {
            ...prev,
            posts: prev.posts.map((p) =>
              p.id === post.id
                ? {
                    ...p,
                    tagIds,
                    tags: tagIds
                      .map((id) => prev.tags.find((t) => t.id === id)?.name)
                      .filter((n): n is string => Boolean(n))
                  }
                : p
            )
          }
        : prev
    )
    const result = await window.api.discord.setTags(post.id, tagIds)
    if (!result.ok) {
      setError(result.error ?? 'Could not change the tags.')
      await refresh()
    }
  }

  async function archive(post: DiscordPost, archived: boolean): Promise<void> {
    setBoard((prev) =>
      prev
        ? { ...prev, posts: prev.posts.map((p) => (p.id === post.id ? { ...p, archived } : p)) }
        : prev
    )
    const result = await window.api.discord.setArchived(post.id, archived)
    if (!result.ok) {
      setError(result.error ?? 'Could not change that post.')
      await refresh()
    }
  }

  /** Carry a report across to the project's Notion board. */
  async function toNotion(post: DiscordPost): Promise<void> {
    if (!notionTarget) return
    const title = post.tags.length > 0 ? `[${post.tags.join('/')}] ${post.title}` : post.title
    const result = await window.api.notion.create(notionTarget, title)
    setNote(result.ok ? `Added “${post.title}” to Notion.` : (result.error ?? 'Could not add it.'))
    window.setTimeout(() => setNote(null), 5000)
  }

  if (!project) return <div className="notion-panel">This project no longer exists.</div>

  if (!tokenSet) {
    return (
      <div className="notion-panel notion-panel--empty">
        <h3>Connect Discord</h3>
        <p>
          Add a bot token in Settings, invite the bot to your server, and give it View Channel plus
          Read Message History on the forum. Manage Threads lets you retag posts from here too.
        </p>
        <button className="btn btn--primary" onClick={() => setModal({ kind: 'settings' })}>
          Open settings
        </button>
      </div>
    )
  }

  if (!channel) {
    return (
      <div className="notion-panel notion-panel--empty">
        <h3>No forum linked</h3>
        <p>Paste the link to your bug-report forum channel into this project’s settings.</p>
        <button className="btn btn--primary" onClick={() => setModal({ kind: 'project', projectId })}>
          Link a forum
        </button>
      </div>
    )
  }

  return (
    <div className="notion-panel" style={{ ['--accent' as string]: project.color }}>
      <div className="notion-bar">
        <span className="notion-title">{board?.channelName ?? project.discord.channelName ?? 'Reports'}</span>
        <input
          className="notion-search"
          placeholder="Search reports…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
        {(query || tagFilter || !showClosed) && (
          <span className="notion-count">
            {visible.length}/{board?.posts.length ?? 0}
          </span>
        )}
        {board && board.tags.length > 0 && (
          <select
            className="notion-groupby"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          >
            <option value="">All tags</option>
            {board.tags.map((tag) => (
              <option key={tag.id} value={tag.name}>
                {tag.name}
              </option>
            ))}
          </select>
        )}
        <button
          className={`btn btn--tiny${showClosed ? '' : ' btn--primary'}`}
          onClick={() => setShowClosed((v) => !v)}
        >
          {showClosed ? 'Hide closed' : 'Open only'}
        </button>
        <button className="btn btn--tiny" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
        <button className="btn btn--tiny" onClick={() => setModal({ kind: 'project', projectId })}>
          Configure
        </button>
      </div>

      {error && <div className="notion-error">{error}</div>}
      {note && <div className="notion-note">{note}</div>}
      {missingContent && (
        <div className="notion-error">
          Titles and tags loaded, but every post body is empty. Turn on the <b>Message Content
          Intent</b> for your bot at discord.com/developers/applications → Bot → Privileged Gateway
          Intents; without it Discord strips message text from the API.
        </div>
      )}

      <div className="report-list">
        {busy && !board && <div className="notion-empty">Loading reports…</div>}
        {board?.posts.length === 0 && !busy && (
          <div className="notion-empty">No posts in this forum yet.</div>
        )}
        {board && board.posts.length > 0 && visible.length === 0 && (
          <div className="notion-empty">Nothing matches those filters.</div>
        )}
        {board &&
          visible.map((post) => (
            <Post
              key={post.id}
              post={post}
              board={board}
              onTags={(p, t) => void setTags(p, t)}
              onArchive={(p, a) => void archive(p, a)}
              onToNotion={(p) => void toNotion(p)}
              notionLinked={Boolean(notionTarget)}
            />
          ))}
      </div>
    </div>
  )
}

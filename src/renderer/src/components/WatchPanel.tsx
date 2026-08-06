import { useEffect, useMemo, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { useStore } from '../state'
import { useMenu } from './ContextMenu'

export type WatchPanelParams = Record<string, unknown>

interface Watchable {
  src: string
  label: string
}

/**
 * Normalise any YouTube link to a watch URL on youtube.com.
 *
 * The panel loads the real site in a <webview> rather than the /embed player:
 * an embed refuses to run from this app's `app://` origin (YouTube "Error 153"),
 * and short of forging a referrer there is no way around that. Loading the page
 * itself is just browsing, so it works and search and related videos come too.
 *
 * Handles watch links, short youtu.be links, playlists, /shorts and /live, and
 * carries a `t=` timestamp through.
 */
export function toWatchUrl(input: string): Watchable | null {
  const raw = input.trim()
  if (!raw) return null

  // A bare 11-character id is a video on its own.
  if (/^[\w-]{11}$/.test(raw)) {
    return { src: `https://www.youtube.com/watch?v=${raw}`, label: raw }
  }

  let url: URL
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  } catch {
    return null
  }

  const host = url.hostname.replace(/^www\./, '')
  if (!/^(youtube\.com|m\.youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) return null

  const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start'))
  const list = url.searchParams.get('list')

  let videoId: string | null = null
  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0] || null
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v')
  } else {
    const match = url.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]+)/)
    if (match) videoId = match[2]
  }

  if (videoId) {
    const params = new URLSearchParams({ v: videoId })
    if (start) params.set('t', `${start}s`)
    if (list) params.set('list', list)
    return { src: `https://www.youtube.com/watch?${params.toString()}`, label: videoId }
  }

  // A playlist link with no specific video still plays from the top.
  if (list) {
    return {
      src: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`,
      label: `playlist ${list}`
    }
  }

  return null
}

/** YouTube timestamps arrive as `90`, `90s`, or `1h2m3s`. */
function parseStart(value: string | null): number {
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value)
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!match) return 0
  const [, h, m, s] = match
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
}

export function WatchPanel(_props: IDockviewPanelProps<WatchPanelParams>): JSX.Element {
  const videos = useStore((s) => s.videos)
  const addVideo = useStore((s) => s.addVideo)
  const removeVideo = useStore((s) => s.removeVideo)
  const openMenu = useMenu((s) => s.open)

  const [draft, setDraft] = useState('')
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(true)

  // Reopening the panel lands on whatever was saved most recently.
  useEffect(() => {
    if (!current && videos.length > 0) setCurrent(videos[0].url)
  }, [videos, current])

  const watchable = useMemo(() => toWatchUrl(current), [current])

  function play(url: string): void {
    const parsed = toWatchUrl(url)
    if (!parsed) {
      setError('That does not look like a YouTube link.')
      return
    }
    setError(null)
    setCurrent(url)
  }

  return (
    <div className="watch-panel">
      <form
        className="watch-bar"
        onSubmit={(e) => {
          e.preventDefault()
          play(draft)
        }}
      >
        <input
          className="watch-input"
          placeholder="Paste a YouTube link…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button className="btn btn--tiny btn--primary" type="submit" disabled={!draft.trim()}>
          Play
        </button>
        <button
          className="btn btn--tiny"
          type="button"
          disabled={!toWatchUrl(draft || current)}
          onClick={() => {
            const url = draft.trim() || current
            if (!url) return
            addVideo(url, '')
            setDraft('')
            play(url)
          }}
        >
          Save
        </button>
        <button
          className="btn btn--tiny"
          type="button"
          onClick={() => setListOpen((v) => !v)}
          title="Saved videos"
        >
          {listOpen ? 'Hide list' : `Saved (${videos.length})`}
        </button>
      </form>

      {error && <div className="notion-error">{error}</div>}

      <div className="watch-body">
        <div className="watch-stage">
          {watchable ? (
            <webview
              // Remounting on change is what actually navigates the view.
              key={watchable.src}
              src={watchable.src}
              // Its own session, so a YouTube login here stays out of the rest
              // of the app and survives restarts.
              partition="persist:watch"
            />
          ) : (
            <div className="watch-empty">
              <div className="watch-mark">▶</div>
              <p>Paste a YouTube link above to watch it here while you work.</p>
            </div>
          )}
        </div>

        {listOpen && (
          <div className="watch-list">
            {videos.length === 0 && <div className="watch-list-empty">Nothing saved yet.</div>}
            {videos.map((video) => (
              <button
                key={video.id}
                className={`watch-item${video.url === current ? ' watch-item--on' : ''}`}
                onClick={() => play(video.url)}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: 'Open on youtube.com', onClick: () => window.open(video.url, '_blank') },
                    { separator: true },
                    { label: 'Remove', danger: true, onClick: () => removeVideo(video.id) }
                  ])
                }
                title={video.url}
              >
                <span className="watch-item-title">{video.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

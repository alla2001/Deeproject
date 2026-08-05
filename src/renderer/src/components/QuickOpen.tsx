import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state'
import { openEditor } from '../lib/actions'

interface Hit {
  path: string
  name: string
  relative: string
  projectId: string
  root: string
  score: number
}

/** Subsequence match biased toward the file name over the folder path. */
function score(name: string, relative: string, needle: string): number | null {
  const n = needle.toLowerCase()
  const lowerName = name.toLowerCase()
  const lowerPath = relative.toLowerCase()

  if (lowerName.startsWith(n)) return 1000 - lowerPath.length
  const inName = lowerName.indexOf(n)
  if (inName !== -1) return 800 - inName - lowerPath.length * 0.01
  const inPath = lowerPath.indexOf(n)
  if (inPath !== -1) return 500 - inPath * 0.1

  let index = 0
  let gaps = 0
  for (const ch of n) {
    const found = lowerPath.indexOf(ch, index)
    if (found === -1) return null
    gaps += found - index
    index = found + 1
  }
  return 200 - gaps
}

export function QuickOpen(): JSX.Element | null {
  const open = useStore((s) => s.quickOpen)
  const setOpen = useStore((s) => s.setQuickOpen)
  const projects = useStore((s) => s.projects)
  const activeTerminalId = useStore((s) => s.activeTerminalId)
  const terminals = useStore((s) => s.terminals)

  const [files, setFiles] = useState<Hit[]>([])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Scope to the project of the focused terminal, falling back to all of them.
  const scoped = useMemo(() => {
    const active = terminals.find((t) => t.id === activeTerminalId)
    const preferred = projects.find((p) => p.id === active?.projectId)
    return preferred ? [preferred] : projects
  }, [projects, terminals, activeTerminalId])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())

    let alive = true
    setLoading(true)
    void Promise.all(
      scoped.map(async (project) => {
        const paths = await window.api.fs.walk(project.path)
        return paths.map((path) => ({
          path,
          name: path.split(/[\\/]/).pop() ?? path,
          relative: path.startsWith(project.path) ? path.slice(project.path.length + 1) : path,
          projectId: project.id,
          root: project.path,
          score: 0
        }))
      })
    ).then((groups) => {
      if (!alive) return
      setFiles(groups.flat())
      setLoading(false)
    })

    return () => {
      alive = false
    }
  }, [open, scoped])

  const results = useMemo(() => {
    const needle = query.trim()
    if (!needle) return files.slice(0, 50)
    const scored: Hit[] = []
    for (const hit of files) {
      const value = score(hit.name, hit.relative, needle)
      if (value !== null) scored.push({ ...hit, score: value })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 50)
  }, [files, query])

  useEffect(() => setIndex(0), [query])

  if (!open) return null

  function choose(hit: Hit | undefined): void {
    if (!hit) return
    setOpen(false)
    openEditor(hit.projectId, hit.root, hit.path)
  }

  return (
    <div className="modal-scrim modal-scrim--top" onMouseDown={() => setOpen(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={loading ? 'Indexing files…' : 'Open a file by name…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            }
          }}
        />
        <div className="palette-list">
          {!loading && results.length === 0 && <div className="palette-empty">No files match</div>}
          {results.map((hit, i) => (
            <button
              key={hit.path}
              className={`palette-row${i === index ? ' palette-row--on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(hit)}
            >
              <span className="palette-icon">📄</span>
              <span className="palette-label">{hit.name}</span>
              <span className="palette-detail">{hit.relative}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

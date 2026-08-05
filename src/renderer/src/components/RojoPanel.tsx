import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { useStore } from '../state'
import { startRojo, stopRojo } from '../lib/actions'

export interface RojoPanelParams extends Record<string, unknown> {
  projectId: string
}

export function RojoPanel(props: IDockviewPanelProps<RojoPanelParams>): JSX.Element {
  const projectId = props.params.projectId
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const state = useStore((s) => s.rojoStates[projectId])
  const setModal = useStore((s) => s.setModal)
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const pinnedToBottom = useRef(true)

  // Seed with whatever the server already produced, then stream.
  useEffect(() => {
    let alive = true
    void window.api.rojo.log(projectId).then((existing) => {
      if (alive) setLog(existing)
    })
    const off = window.api.rojo.onLog((event) => {
      if (event.projectId !== projectId) return
      setLog((prev) => {
        const next = prev + event.chunk
        // Keep the buffer bounded; the main process caps its own copy too.
        return next.length > 200_000 ? next.slice(next.length - 200_000) : next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [projectId])

  // Follow the tail unless the user has scrolled up to read something.
  useEffect(() => {
    const el = logRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [log])

  useEffect(() => {
    if (project) props.api.setTitle(`🧩 rojo · ${project.name}`)
  }, [project?.name, props.api])

  if (!project) return <div className="rojo-panel">This project no longer exists.</div>

  const status = state?.status ?? 'stopped'
  const running = status === 'running' || status === 'starting'

  return (
    <div className="rojo-panel" style={{ ['--accent' as string]: project.color }}>
      <div className="rojo-bar">
        <span className={`dot dot--${status === 'error' ? 'exited' : status}`} />
        <span className="rojo-status">{status}</span>
        <span className="rojo-port">port {state?.port ?? project.rojo.port}</span>
        {state?.pid && <span className="rojo-pid">pid {state.pid}</span>}
        <div className="spacer" />
        {running ? (
          <button className="btn btn--tiny" onClick={() => void stopRojo(projectId)}>
            Stop
          </button>
        ) : (
          <button className="btn btn--tiny btn--primary" onClick={() => void startRojo(projectId)}>
            Start
          </button>
        )}
        <button
          className="btn btn--tiny"
          onClick={() => setModal({ kind: 'project', projectId })}
          title="Rojo settings"
        >
          Configure
        </button>
        <button className="btn btn--tiny" onClick={() => setLog('')} title="Clear log">
          Clear
        </button>
      </div>

      {state?.message && <div className="rojo-error">{state.message}</div>}

      <pre
        className="rojo-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {log || 'No output yet. Press Start to run the Rojo server.'}
      </pre>

      {status === 'running' && (
        <div className="rojo-hint">
          In Roblox Studio open the Rojo plugin and connect to localhost:
          {state?.port ?? project.rojo.port}
        </div>
      )}
    </div>
  )
}

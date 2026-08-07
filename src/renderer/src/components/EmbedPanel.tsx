import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { closePanel } from '../lib/dock'

export interface EmbedPanelParams extends Record<string, unknown> {
  hwnd: number
  title: string
  exe: string
}

/**
 * Hosts a real Windows application inside a dock panel.
 *
 * Nothing is rendered into this panel: the app is a native child window owned
 * by the main process, sitting on top of whatever Chromium paints here. All
 * this component does is measure its own rectangle and keep the native window
 * glued to it. The placeholder underneath only shows through before the first
 * measurement, and after the app has gone away.
 */
export function EmbedPanel(props: IDockviewPanelProps<EmbedPanelParams>): JSX.Element {
  const { hwnd, title, exe } = props.params
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [gone, setGone] = useState(false)
  const [escaped, setEscaped] = useState(false)
  const [captured, setCaptured] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    /**
     * Report where the panel is. Win32 child coordinates are physical pixels
     * relative to the parent's client area, which is exactly the web page's
     * viewport — so the CSS rect scaled by devicePixelRatio maps straight over,
     * DPI and zoom included.
     */
    function report(): void {
      if (!host || !props.api.isVisible) return
      const rect = host.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      window.api.embed.setBounds(hwnd, {
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr)
      })
    }

    const observer = new ResizeObserver(report)
    observer.observe(host)

    // The observer catches size changes but not a panel sliding sideways when a
    // neighbour is resized, nor a DPI change from moving to another monitor.
    window.addEventListener('resize', report)
    const ticker = window.setInterval(report, 500)

    const offVisible = props.api.onDidVisibilityChange((e) => {
      window.api.embed.setVisible(hwnd, e.isVisible)
      if (e.isVisible) report()
    })
    const offActive = props.api.onDidActiveChange((e) => {
      if (e.isActive) window.api.embed.focus(hwnd)
    })
    const offGone = window.api.embed.onGone((dead) => {
      if (dead === hwnd) setGone(true)
    })
    const offEscaped = window.api.embed.onEscaped((e) => {
      if (e.hwnd === hwnd) setEscaped(true)
    })
    // Capture can end without us asking — the global hotkey, alt-tabbing away,
    // or the game exiting — so the badge follows main rather than local state.
    const offCapture = window.api.embed.onCaptureChange((held) => setCaptured(held === hwnd))

    report()
    window.api.embed.setVisible(hwnd, props.api.isVisible)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.clearInterval(ticker)
      offVisible.dispose()
      offActive.dispose()
      offGone()
      offEscaped()
      offCapture()
      // Closing the tab hands the application back to the desktop rather than
      // killing it — it was never ours to close.
      void window.api.embed.detach(hwnd)
    }
  }, [hwnd, props.api])

  return (
    <div className="embed-panel">
      {/*
        A strip the native window is never given. Anything we draw inside the
        stage would be painted under it, so the only controls that can be relied
        on to stay visible and clickable are the ones outside its rectangle.
      */}
      <div className={`embed-bar${captured ? ' embed-bar--on' : ''}`}>
        <span className="embed-bar-name">{exe ? exe.split(/[\\/]/).pop() : title}</span>
        {captured ? (
          <span className="embed-bar-hint">
            mouse captured — <kbd>Ctrl+Alt+M</kbd> to release
          </span>
        ) : (
          <button
            className="btn btn--tiny"
            onClick={() => void window.api.embed.captureMouse(hwnd)}
            disabled={gone}
            title="Give the mouse and keyboard to this window, for games that grab the pointer"
          >
            Capture mouse
          </button>
        )}
      </div>

      <div className="embed-stage" ref={hostRef}>
        {gone || escaped ? (
          <div className="embed-empty">
            <div className="embed-mark">⬚</div>
            {gone ? (
              <p>
                <strong>{title}</strong> closed.
              </p>
            ) : (
              <>
                <p>
                  <strong>{title}</strong> would not stay docked.
                </p>
                <p className="embed-note">
                  It kept moving itself back to the desktop, so it has been left there. Some
                  applications manage their own window and cannot be hosted inside another one.
                </p>
              </>
            )}
            <button className="btn btn--tiny" onClick={() => closePanel(props.api.id)}>
              Close tab
            </button>
          </div>
        ) : (
          <div className="embed-empty embed-empty--behind">
            <div className="embed-mark">⬚</div>
            <p>{title} is docked here.</p>
          </div>
        )}
      </div>
    </div>
  )
}

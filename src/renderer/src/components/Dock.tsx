import { useEffect, useRef } from 'react'
import {
  DockviewReact,
  themeAbyss,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview
} from 'dockview'
import { useStore } from '../state'
import { setDockApi } from '../lib/dock'
import { TerminalPanel, type TerminalPanelParams } from './TerminalPanel'
import { PanelTab } from './TerminalTab'
import { EditorPanel } from './EditorPanel'
import { FilesPanel } from './FilesPanel'
import { RojoPanel } from './RojoPanel'
import { NotionPanel } from './NotionPanel'
import { DiscordPanel } from './DiscordPanel'
import { WatchPanel } from './WatchPanel'
import { IdeasPanel } from './IdeasPanel'

type PanelComponent = React.FunctionComponent<IDockviewPanelProps>

const components = {
  terminal: TerminalPanel as unknown as PanelComponent,
  editor: EditorPanel as unknown as PanelComponent,
  files: FilesPanel as unknown as PanelComponent,
  rojo: RojoPanel as unknown as PanelComponent,
  notion: NotionPanel as unknown as PanelComponent,
  discord: DiscordPanel as unknown as PanelComponent,
  watch: WatchPanel as unknown as PanelComponent,
  ideas: IdeasPanel as unknown as PanelComponent
}

function Watermark(_props: IWatermarkPanelProps): JSX.Element {
  const projects = useStore((s) => s.projects)
  const addProjects = useStore((s) => s.addProjects)

  return (
    <div className="watermark">
      <div className="watermark-mark">◫</div>
      <h2>No terminals open</h2>
      {projects.length === 0 ? (
        <>
          <p>Add a project folder to get started.</p>
          <button className="btn btn--primary" onClick={() => void addProjects()}>
            Add project folder
          </button>
        </>
      ) : (
        <p>
          Pick a project in the sidebar and hit a launch button, or press{' '}
          <kbd>Ctrl+Shift+P</kbd>.
        </p>
      )}
      <div className="watermark-hints">
        <span>
          <kbd>Ctrl+Shift+P</kbd> command palette
        </span>
        <span>
          <kbd>Ctrl+Shift+T</kbd> new terminal
        </span>
        <span>Drag a tab to an edge to split</span>
      </div>
    </div>
  )
}

export function Dock(): JSX.Element {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => setDockApi(null), [])

  async function onReady(event: DockviewReadyEvent): Promise<void> {
    setDockApi(event.api)

    const layout = await window.api.layout.load()
    const state = useStore.getState()
    const knownTerminals = new Set(state.terminals.map((t) => t.id))
    const knownProjects = new Set(state.projects.map((p) => p.id))

    if (layout && typeof layout === 'object') {
      try {
        event.api.fromJSON(layout as SerializedDockview)
        // Drop panels whose terminal or project was deleted while we were
        // closed. Panels that belong to no particular project — the ideas and
        // watch tabs — carry no ids and are always kept.
        for (const panel of [...event.api.panels]) {
          const params = (panel.params ?? {}) as Partial<TerminalPanelParams> & {
            projectId?: string
          }
          const stale =
            (typeof params.terminalId === 'string' && !knownTerminals.has(params.terminalId)) ||
            (typeof params.projectId === 'string' && !knownProjects.has(params.projectId))
          if (stale) event.api.removePanel(panel)
        }
      } catch (err) {
        console.error('[dock] could not restore layout', err)
        event.api.clear()
      }
    }

    useStore.getState().setOpenPanels(event.api.panels.map((p) => p.id))

    // Registered after restore so deserialisation doesn't trigger a save.
    event.api.onDidLayoutChange(() => {
      useStore.getState().setOpenPanels(event.api.panels.map((p) => p.id))
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        try {
          void window.api.layout.save(event.api.toJSON())
        } catch (err) {
          console.error('[dock] could not serialise layout', err)
        }
      }, 400)
    })
  }

  return (
    <DockviewReact
      className="dock"
      theme={themeAbyss}
      components={components}
      defaultTabComponent={PanelTab as never}
      watermarkComponent={Watermark}
      defaultRenderer="always"
      onReady={(e) => void onReady(e)}
    />
  )
}

import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { useStore } from '../state'
import { ensureTheme, monaco } from '../lib/monaco'
import {
  getModel,
  getViewState,
  loadFile,
  revertFile,
  saveFile,
  setViewState,
  useEditors
} from '../lib/editors'

export interface EditorPanelParams extends Record<string, unknown> {
  projectId: string
  root: string
  filePath: string
}

export function EditorPanel(props: IDockviewPanelProps<EditorPanelParams>): JSX.Element {
  const { projectId, root, filePath } = props.params
  const key = `editor:${filePath.toLowerCase()}`
  const file = useEditors((s) => s.files[key])
  const settings = useStore((s) => s.settings)
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Load the file once; the model is shared and outlives this panel.
  useEffect(() => {
    void loadFile(projectId, root, filePath)
  }, [projectId, root, filePath])

  // Create the editor once the model exists.
  useEffect(() => {
    const host = hostRef.current
    const model = getModel(key)
    if (!host || !model || editorRef.current) return

    ensureTheme()
    const editor = monaco.editor.create(host, {
      model,
      theme: 'deeproject',
      automaticLayout: true,
      fontSize: settings.editorFontSize,
      fontFamily: settings.fontFamily,
      tabSize: settings.editorTabSize,
      wordWrap: settings.editorWordWrap ? 'on' : 'off',
      minimap: { enabled: settings.editorMinimap },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 8 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
    })
    editorRef.current = editor

    const restored = getViewState(key)
    if (restored) editor.restoreViewState(restored)

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSave()
    })

    return () => {
      setViewState(key, editor.saveViewState())
      editor.dispose()
      editorRef.current = null
    }
    // `file?.loading` gates creation until the model has been made.
  }, [key, file?.loading])

  // Push preference changes into a live editor.
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: settings.editorFontSize,
      fontFamily: settings.fontFamily,
      tabSize: settings.editorTabSize,
      wordWrap: settings.editorWordWrap ? 'on' : 'off',
      minimap: { enabled: settings.editorMinimap }
    })
  }, [settings])

  // Keep the tab label showing the dirty marker.
  useEffect(() => {
    if (file) props.api.setTitle(`${file.dirty ? '● ' : ''}${file.name}`)
  }, [file?.dirty, file?.name, props.api])

  useEffect(() => {
    const disposable = props.api.onDidActiveChange((e) => {
      if (e.isActive) requestAnimationFrame(() => editorRef.current?.focus())
    })
    return () => disposable.dispose()
  }, [props.api])

  async function handleSave(): Promise<void> {
    const result = await saveFile(key)
    setNotice(result.ok ? 'Saved' : (result.error ?? 'Could not save'))
    window.setTimeout(() => setNotice(null), result.ok ? 1200 : 4000)
  }

  if (file?.error) {
    return (
      <div className="editor-panel editor-panel--error">
        <p>{file.error}</p>
        <div className="row">
          <button className="btn" onClick={() => void window.api.sys.reveal(filePath)}>
            Show in Explorer
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-panel">
      <div className="editor-bar">
        <span className="editor-path" title={filePath}>
          {filePath}
        </span>
        {file?.dirty && <span className="editor-dirty">unsaved</span>}
        <span className="editor-lang">{file?.language ?? ''}</span>
        <button className="btn btn--tiny" disabled={!file?.dirty} onClick={() => void handleSave()}>
          Save
        </button>
        <button
          className="btn btn--tiny"
          disabled={!file?.dirty}
          onClick={async () => {
            const ok = await window.api.dialog.confirm({
              title: 'Discard changes',
              message: `Discard unsaved changes to "${file?.name}"?`,
              confirmLabel: 'Discard'
            })
            if (ok) void revertFile(key)
          }}
        >
          Revert
        </button>
      </div>
      <div className="editor-host" ref={hostRef} />
      {file?.loading && <div className="editor-loading">Loading…</div>}
      {notice && <div className="editor-toast">{notice}</div>}
    </div>
  )
}

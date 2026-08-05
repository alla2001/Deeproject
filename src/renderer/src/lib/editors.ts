import { create } from 'zustand'
import { monaco } from './monaco'

export interface EditorFile {
  /** Dock panel id; also the registry key. */
  key: string
  projectId: string
  /** Project root, used to sandbox every fs call for this file. */
  root: string
  path: string
  name: string
  language: string
  loading: boolean
  dirty: boolean
  error: string | null
  /** mtime we last read or wrote, for external-change detection. */
  savedModified: number
}

interface ModelEntry {
  model: monaco.editor.ITextModel
  /** Monaco version id at the last save; compared to detect a real change. */
  savedVersionId: number
  viewState: monaco.editor.ICodeEditorViewState | null
  subscription: monaco.IDisposable | null
}

const models = new Map<string, ModelEntry>()

interface EditorStore {
  files: Record<string, EditorFile>
  upsert(file: EditorFile): void
  patch(key: string, patch: Partial<EditorFile>): void
  remove(key: string): void
}

export const useEditors = create<EditorStore>((set) => ({
  files: {},
  upsert(file) {
    set((s) => ({ files: { ...s.files, [file.key]: file } }))
  },
  patch(key, patch) {
    set((s) => {
      const existing = s.files[key]
      if (!existing) return s
      return { files: { ...s.files, [key]: { ...existing, ...patch } } }
    })
  },
  remove(key) {
    set((s) => {
      const next = { ...s.files }
      delete next[key]
      return { files: next }
    })
  }
}))

export function editorKey(filePath: string): string {
  return `editor:${filePath.toLowerCase()}`
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

export function getModel(key: string): monaco.editor.ITextModel | null {
  return models.get(key)?.model ?? null
}

export function getViewState(key: string): monaco.editor.ICodeEditorViewState | null {
  return models.get(key)?.viewState ?? null
}

export function setViewState(
  key: string,
  state: monaco.editor.ICodeEditorViewState | null
): void {
  const entry = models.get(key)
  if (entry) entry.viewState = state
}

/**
 * Register a file with the editor store and load its contents. Safe to call
 * again for an already-open file; the existing model is reused so undo history
 * and cursor position survive.
 */
export async function loadFile(projectId: string, root: string, filePath: string): Promise<string> {
  const key = editorKey(filePath)
  const store = useEditors.getState()

  if (models.has(key)) return key

  store.upsert({
    key,
    projectId,
    root,
    path: filePath,
    name: fileName(filePath),
    language: 'plaintext',
    loading: true,
    dirty: false,
    error: null,
    savedModified: 0
  })

  const result = await window.api.fs.read(root, filePath)

  if (!result.ok) {
    store.patch(key, { loading: false, error: result.error, language: result.language })
    return key
  }

  const uri = monaco.Uri.file(filePath.replace(/\\/g, '/'))
  // A model for this uri can linger if the panel was closed and reopened fast.
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(result.content, result.language, uri)
  if (model.getValue() !== result.content) model.setValue(result.content)
  monaco.editor.setModelLanguage(model, result.language)

  const entry: ModelEntry = {
    model,
    savedVersionId: model.getAlternativeVersionId(),
    viewState: null,
    subscription: null
  }
  // Comparing alternative version ids means undoing back to the saved state
  // correctly clears the dirty flag.
  entry.subscription = model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== entry.savedVersionId
    const current = useEditors.getState().files[key]
    if (current && current.dirty !== dirty) useEditors.getState().patch(key, { dirty })
  })
  models.set(key, entry)

  store.patch(key, {
    loading: false,
    error: null,
    language: result.language,
    savedModified: result.modified,
    dirty: false
  })
  return key
}

export async function saveFile(key: string): Promise<{ ok: boolean; error?: string }> {
  const file = useEditors.getState().files[key]
  const entry = models.get(key)
  if (!file || !entry) return { ok: false, error: 'This file is not open.' }

  const content = entry.model.getValue()
  const result = await window.api.fs.write(file.root, file.path, content, file.savedModified)

  if (!result.ok) {
    if (result.conflict) {
      const overwrite = await window.api.dialog.confirm({
        title: 'File changed on disk',
        message: `"${file.name}" was modified outside Deeproject.`,
        detail: 'Saving now will overwrite those changes.',
        confirmLabel: 'Overwrite'
      })
      if (!overwrite) return { ok: false, error: result.error }
      const forced = await window.api.fs.write(file.root, file.path, content, null)
      if (!forced.ok) return { ok: false, error: forced.error }
      entry.savedVersionId = entry.model.getAlternativeVersionId()
      useEditors.getState().patch(key, { dirty: false, savedModified: forced.modified, error: null })
      return { ok: true }
    }
    useEditors.getState().patch(key, { error: result.error ?? 'Could not save.' })
    return { ok: false, error: result.error }
  }

  entry.savedVersionId = entry.model.getAlternativeVersionId()
  useEditors.getState().patch(key, { dirty: false, savedModified: result.modified, error: null })
  return { ok: true }
}

/** Reload from disk, discarding in-editor changes. */
export async function revertFile(key: string): Promise<void> {
  const file = useEditors.getState().files[key]
  const entry = models.get(key)
  if (!file || !entry) return
  const result = await window.api.fs.read(file.root, file.path)
  if (!result.ok) {
    useEditors.getState().patch(key, { error: result.error })
    return
  }
  entry.model.setValue(result.content)
  entry.savedVersionId = entry.model.getAlternativeVersionId()
  useEditors.getState().patch(key, { dirty: false, savedModified: result.modified, error: null })
}

export function disposeFile(key: string): void {
  const entry = models.get(key)
  if (entry) {
    entry.subscription?.dispose()
    entry.model.dispose()
    models.delete(key)
  }
  useEditors.getState().remove(key)
}

export function dirtyFiles(): EditorFile[] {
  return Object.values(useEditors.getState().files).filter((f) => f.dirty)
}

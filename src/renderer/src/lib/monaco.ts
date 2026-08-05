// The full entry point, not `editor.api`: that one ships the bare editor core
// with no language contributions, so Lua/Luau and friends would have no syntax
// highlighting and `languages.typescript` would not exist.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

/**
 * Monaco resolves its language services through this hook. Vite compiles each
 * `?worker` import into a same-origin bundle, which is why the renderer is
 * served over app:// rather than file:// — workers cannot start from an opaque
 * origin.
 */
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

let themeDefined = false

/** Editor theme tuned to match the rest of the app. */
export function ensureTheme(): void {
  if (themeDefined) return
  themeDefined = true
  monaco.editor.defineTheme('deeproject', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5d6678', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'string', foreground: '9ff0ac' },
      { token: 'number', foreground: 'ffdd8f' },
      { token: 'type', foreground: '5fd7d7' },
      { token: 'function', foreground: '9ec1ff' }
    ],
    colors: {
      'editor.background': '#0d1017',
      'editor.foreground': '#d7dce5',
      'editorLineNumber.foreground': '#3b4356',
      'editorLineNumber.activeForeground': '#8b94a7',
      'editor.selectionBackground': '#2c3a55',
      'editor.lineHighlightBackground': '#151a24',
      'editorCursor.foreground': '#7c8cff',
      'editorIndentGuide.background1': '#1c2230',
      'editorWidget.background': '#12161f',
      'editorWidget.border': '#262d3b',
      'editorSuggestWidget.background': '#12161f',
      'input.background': '#171c27',
      'dropdown.background': '#171c27',
      'scrollbarSlider.background': '#262d3b80'
    }
  })

  // The app never type-checks the user's project, so silence the diagnostics
  // Monaco would otherwise report against files it cannot resolve.
  const ts = monaco.languages.typescript
  if (ts) {
    const options = { noSemanticValidation: true, noSyntaxValidation: false }
    ts.typescriptDefaults.setDiagnosticsOptions(options)
    ts.javascriptDefaults.setDiagnosticsOptions(options)
  }
}

export { monaco }

/// <reference types="vite/client" />

/**
 * Vite turns a `?worker` import into a Worker constructor. The stock
 * `vite/client` types only cover bare `*?worker` specifiers, so Monaco's
 * deep paths need declaring explicitly.
 */
declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/esm/vs/language/typescript/ts.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

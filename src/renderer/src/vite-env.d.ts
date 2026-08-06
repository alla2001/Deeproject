/// <reference types="vite/client" />

/**
 * Electron's <webview> is not part of React's JSX catalogue, so the Watch panel
 * needs it declared. Only the attributes actually used are listed.
 */
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
        useragent?: string
      },
      HTMLElement
    >
  }
}

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

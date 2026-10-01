import type { DetailedHTMLProps, HTMLAttributes } from "react"

/*
 * `<webview>`, as the dock's preview uses it.
 *
 * React's JSX table does not know the tag, and Electron's own typing of it
 * (`Electron.WebviewTag`) is in a declaration file that references `node`'s —
 * pulling it into the renderer project would hand every file here Node's
 * globals over the DOM's (`setTimeout` returning a `Timeout`, for one), which
 * is exactly the split the three tsconfigs exist to keep. So the handful of
 * members the preview calls are written out, and nothing else is claimed.
 */
declare global {
  interface WebviewElement extends HTMLElement {
    src: string
    getURL(): string
    getTitle(): string
    loadURL(url: string): Promise<void>
    reload(): void
    stop(): void
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
    capturePage(): Promise<{ toDataURL(): string }>
  }

  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        webview: DetailedHTMLProps<
          HTMLAttributes<WebviewElement>,
          WebviewElement
        > & {
          src?: string
          /** Isolates the page's storage from the studio's own. */
          partition?: string
          allowpopups?: string
        }
      }
    }
  }
}

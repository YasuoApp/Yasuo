import { create } from "zustand"

import { useDock } from "./dock"

/**
 * The dock's `Preview` tab: the page a project's dev server is serving, in a
 * `<webview>` beside the shell that started it.
 *
 * Per **project**, not per shell. A shell is where the server was started, but
 * the page is the project's — two shells in one project do not have two
 * previews — and the tab follows the project the column is on, the way the
 * shells do. Nothing here is written to disk: a dev server's port is this
 * run's, and the one remembered from last week is the one that is wrong now.
 *
 * `suggested` is what a shell's output *said* — the `Local: http://…` line a
 * dev server prints — recorded as an offer rather than opened. A page loading
 * itself because a process printed a URL is a page nobody asked for, and the
 * line is often printed before the server answers.
 */
type PreviewState = {
  /** The URL each project's preview is on, by folder id. */
  urls: Record<string, string>
  /** The dev-server URL last seen in each project's shell output. */
  suggested: Record<string, string>
  /** Opens the dock on the preview. */
  show: () => void
  setUrl: (folderId: string, url: string) => void
  suggest: (folderId: string, url: string) => void
}

export const usePreview = create<PreviewState>((set, get) => ({
  urls: {},
  suggested: {},

  show() {
    useDock.getState().show("preview")
  },

  setUrl(folderId, url) {
    if (get().urls[folderId] === url) return
    set({ urls: { ...get().urls, [folderId]: url } })
  },

  suggest(folderId, url) {
    if (get().suggested[folderId] === url) return
    set({ suggested: { ...get().suggested, [folderId]: url } })
  },
}))

/*
 * CSI sequences (colours, cursor moves) and OSC ones (a title, a hyperlink):
 * a dev server's banner is painted in both, and a URL wrapped in an OSC 8
 * hyperlink has the escape glued to its last character. The control
 * characters are the point of this one, hence the disable.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/*
 * The three ways a dev server names this machine. `0.0.0.0` is the bind
 * address, and Chromium refuses to navigate to it, so a page served there is
 * reached as `localhost`.
 */
const DEV_SERVER =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s"'<>`)\]]*)?/

/** How much of the last chunk is kept to join a URL a pty split in two. */
const CARRY = 256

/**
 * The first dev-server URL in a run of terminal output, as the preview should
 * open it, or null. Trailing punctuation is the sentence's, not the URL's:
 * `http://localhost:3000.` and `(http://localhost:3000)` are both a URL.
 */
export function devServerUrlIn(chunk: string): string | null {
  return scanDevServer("", chunk).url
}

/**
 * `devServerUrlIn` across chunk boundaries: a pty hands output over in pieces
 * it does not cut at a line, so a URL can arrive as `http://local` and
 * `host:5173/`. The tail of what was last read is carried into the next scan,
 * and what has already matched is not — or the same URL is found on every
 * chunk after it.
 */
export function scanDevServer(
  carry: string,
  chunk: string
): { url: string | null; carry: string } {
  const text = (carry + chunk).replace(ANSI, "")
  const match = DEV_SERVER.exec(text)
  if (!match) return { url: null, carry: text.slice(-CARRY) }

  const url = match[0]
    .replace(/[.,;:!?)\]]+$/, "")
    .replace("://0.0.0.0", "://localhost")
  const after = match.index + match[0].length
  return { url, carry: text.slice(after).slice(-CARRY) }
}

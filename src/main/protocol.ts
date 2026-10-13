import path from "node:path"
import { pathToFileURL } from "node:url"

import { net, protocol } from "electron"

import { NOTE_FILE_SCHEME, noteFileNameOf } from "../shared/note-files"
import { PLUGIN_SCHEME, pluginFileOf, type PluginFile } from "../shared/plugins"

/**
 * The origin the built renderer is served from.
 *
 * `file://` would be simpler but is not viable: it has no real origin, so
 * service workers are unavailable — and almostnode's preview depends on one —
 * and storage APIs are restricted. A privileged scheme behaves like `https`
 * without needing a port, and keeps absolute asset paths (`/almostnode/...`)
 * resolving exactly as they do against the dev server.
 */
export const APP_SCHEME = "app"
export const APP_ORIGIN = `${APP_SCHEME}://studio`

/** Must run before `app.whenReady()`, or the privileges are ignored. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        allowServiceWorkers: true,
        stream: true,
      },
    },
    /*
     * A block document's own images, which the renderer loads as an ordinary
     * `img` src.
     *
     * `standard` so the URL parses with a host and a path — the shape
     * `shared/note-files.ts` builds — and `secure` so it is not mixed content
     * on a page served over `app://`, which would have Chromium block the
     * image outright. `stream` because these are the one thing this app serves
     * that can be tens of megabytes.
     */
    {
      scheme: NOTE_FILE_SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
    /*
     * A plugin's `main.js` and `styles.css` — see `servePlugins`.
     *
     * `corsEnabled` and `supportFetchAPI` because the renderer `import()`s the
     * script, and a module is fetched in CORS mode from whatever origin the page
     * is on: `app://studio` in a build, Vite's `http://localhost` in dev.
     */
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

/** Serves the built renderer out of `root`. Call once the app is ready. */
export function serveApp(root: string): void {
  const base = path.resolve(root)

  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url)

    // decodeURIComponent so paths with spaces resolve; `path.join` on the
    // decoded value is what the traversal check below guards.
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "")
    const target = path.resolve(base, relative || "index.html")

    if (target !== base && !target.startsWith(base + path.sep)) {
      return new Response("Forbidden", { status: 403 })
    }

    return net.fetch(pathToFileURL(target).toString())
  })
}

/**
 * Serves the pictures in the workspace's notes.
 *
 * `pathOf` is the store's own `noteFilePath`, which refuses a name that is not
 * one it wrote — this handler answers a URL from a document, and a document is
 * a file on disk that could say anything. Nothing here builds a path from what
 * arrives.
 *
 * `net.fetch` on the file rather than reading it: the response streams, and the
 * content type comes off the extension the same way it does for the renderer's
 * own assets above, so an `img` gets `image/png` without a second mime table
 * in this app.
 *
 * The `Range` header is passed along, and that is not incidental: a `<video>` in
 * a note asks for the head of the file and then for the bytes around wherever
 * the reader drags to, and `net.fetch` given a bare URL sends none of the
 * request's own headers — so a player that could not seek was the failure to
 * avoid here.
 */
export function serveNoteFiles(pathOf: (fileName: string) => string): void {
  protocol.handle(NOTE_FILE_SCHEME, (request) => {
    const name = noteFileNameOf(request.url)
    if (!name) return new Response("Not found", { status: 404 })

    let target: string
    try {
      target = pathOf(name)
    } catch {
      return new Response("Forbidden", { status: 403 })
    }

    const range = request.headers.get("range")
    return net.fetch(
      pathToFileURL(target).toString(),
      range ? { headers: { range } } : undefined
    )
  })
}

/** What a plugin's files are served as. Set rather than left to `net.fetch`'s
 * guess off the extension, because a module script with any other type is
 * refused outright. */
const PLUGIN_TYPES: Record<PluginFile, string> = {
  "main.js": "text/javascript; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
}

/**
 * Serves the plugins' own files, and nothing else under their directories —
 * `pluginFileOf` answers only for `PLUGIN_FILES`, so a plugin's `data.json` is
 * not readable by URL, by it or by any other plugin.
 *
 * `no-store` because the file is somebody's work in progress: Reload in
 * Settings is meant to pick up the edit they just saved, and the `?v=` the
 * renderer adds only gets past the module map, not the HTTP cache.
 */
export function servePlugins(
  pathOf: (id: string, file: PluginFile) => string
): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    const named = pluginFileOf(request.url)
    if (!named) return new Response("Not found", { status: 404 })

    let target: string
    try {
      target = pathOf(named.id, named.file)
    } catch {
      return new Response("Forbidden", { status: 403 })
    }

    const response = await net.fetch(pathToFileURL(target).toString())
    if (!response.ok) return new Response("Not found", { status: 404 })
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": PLUGIN_TYPES[named.file],
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    })
  })
}

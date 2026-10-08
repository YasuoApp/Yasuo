import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import svgLoader from "vite-svg-loader"

import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const EXCALIDRAW_FONTS = fileURLToPath(
  new URL(
    "./node_modules/@excalidraw/excalidraw/dist/prod/fonts",
    import.meta.url
  )
)

/**
 * Serves Excalidraw's own fonts from this app rather than from a CDN.
 *
 * Excalidraw resolves them against `window.EXCALIDRAW_ASSET_PATH` and falls
 * back to esm.sh when that is unset — which is a desktop app quietly reaching
 * the network for a drawing the user has open on a plane, and a set of glyph
 * widths that changes depending on whether it got there. The block editor
 * points that variable at `./excalidraw/`, and this puts the files behind it: read
 * straight out of `node_modules` in dev, emitted into the bundle for a build.
 *
 * Its own plugin rather than a copy into `public/`: `public/` is checked in, and
 * 13MB of vendored woff2 — almost all of it the CJK family, which Excalidraw
 * only fetches the subset it needs of — is not something to keep in git.
 */
function excalidrawFonts(): Plugin {
  const PREFIX = "/excalidraw/fonts/"

  /** Every font file, as paths relative to the fonts directory. */
  async function walk(dir: string, base = ""): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const found = await Promise.all(
      entries.map((entry) => {
        const next = base ? `${base}/${entry.name}` : entry.name
        return entry.isDirectory()
          ? walk(path.join(dir, entry.name), next)
          : Promise.resolve([next])
      })
    )
    return found.flat()
  }

  return {
    name: "excalidraw-fonts",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0]
        if (!url?.startsWith(PREFIX)) return next()

        // Never let a crafted URL walk out of the fonts directory.
        const file = path.join(EXCALIDRAW_FONTS, url.slice(PREFIX.length))
        if (!file.startsWith(EXCALIDRAW_FONTS)) return next()

        readFile(file).then(
          (body) => {
            response.setHeader("Content-Type", "font/woff2")
            response.end(body)
          },
          () => next()
        )
      })
    },

    async generateBundle() {
      for (const name of await walk(EXCALIDRAW_FONTS)) {
        this.emitFile({
          type: "asset",
          fileName: `excalidraw/fonts/${name}`,
          source: await readFile(path.join(EXCALIDRAW_FONTS, name)),
        })
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), svgLoader(), excalidrawFonts()],
  // The renderer is a subdirectory rather than the repository root, so Vite is
  // pointed at it — `index.html` and `public/` live beside the code they belong
  // to instead of beside the main process'.
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  // Absolute, not relative: the packaged app is served from the app:// origin
  // (see src/main/protocol.ts), so root-absolute paths resolve the same way
  // they do against the dev server — which is what the runtime's
  // `/almostnode/...` and `/__sw__.js` URLs rely on.
  base: "/",
  // The browser build in development (`scripts/web.mjs`): the page is Vite's
  // and the calls are the localhost server's, proxied so both share an origin —
  // the server's token check and its `Host` check see the same request either
  // way. Off for the Electron dev run, which has no server to point at.
  server: process.env.YASUO_WEB_API
    ? { proxy: { "/__yasuo": process.env.YASUO_WEB_API } }
    : undefined,
  build: {
    // Out of `src/`, and named to match `dist-electron/` beside it. Vite would
    // otherwise write into `src/renderer/dist`.
    outDir: fileURLToPath(new URL("./dist-renderer", import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
    /*
     * One copy of each of these in the bundle, whatever node_modules looks like.
     *
     * A CodeMirror extension is identified by the object it was built from — a
     * facet, a `ViewPlugin`, a state field — so two copies of `@codemirror/view`
     * are two `EditorView.theme` facets, two `keymap`s and two `Decoration`
     * classes, and an extension from one is silently inert in a view from the
     * other. Nothing errors; the theme just does not apply.
     *
     * This is not hypothetical here. Milkdown depends on the CodeMirror packages
     * too, and this project's install resolves thirteen nested copies of
     * `@codemirror/view` under the other `@codemirror/*` packages — every one of
     * them the same version, which is why nothing upstream considers it a
     * conflict and why `tsc` cannot see it either. The exact-version pin in
     * `package.json` keeps the *versions* from diverging; this keeps the
     * *modules* from being two.
     */
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@lezer/common",
    ],
  },
})

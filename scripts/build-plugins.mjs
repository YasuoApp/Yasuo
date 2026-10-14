import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import * as esbuild from "esbuild"

/**
 * Builds the built-in plugins from `plugins/<id>/` into `dist-plugins/<id>/`.
 *
 * A plugin's source is TypeScript under `src/main.ts`, and it may import the
 * renderer's **pure** modules — `lib/chat/usage.ts` and the like —
 * which are bundled into its `main.js` as a copy. What it must not import is
 * anything holding state (a store, `window.desktop`) or a library the app
 * already loads (Milkdown, CodeMirror): a second copy of a store is a second
 * store, and a second CodeMirror is the trap CLAUDE.md warns about. What it
 * needs from the running app comes through `PluginApp` instead.
 *
 * React is the exception the other way: a plugin imports it like any module,
 * and `sharedModules` below turns that import into a read of the copy the app
 * exposes (`lib/plugins/shared-modules.ts`), since two Reacts in one page are
 * two sets of hooks.
 *
 * `dist-plugins/` is what electron-builder carries as `extraResources` →
 * `plugins/`, and what `main/electron-ipc.ts` reads in dev.
 *
 *   node scripts/build-plugins.mjs [--minify]
 */
const { values } = parseArgs({
  options: { minify: { type: "boolean", default: false } },
})

const SOURCE = "plugins"
const OUT = "dist-plugins"

/** Must name what `exposeSharedModules` puts on the global, and no more. */
const SHARED = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"]
const SHARED_GLOBAL = "__VSCLAUDE_SHARED__"

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * Each shared module as a stand-in that re-exports the app's copy.
 *
 * ES modules cannot export a list decided at run time, so the names are read
 * here, off the same package the app bundles, and written out one by one.
 */
async function sharedModules() {
  const shims = new Map()
  for (const specifier of SHARED) {
    const real = await import(specifier)
    const names = Object.keys(real).filter(
      (name) => name !== "default" && IDENTIFIER.test(name)
    )
    const global = JSON.stringify(SHARED_GLOBAL)
    const key = JSON.stringify(specifier)
    const missing = JSON.stringify(
      "The app does not share " + specifier + " with plugins."
    )
    shims.set(
      specifier,
      [
        "const shared = globalThis[" + global + "]?.[" + key + "]",
        "if (!shared) throw new Error(" + missing + ")",
        "export default shared.default ?? shared",
        "export const { " + names.join(", ") + " } = shared",
      ].join("\n")
    )
  }

  return {
    name: "shared-modules",
    setup(build) {
      // Every import of a React package, checked against the list exactly: a
      // filter spelled out by hand is a second list to forget to update.
      build.onResolve({ filter: /^react(-dom)?(\/|$)/ }, (args) =>
        shims.has(args.path)
          ? { path: args.path, namespace: "shared-module" }
          : undefined
      )
      build.onLoad({ filter: /.*/, namespace: "shared-module" }, (args) => ({
        contents: shims.get(args.path),
        loader: "js",
      }))
    },
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

const shared = await sharedModules()

await rm(OUT, { recursive: true, force: true })

const ids = (await readdir(SOURCE, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)

await Promise.all(
  ids.map(async (id) => {
    const dir = path.join(SOURCE, id)
    const out = path.join(OUT, id)
    await mkdir(out, { recursive: true })

    await esbuild.build({
      entryPoints: [path.join(dir, "src", "main.ts")],
      outfile: path.join(out, "main.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      // For the `@/` and `@shared/` aliases the renderer's modules use.
      tsconfig: "tsconfig.renderer.json",
      plugins: [shared],
      // Read by React's helpers and by nothing else that ends up in a plugin.
      define: {
        "process.env.NODE_ENV": JSON.stringify(
          values.minify ? "production" : "development"
        ),
      },
      minify: values.minify,
      logLevel: "warning",
    })

    await copyFile(
      path.join(dir, "manifest.json"),
      path.join(out, "manifest.json")
    )
    if (await exists(path.join(dir, "styles.css"))) {
      await copyFile(path.join(dir, "styles.css"), path.join(out, "styles.css"))
    }
  })
)

console.log(`built ${ids.length} plugin(s) into ${OUT}/`)

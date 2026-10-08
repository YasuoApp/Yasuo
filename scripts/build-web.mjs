import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import * as esbuild from "esbuild"

/**
 * Bundles the localhost server (`src/server/main.ts`) and the pty daemon into
 * `dist-web/` — the web build's counterpart of `build-electron.mjs`.
 *
 * `electron` is deliberately **not** external here. Nothing the server imports
 * may reach it — that is what `main/host.ts` is for — and leaving it
 * unresolvable turns a stray `import … from "electron"` into a build error
 * rather than a server that dies on its first request.
 *
 * The daemon is built beside the server because `daemon-client.ts` spawns
 * `daemon.cjs` from its own directory, with whatever runtime it is running on.
 *
 *   node scripts/build-web.mjs [--watch] [--minify]
 */
const { values } = parseArgs({
  options: {
    watch: { type: "boolean", default: false },
    minify: { type: "boolean", default: false },
  },
})

const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
)

/** @type {import("esbuild").BuildOptions} */
const shared = {
  outdir: "dist-web",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  // A prebuilt native binary, resolved from node_modules — see
  // `build-electron.mjs`.
  external: ["@lydell/node-pty"],
  sourcemap: true,
  minify: values.minify,
  logLevel: "info",
}

/**
 * The server, which bundles the agent SDK and so needs the same
 * `import.meta.url` banner the Electron main bundle has — see the comment on
 * `main` in `build-electron.mjs`.
 *
 * @type {import("esbuild").BuildOptions}
 */
const server = {
  ...shared,
  entryPoints: { server: "src/server/main.ts" },
  banner: {
    js: `const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
  },
  define: {
    "import.meta.url": "__importMetaUrl",
    __YASUO_VERSION__: JSON.stringify(version),
  },
}

/** @type {import("esbuild").BuildOptions} */
const daemon = {
  ...shared,
  entryPoints: { daemon: "src/main/daemon.ts" },
}

if (values.watch) {
  for (const options of [server, daemon]) {
    const context = await esbuild.context(options)
    await context.watch()
  }
} else {
  await Promise.all([esbuild.build(server), esbuild.build(daemon)])
}

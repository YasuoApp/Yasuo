import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { stripVTControlCharacters } from "node:util"

/**
 * Runs the app in development: the renderer comes from Vite (with hot reload),
 * the main process from a fresh `dist-electron` build.
 *
 * Changes under `src/main/`, `src/preload/` or `src/shared/` need this script
 * restarted — only the renderer hot-reloads. `--hmr=false` turns that off too,
 * and a renderer change then waits for a reload of the window (⌘R).
 *
 *   node scripts/dev.mjs [--hmr=false]
 */
const root = path.join(import.meta.dirname, "..")

/** The workspace's own binaries, rather than whatever is on PATH. */
const bin = (name) => path.join(root, "node_modules", ".bin", name)

/** Matches the URL Vite prints once it is listening. */
const VITE_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?)/

/** Read by `server.hmr` in `vite.config.ts`. */
const hmr = !process.argv.slice(2).includes("--hmr=false")

const children = []
let shuttingDown = false

/**
 * Spawns a child in its own process group so the whole tree can be signalled —
 * Vite starts workers of its own that outlive a bare `kill(pid)`.
 */
function start(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "pipe",
    detached: process.platform !== "win32",
    ...options,
  })
  children.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      if (process.platform === "win32" || child.pid === undefined) {
        child.kill()
      } else {
        process.kill(-child.pid, "SIGTERM")
      }
    } catch {
      // Already dead, or its group is gone; nothing left to signal.
    }
  }

  process.exit(code)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0))
}

// The main process has to exist before Electron can be pointed at it, so this
// build is awaited rather than run alongside the dev server.
await new Promise((resolve, reject) => {
  const build = start("node", ["scripts/build-electron.mjs"], {
    cwd: root,
    stdio: "inherit",
  })
  build.on("close", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`electron build failed (${code})`))
  )
})

// The built-in plugins, once: they are read off `dist-plugins/` when the
// renderer starts, and a plugin being worked on is rebuilt by running this
// script again and pressing Reload in Settings › Plugins.
await new Promise((resolve, reject) => {
  const build = start("node", ["scripts/build-plugins.mjs"], {
    cwd: root,
    stdio: "inherit",
  })
  build.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`plugin build failed (${code})`))
  )
})

// Vite directly, not through `bun run dev`: that script is this file, and it
// would call itself.
const vite = start(bin("vite"), [], {
  cwd: root,
  env: { ...process.env, VSCLAUDE_HMR: String(hmr) },
})

const url = await new Promise((resolve, reject) => {
  let seen = ""

  vite.stdout.setEncoding("utf8")
  vite.stdout.on("data", (chunk) => {
    process.stdout.write(chunk)
    if (seen) return
    // picocolors colours output on win32 even through a pipe, and wraps the
    // port in bold — the URL only matches with the escapes taken out.
    const match = VITE_URL.exec(stripVTControlCharacters(chunk))
    if (match) {
      seen = match[1]
      resolve(seen)
    }
  })

  vite.stderr.setEncoding("utf8")
  vite.stderr.on("data", (chunk) => process.stderr.write(chunk))

  vite.on("close", (code) => {
    if (!seen) reject(new Error(`the dev server exited early (${code})`))
  })
})

const electron = start(bin("electron"), ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})

// Closing the app window ends the session; the dev server has nothing left to
// serve.
electron.on("close", (code) => shutdown(code ?? 0))

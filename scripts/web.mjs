import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import path from "node:path"
import process from "node:process"

/**
 * Runs the browser build in development: the renderer from Vite (with hot
 * reload), the handlers from a fresh `dist-web/server.cjs` on 127.0.0.1, and
 * Vite proxying `/__yasuo` to it so the page and the API share an origin.
 *
 * The web counterpart of `dev.mjs`, and the same rule holds: a change under
 * `src/main/`, `src/server/` or `src/shared/` needs this restarted.
 *
 *   node scripts/web.mjs
 */
const root = path.join(import.meta.dirname, "..")
const bin = (name) => path.join(root, "node_modules", ".bin", name)

const VITE_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?)/
const PORT = process.env.YASUO_WEB_PORT ?? "4317"
// Chosen here rather than by the server, so the URL printed at the end is
// Vite's and still carries it.
const TOKEN =
  process.env.YASUO_WEB_TOKEN || randomBytes(24).toString("base64url")

const children = []
let shuttingDown = false

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
      if (process.platform === "win32" || child.pid === undefined) child.kill()
      else process.kill(-child.pid, "SIGTERM")
    } catch {
      // Already gone.
    }
  }
  // A beat for the server to end its shells and chats — it caps its own
  // cleanup at five seconds.
  setTimeout(() => process.exit(code), 500)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0))
}

await new Promise((resolve, reject) => {
  const build = start("node", ["scripts/build-web.mjs"], {
    cwd: root,
    stdio: "inherit",
  })
  build.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`server build failed (${code})`))
  )
})

const vite = start(bin("vite"), [], {
  cwd: root,
  env: { ...process.env, YASUO_WEB_API: `http://127.0.0.1:${PORT}` },
})

const url = await new Promise((resolve, reject) => {
  let seen = ""
  vite.stdout.setEncoding("utf8")
  vite.stdout.on("data", (chunk) => {
    // Vite's own banner is left out: the URL worth opening is the server's,
    // with the token on it.
    if (seen) process.stdout.write(chunk)
    const match = seen ? null : VITE_URL.exec(chunk)
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

const server = start(
  "node",
  ["dist-web/server.cjs", "--port", PORT, "--page-url", url],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, YASUO_WEB_TOKEN: TOKEN },
  }
)
server.on("close", (code) => shutdown(code ?? 0))
vite.on("close", (code) => shutdown(code ?? 0))

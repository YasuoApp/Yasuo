import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { parseArgs } from "node:util"

import { createIpc } from "../main/ipc"
import { TOKEN_PARAM } from "../shared/wire"
import { eventStreams, requestListener } from "./http"
import { webHost } from "./web-host"

/**
 * Yasuo in a browser tab: the same `ipc.ts` the Electron app runs, answered over
 * HTTP on the loopback interface. What a request is answered with — and the
 * three locks on it — is `http.ts`; this is the process around it.
 *
 *   node dist-web/server.cjs [--port 4317] [--static dist-renderer]
 */
const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.YASUO_WEB_PORT ?? "4317" },
    static: { type: "string" },
    // The dev server's own URL, printed instead of this one: in development
    // Vite serves the page and proxies `/__yasuo` here (`scripts/web.mjs`).
    "page-url": { type: "string" },
  },
})

const PORT = Number(values.port)
/** Loopback and nothing else — the first of the three locks in `http.ts`. */
const HOST = "127.0.0.1"

/** From the environment when the dev script chose it, so it can print the URL
 * Vite will serve; otherwise fresh per start, so a URL leaked into a history
 * file is dead after the next restart. */
const TOKEN =
  process.env.YASUO_WEB_TOKEN || randomBytes(24).toString("base64url")

const events = eventStreams()
const ipc = createIpc(webHost(events.send))

const server = createServer(
  requestListener({
    token: TOKEN,
    handlers: ipc.handlers,
    noteFilePath: ipc.noteFilePath,
    streams: events.streams,
    staticDir: values.static ?? null,
  })
)

/** Keeps each stream open through proxies that close an idle connection. */
const heartbeat = setInterval(() => {
  for (const stream of events.streams) stream.write(": ping\n\n")
}, 25_000)

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${PORT} is taken — set YASUO_WEB_PORT or pass --port.`
      : error
  )
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const page = new URL(values["page-url"] ?? `http://localhost:${PORT}/`)
  page.searchParams.set(TOKEN_PARAM, TOKEN)
  console.log(`\n  Yasuo (web) is running — open:\n\n    ${page.toString()}\n`)
})

/** How long shutdown may take before the server stops waiting — the same
 * bargain `main.ts` makes on quit. */
const CLEANUP_TIMEOUT_MS = 5_000

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat)
  for (const stream of events.streams) stream.end()
  server.close()
  ipc.tsServers.stopAll()
  ipc.watchers.closeAll()
  await Promise.race([
    // The shells and the chats go with the server, as they go with the app.
    Promise.allSettled([ipc.terminals.killAll(), ipc.worktreeChats.dispose()]),
    new Promise((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
  ])
  process.exit(0)
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown())
}

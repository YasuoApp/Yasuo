import { randomUUID } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import net from "node:net"

import { spawn, type IPty } from "@lydell/node-pty"

import {
  isDaemonRequest,
  socketPath,
  type AttachRequest,
  type CreateRequest,
  type KillRequest,
  type ResizeRequest,
  type WriteRequest,
} from "./daemon-protocol"
import { environment, shell } from "./shell-env"

/**
 * Owns every pty for real, outside the Electron app's own lifetime.
 *
 * Spawned by `daemon-client.ts` with `detached: true` and `unref()`'d, so
 * quitting the app does not take this process with it — that is the entire
 * point of it existing as its own file rather than a class inside
 * `electron/terminal.ts`. A session here answers to nobody but an explicit
 * `kill` op or this process's own `SIGTERM`/`SIGINT` (a real shutdown, not a
 * client merely disconnecting — see the bottom of this file).
 *
 * Talks newline-delimited JSON over a Unix socket (a named pipe on Windows),
 * the same buffered-line-splitting `electron/process.ts`'s `stream()`
 * already does for a child process's stdout, applied here to socket chunks
 * instead. There is exactly one of these running per machine at a time.
 */

type Session = {
  pty: IPty
  /** Raw bytes, ANSI escapes included — capped so a session left running for
   * days does not grow this process without bound. */
  backlog: string
  subscribers: Set<net.Socket>
}

/** Enough to reconstruct what a terminal looked like, not a full transcript. */
const MAX_BACKLOG_BYTES = 200_000

/** Long enough to survive a quick app restart reconnecting, short enough
 * that an empty daemon does not linger forever. */
const IDLE_EXIT_MS = 60_000

const sessions = new Map<string, Session>()
let idleTimer: NodeJS.Timeout | undefined

function scheduleIdleExitIfEmpty(): void {
  clearTimeout(idleTimer)
  if (sessions.size > 0) return
  idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS)
  // Node would otherwise wait on this timer as if it were real work.
  idleTimer.unref()
}

function appendBacklog(session: Session, chunk: string): void {
  session.backlog += chunk
  if (session.backlog.length > MAX_BACKLOG_BYTES) {
    session.backlog = session.backlog.slice(-MAX_BACKLOG_BYTES)
  }
}

function broadcast(session: Session, message: unknown): void {
  const line = `${JSON.stringify(message)}\n`
  for (const socket of session.subscribers) socket.write(line)
}

function handleCreate(socket: net.Socket, request: CreateRequest): void {
  const { file, args } = shell(request.command)
  const pty = spawn(file, args, {
    name: "xterm-256color",
    cwd: request.cwd,
    cols: request.cols,
    rows: request.rows,
    env: environment(request.env),
  })

  const id = randomUUID()
  const session: Session = {
    pty,
    backlog: "",
    subscribers: new Set([socket]),
  }
  sessions.set(id, session)
  clearTimeout(idleTimer)

  pty.onData((chunk) => {
    appendBacklog(session, chunk)
    broadcast(session, { type: "data", id, chunk })
  })
  pty.onExit(({ exitCode, signal }) => {
    broadcast(session, { type: "exit", id, exitCode, signal: signal ?? null })
    sessions.delete(id)
    scheduleIdleExitIfEmpty()
  })

  socket.write(
    `${JSON.stringify({ type: "created", reqId: request.reqId, id, pid: pty.pid })}\n`
  )
}

function handleAttach(socket: net.Socket, request: AttachRequest): void {
  const session = sessions.get(request.id)
  if (!session) {
    socket.write(
      `${JSON.stringify({ type: "notFound", reqId: request.reqId, id: request.id })}\n`
    )
    return
  }
  session.subscribers.add(socket)
  socket.write(
    `${JSON.stringify({
      type: "attached",
      reqId: request.reqId,
      id: request.id,
      backlog: session.backlog,
    })}\n`
  )
}

function handleWrite(request: WriteRequest): void {
  sessions.get(request.id)?.pty.write(request.data)
}

function handleResize(request: ResizeRequest): void {
  if (request.cols < 1 || request.rows < 1) return
  try {
    sessions.get(request.id)?.pty.resize(request.cols, request.rows)
  } catch {
    // The pty exited between the lookup and the resize.
  }
}

function handleKill(request: KillRequest): void {
  try {
    sessions.get(request.id)?.pty.kill()
  } catch {
    // Already gone — its own `onExit` will have cleaned it up.
  }
}

function handleConnection(socket: net.Socket): void {
  let buffered = ""
  socket.setEncoding("utf8")

  socket.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isDaemonRequest(parsed)) continue

      switch (parsed.op) {
        case "create":
          handleCreate(socket, parsed)
          break
        case "attach":
          handleAttach(socket, parsed)
          break
        case "write":
          handleWrite(parsed)
          break
        case "resize":
          handleResize(parsed)
          break
        case "kill":
          handleKill(parsed)
          break
      }
    }
  })

  // A connection going away — the app quitting, most of all — unsubscribes
  // it from every session's output without touching the session itself.
  socket.on("close", () => {
    for (const session of sessions.values()) session.subscribers.delete(socket)
  })
  socket.on("error", () => {
    // The client vanished mid-write; `close` follows and does the cleanup.
  })
}

function main(): void {
  const target = socketPath()

  // A file left behind by a daemon that was killed uncleanly, rather than
  // one that exited on its own — `listen` refuses to bind over it otherwise.
  if (process.platform !== "win32" && existsSync(target)) {
    try {
      unlinkSync(target)
    } catch {
      // Raced with something else cleaning it up first.
    }
  }

  const server = net.createServer(handleConnection)
  server.listen(target)

  scheduleIdleExitIfEmpty()

  // The OS/user actually asking this process to stop — unlike a client
  // disconnecting, every pty goes with it.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      for (const session of sessions.values()) {
        try {
          session.pty.kill()
        } catch {
          // Already gone.
        }
      }
      process.exit(0)
    })
  }
}

main()

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import net from "node:net"
import path from "node:path"

import {
  isDaemonMessage,
  socketPath,
  type AttachRequest,
  type CreateRequest,
  type DaemonMessage,
  type KillRequest,
  type ResizeRequest,
  type WriteRequest,
} from "./daemon-protocol"

/**
 * What to run, and where — a working directory, and an optional command to
 * run instead of dropping the user at a prompt, which is how an agent
 * session gets a CLI rather than a shell.
 */
export type TerminalTarget = {
  cwd: string
  command?: string
  /** A shell other than the user's default — one of `shells.ts`'s profiles.
   * Ignored when `command` is given. */
  shell?: { file: string; args: string[] }
  /** The project's own environment, e.g. its Node on the PATH. */
  env?: Record<string, string>
}

type Emit = {
  data: (event: { terminalId: string; chunk: string }) => void
  exit: (event: {
    terminalId: string
    exitCode: number
    signal: number | null
  }) => void
}

/** Once connected, how long a `create`/`attach` may take before giving up —
 * generous, since the daemon itself may still be starting up. */
const REQUEST_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 5_000
/** How many times to retry connecting after spawning the daemon, and how far
 * apart — a cold start is fast, but not instant. */
const SPAWN_RETRY_ATTEMPTS = 20
const SPAWN_RETRY_DELAY_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The main process's side of the daemon in `daemon.ts`.
 *
 * One socket connection for the app's whole lifetime, established lazily and
 * reconnected (spawning a fresh daemon if none answers) on demand — most of
 * this app's life has no terminal open at all, so there is nothing to keep
 * warm ahead of time.
 */
export class DaemonClient {
  private socket: net.Socket | null = null
  private connecting: Promise<net.Socket> | null = null
  private buffered = ""
  private readonly pending = new Map<
    string,
    {
      resolve: (message: DaemonMessage) => void
      reject: (error: Error) => void
    }
  >()

  constructor(private readonly emit: Emit) {}

  private async connection(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connect(): Promise<net.Socket> {
    try {
      return await this.tryConnect()
    } catch {
      await this.spawnDaemon()
      return this.connectWithRetry()
    }
  }

  private async connectWithRetry(): Promise<net.Socket> {
    let lastError: unknown
    for (let attempt = 0; attempt < SPAWN_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.tryConnect()
      } catch (error) {
        lastError = error
        await sleep(SPAWN_RETRY_DELAY_MS)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Could not reach the agent daemon after starting it.")
  }

  private tryConnect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath())
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(new Error("Timed out connecting to the agent daemon."))
      }, CONNECT_TIMEOUT_MS)

      socket.once("connect", () => {
        clearTimeout(timeout)
        this.wire(socket)
        resolve(socket)
      })
      socket.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  /** Starts a fresh daemon the same way `electron/terminal.ts` has always
   * started its own pty children: as the Electron binary running as plain
   * Node, detached and unref'd so it outlives this process. */
  private async spawnDaemon(): Promise<void> {
    const daemonPath = path.join(__dirname, "daemon.cjs")
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    })
    child.unref()
  }

  private wire(socket: net.Socket): void {
    this.socket = socket
    this.buffered = ""
    socket.setEncoding("utf8")

    socket.on("data", (chunk: string) => {
      this.buffered += chunk
      const lines = this.buffered.split("\n")
      this.buffered = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (isDaemonMessage(parsed)) this.onMessage(parsed)
      }
    })

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null
      // Nothing still waiting on this connection is getting an answer —
      // the daemon crashed, or the connection merely dropped. Either way a
      // caller should see a rejection rather than hang.
      for (const [reqId, waiter] of this.pending) {
        waiter.reject(new Error("Lost connection to the agent daemon."))
        this.pending.delete(reqId)
      }
    })
    // `close` follows and does the cleanup; nothing extra needed here.
    socket.on("error", () => {})
  }

  private onMessage(message: DaemonMessage): void {
    switch (message.type) {
      case "created":
      case "attached":
      case "notFound": {
        const waiter = this.pending.get(message.reqId)
        if (!waiter) break
        this.pending.delete(message.reqId)
        waiter.resolve(message)
        break
      }
      case "data":
        this.emit.data({ terminalId: message.id, chunk: message.chunk })
        break
      case "exit":
        this.emit.exit({
          terminalId: message.id,
          exitCode: message.exitCode,
          signal: message.signal,
        })
        break
    }
  }

  private async request(
    payload: CreateRequest | AttachRequest
  ): Promise<DaemonMessage> {
    const socket = await this.connection()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(payload.reqId)
        reject(new Error("The agent daemon did not answer in time."))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(payload.reqId, {
        resolve: (message) => {
          clearTimeout(timeout)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      socket.write(`${JSON.stringify(payload)}\n`)
    })
  }

  async create(
    target: TerminalTarget,
    cols: number,
    rows: number
  ): Promise<{ id: string; pid: number | null }> {
    const message = await this.request({
      op: "create",
      reqId: randomUUID(),
      cwd: target.cwd,
      command: target.command,
      shell: target.shell,
      env: target.env,
      cols,
      rows,
    })
    if (message.type !== "created") {
      throw new Error("Unexpected response creating a session.")
    }
    return { id: message.id, pid: message.pid ?? null }
  }

  /** `null` means the daemon does not know this id — the caller falls back
   * to `create`, the same as if this session had never existed. */
  async attach(id: string): Promise<string | null> {
    const message = await this.request({
      op: "attach",
      reqId: randomUUID(),
      id,
    })
    if (message.type === "notFound") return null
    if (message.type !== "attached") {
      throw new Error("Unexpected response attaching to a session.")
    }
    return message.backlog
  }

  async write(id: string, data: string): Promise<void> {
    const socket = await this.connection()
    const request: WriteRequest = { op: "write", id, data }
    socket.write(`${JSON.stringify(request)}\n`)
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const socket = await this.connection()
    const request: ResizeRequest = { op: "resize", id, cols, rows }
    socket.write(`${JSON.stringify(request)}\n`)
  }

  async kill(id: string): Promise<void> {
    const socket = await this.connection()
    const request: KillRequest = { op: "kill", id }
    socket.write(`${JSON.stringify(request)}\n`)
  }
}

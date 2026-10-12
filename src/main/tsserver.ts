import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import type { TsDefinition, TsHover } from "../shared/api"

/**
 * What makes hovering an import say something.
 *
 * Nothing in the renderer can see past the file in front of it. The editor
 * parses that file — enough to colour it, fold it and match its brackets — and
 * knows nothing of `tsconfig.json`, `node_modules`, or any other file in the
 * repository, so hovering an import says nothing and go-to-definition on it goes
 * nowhere. What answers those properly is a TypeScript *server*, which is why
 * one runs here. It was true when the editor was Monaco, whose bundled
 * TypeScript worker knew exactly one file; it is more true now that the editor
 * is CodeMirror and there is no worker at all.
 *
 * **tsserver directly, not a language server.** `typescript-language-server` is
 * a translation layer over exactly this process, and translating LSP into
 * tsserver's own protocol only to translate it back into the editor's own hover
 * and definition sources is
 * a dependency to carry, install and keep in step for no answer it could give
 * that this cannot. tsserver's protocol is newline-delimited JSON in and
 * `Content-Length`-framed JSON out — the whole client is the file you are
 * reading.
 *
 * **The folder's own TypeScript, and no other.** A repository pinned to 5.4
 * should be read by 5.4: its `tsconfig.json` may use options a different version
 * rejects, and the types it resolves are the ones its own compiler resolves. A
 * folder with no `typescript` in its `node_modules` gets no hovers and no
 * go-to-definition, which is deliberate — shipping a copy would add forty
 * megabytes to the download to serve a project that, having no TypeScript
 * installed, has no types to resolve either. It is the same bargain the
 * Terminal panel makes with the `claude` CLI: use what the machine has.
 */

/** How long a request waits before it is given up on. tsserver answers a
 * hover in milliseconds; a wait this long means it is loading a project, and
 * the answer is no longer wanted by then anyway. */
const REQUEST_TIMEOUT_MS = 8_000

/**
 * The `tsserver.js` a folder is read by — its own, or none.
 *
 * Only the folder's top-level `node_modules`. A monorepo that installs
 * TypeScript per package rather than at its root is the one case this misses,
 * and adding that folder to the workspace directly is the answer to it: the
 * workspace holds any number of folders precisely so that the thing being
 * worked in can be the thing pointed at.
 */
export function tsServerPathFor(folder: string): string | null {
  const own = path.join(
    folder,
    "node_modules",
    "typescript",
    "lib",
    "tsserver.js"
  )
  return existsSync(own) ? own : null
}

type PendingRequest = {
  resolve: (body: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One tsserver, for one workspace folder.
 *
 * Per folder rather than one for the workspace because a project root is what
 * tsserver reasons in: two repositories open at once have two `tsconfig.json`,
 * two sets of dependencies and, quite possibly, two TypeScript versions.
 */
class TsServer {
  private child: ChildProcess | null = null
  private buffer = Buffer.alloc(0)
  private seq = 0
  private readonly pending = new Map<number, PendingRequest>()
  /** Files handed over with their unsaved text, so `close` can be honest about
   * what was opened. */
  private readonly open = new Set<string>()

  constructor(
    private readonly folder: string,
    private readonly serverPath: string,
    private readonly node: string
  ) {}

  private start(): ChildProcess {
    if (this.child && !this.child.killed) return this.child

    /*
     * `--disableAutomaticTypingAcquisition` is not an optimisation: left on,
     * tsserver reaches for the network and installs `@types/*` packages into a
     * cache directory of its own, on behalf of a user who asked to look at a
     * file. The studio does not install things nobody asked for.
     */
    const child = spawn(
      this.node,
      [
        this.serverPath,
        "--disableAutomaticTypingAcquisition",
        "--useInferredProjectPerProjectRoot",
      ],
      {
        cwd: this.folder,
        // The same trick the pty daemon is started with: Electron's own binary
        // as a plain Node, so nothing depends on what is installed on the
        // machine. Ignored by any other runtime — see `node` on `TsServers`.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      }
    )

    child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk))
    // tsserver's own diagnostics about itself. Not forwarded anywhere: a
    // project that fails to load is a hover that says nothing, which is the
    // same as the studio had before this existed.
    child.stderr?.on("data", () => {})
    child.on("exit", () => this.forget())

    this.child = child
    return child
  }

  /** Drops everything that belonged to a process that is no longer there, so
   * the next request starts a fresh one rather than waiting on a dead pipe. */
  private forget() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("The TypeScript server stopped."))
    }
    this.pending.clear()
    this.open.clear()
    this.child = null
  }

  /**
   * Reassembles `Content-Length`-framed JSON.
   *
   * A read can land mid-header, mid-body, or carry three messages at once —
   * this is a socket, not a stream of messages — so the buffer is drained in a
   * loop and whatever is left is kept for the next chunk. The same shape as the
   * daemon's newline-delimited reader in `daemon-client.ts`, and broken by the
   * same thing if it were written naively.
   */
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])

    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) return

      const header = this.buffer.subarray(0, headerEnd).toString("utf8")
      const length = /Content-Length: (\d+)/i.exec(header)?.[1]
      if (length === undefined) {
        // A header with no length is one this client cannot follow; dropping
        // it is better than stalling on it forever.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }

      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + Number(length)
      if (this.buffer.length < bodyEnd) return

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")
      this.buffer = this.buffer.subarray(bodyEnd)

      try {
        this.dispatch(JSON.parse(body) as Record<string, unknown>)
      } catch {
        // Malformed JSON from tsserver is not something to crash the studio
        // over: the request it belonged to times out and the hover says
        // nothing.
      }
    }
  }

  private dispatch(message: Record<string, unknown>) {
    if (message.type !== "response") return

    const request = this.pending.get(message.request_seq as number)
    if (!request) return
    this.pending.delete(message.request_seq as number)
    clearTimeout(request.timer)

    // `success: false` is an ordinary answer — "there is no quick info here" —
    // rather than a failure worth reporting.
    request.resolve(message.success === true ? message.body : null)
  }

  private send(command: string, args: unknown, seq: number) {
    const child = this.start()
    child.stdin?.write(
      `${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`
    )
  }

  /** A command with an answer. */
  private request(command: string, args: unknown): Promise<unknown> {
    const seq = (this.seq += 1)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve(null)
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(seq, { resolve, reject, timer })
      this.send(command, args, seq)
    })
  }

  /** A command with no answer — the document sync ones. */
  private notify(command: string, args: unknown) {
    this.send(command, args, (this.seq += 1))
  }

  openFile(file: string, text: string) {
    this.notify("open", {
      file,
      fileContent: text,
      projectRootPath: this.folder,
    })
    this.open.add(file)
  }

  /**
   * The file as it stands in the editor, unsaved edits included.
   *
   * Whole-file rather than a range: tsserver's `change` takes a span, and
   * computing one from what the editor reports would mean holding a second copy
   * of the document here to diff against. The files people read are small enough
   * that the copy is cheaper than the bookkeeping — and `reload` with content
   * is exactly what it is for.
   */
  changeFile(file: string, text: string) {
    if (!this.open.has(file)) {
      this.openFile(file, text)
      return
    }
    this.notify("updateOpen", {
      changedFiles: [
        {
          fileName: file,
          textChanges: [
            {
              // The whole document, addressed the only way tsserver takes:
              // from the start to a point past any possible end.
              start: { line: 1, offset: 1 },
              end: { line: 1_000_000, offset: 1 },
              newText: text,
            },
          ],
        },
      ],
    })
  }

  closeFile(file: string) {
    if (!this.open.delete(file)) return
    this.notify("close", { file })
  }

  async hover(
    file: string,
    line: number,
    offset: number
  ): Promise<TsHover | null> {
    const body = (await this.request("quickinfo", {
      file,
      line,
      offset,
    })) as {
      displayString?: string
      documentation?: string
      tags?: { name: string; text?: string }[]
    } | null

    if (!body?.displayString) return null
    return {
      signature: body.displayString,
      documentation: body.documentation ?? "",
      tags: (body.tags ?? []).map((tag) => ({
        name: tag.name,
        text: tag.text ?? "",
      })),
    }
  }

  async definition(
    file: string,
    line: number,
    offset: number
  ): Promise<TsDefinition[]> {
    const body = (await this.request("definitionAndBoundSpan", {
      file,
      line,
      offset,
    })) as {
      definitions?: { file: string; start: { line: number; offset: number } }[]
    } | null

    return (body?.definitions ?? []).map((definition) => ({
      path: definition.file,
      line: definition.start.line,
      column: definition.start.offset,
    }))
  }

  stop() {
    this.child?.kill()
    this.forget()
  }
}

/**
 * The servers, one per workspace folder, started when a file in that folder is
 * first opened.
 *
 * Nothing starts at launch: a studio that spent a run in the Database panel
 * never reads a `.ts` file, and a tsserver loading a monorepo is not a cost to
 * pay on the chance that somebody might.
 */
export class TsServers {
  private readonly servers = new Map<string, TsServer>()

  /**
   * `folders` is read afresh on every call — a folder can leave the workspace
   * between one hover and the next.
   *
   * `node` is what tsserver itself is run on, and is a parameter for the sake
   * of the one caller that is not the studio. In the app it is Electron's own
   * binary, run as plain Node; under `bun test/tsserver.ts` the same default
   * would be *bun*, which is a different runtime altogether — and tsserver
   * leans on `fs.realpathSync`, directory enumeration and `package.json` reads
   * to resolve a module, which is exactly the ground a compatibility layer is
   * thinnest on. The test passing a real `node` is what keeps it testing the
   * thing that ships rather than a runtime the studio never spawns.
   */
  constructor(
    private readonly folders: () => Promise<string[]>,
    private readonly node: string = process.execPath
  ) {}

  /** The server whose folder holds this file, starting it if need be, or null
   * when the file is in no folder or no TypeScript can be found for it. */
  private async serverFor(file: string): Promise<TsServer | null> {
    const folders = await this.folders()
    // The longest match, so a folder nested inside another one is read by its
    // own project rather than by the one above it.
    const folder = folders
      .filter(
        (candidate) =>
          file === candidate || file.startsWith(candidate + path.sep)
      )
      .sort((a, b) => b.length - a.length)[0]
    if (folder === undefined) return null

    const existing = this.servers.get(folder)
    if (existing) return existing

    const serverPath = tsServerPathFor(folder)
    if (serverPath === null) return null

    const server = new TsServer(folder, serverPath, this.node)
    this.servers.set(folder, server)
    return server
  }

  async open(file: string, text: string): Promise<void> {
    ;(await this.serverFor(file))?.openFile(file, text)
  }

  async change(file: string, text: string): Promise<void> {
    ;(await this.serverFor(file))?.changeFile(file, text)
  }

  async close(file: string): Promise<void> {
    ;(await this.serverFor(file))?.closeFile(file)
  }

  async hover(
    file: string,
    line: number,
    offset: number
  ): Promise<TsHover | null> {
    const server = await this.serverFor(file)
    return server ? server.hover(file, line, offset) : null
  }

  async definition(
    file: string,
    line: number,
    offset: number
  ): Promise<TsDefinition[]> {
    const server = await this.serverFor(file)
    return server ? server.definition(file, line, offset) : []
  }

  /** Every server, on the way out. Synchronous: these are child processes with
   * nothing to flush. */
  stopAll(): void {
    for (const server of this.servers.values()) server.stop()
    this.servers.clear()
  }
}

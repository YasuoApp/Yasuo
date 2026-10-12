import { timingSafeEqual } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http"
import path from "node:path"

import type { Handler } from "../main/ipc"
import { contentTypeOf } from "../shared/note-files"
import {
  decodeWire,
  encodeWire,
  TOKEN_HEADER,
  TOKEN_PARAM,
  WIRE_PREFIX,
} from "../shared/wire"

/**
 * The web build's HTTP side — what a request is answered with, kept apart from
 * the `listen()` in `main.ts` so `test/web-server.ts` can drive it with no
 * socket at all.
 *
 * **What this server is, security-wise, is the whole design.** Every call it
 * answers is one the app makes freely: run a `claude` with full access, open a
 * shell, write any file in the workspace. A page that could reach it could do
 * all of that — and every web page the user has open can send a request to
 * `127.0.0.1`. So three locks, each covering a hole the others leave:
 *
 * 1. It listens on loopback only (`main.ts`), so nothing off the machine
 *    reaches it.
 * 2. Every API request carries a **token** printed at startup — in a custom
 *    header for calls, which also forces a CORS preflight this server never
 *    answers, so another origin cannot even fire one blind.
 * 3. The `Host` header must name loopback, which is what stops DNS rebinding:
 *    `evil.example` re-pointed at 127.0.0.1 is same-origin to the attacker's
 *    page, and the token is the only thing it would then lack — this refuses it
 *    before the token is looked at. A call's `Origin`, when it has one, is held
 *    to the same.
 *
 * The static renderer is served without the token: it is the same bundle the
 * app ships, and nothing in it is a secret.
 */

/** The largest call body accepted — a note file's ceiling (64MB) as base64,
 * with room for the envelope. */
const MAX_BODY = 96 * 1024 * 1024

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

/** Every connected tab's event stream, and the host's `send` onto all of them. */
export function eventStreams() {
  const streams = new Set<ServerResponse>()
  return {
    streams,
    send(channel: string, payload: unknown): void {
      if (streams.size === 0) return
      const frame = `data: ${encodeWire({ channel, payload })}\n\n`
      for (const stream of streams) stream.write(frame)
    },
  }
}

/** The hostname out of a `Host` or `Origin` value, or null if it does not
 * parse — which is refused. */
function hostnameOf(value: string | undefined, origin: boolean): string | null {
  if (!value) return null
  try {
    return new URL(origin ? value : `http://${value}`).hostname
  } catch {
    return null
  }
}

function refuse(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
  response.end(message)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > MAX_BODY) throw new Error("Request too large.")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** One file with a `Range` honoured — a `<video>` in a note seeks with it. */
async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  type: string
) {
  const { size } = await stat(file)
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "")
  if (range && (range[1] || range[2])) {
    const start = range[1]
      ? Number(range[1])
      : Math.max(0, size - Number(range[2]))
    const end =
      range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` })
      response.end()
      return
    }
    response.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    })
    createReadStream(file, { start, end }).pipe(response)
    return
  }
  response.writeHead(200, {
    "content-type": type,
    "content-length": size,
    "accept-ranges": "bytes",
  })
  createReadStream(file).pipe(response)
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
}

export function requestListener(options: {
  token: string
  handlers: Map<string, Handler>
  /** The store's own `noteFilePath`, which refuses a name it did not write. */
  noteFilePath: (fileName: string) => string
  streams: Set<ServerResponse>
  /** The built renderer, or null when Vite serves it (`scripts/web.mjs`). */
  staticDir: string | null
}): RequestListener {
  const tokenBytes = Buffer.from(options.token)
  const staticDir = options.staticDir ? path.resolve(options.staticDir) : null

  const tokenMatches = (candidate: string | null | undefined): boolean => {
    if (!candidate) return false
    const bytes = Buffer.from(candidate)
    return (
      bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes)
    )
  }

  /*
   * A call. Its failure is an answer rather than a status: the renderer's
   * `invoke` turns `{ error }` into the same rejection an Electron handler's
   * throw becomes, with the same message.
   */
  async function invoke(request: IncomingMessage, response: ServerResponse) {
    const call = decodeWire<{ channel: string; args: unknown[] }>(
      await readBody(request)
    )
    const handler = options.handlers.get(call.channel)
    let body: string
    try {
      if (!handler) {
        throw new Error(`No handler registered for '${call.channel}'`)
      }
      body = encodeWire({ value: await handler(undefined, ...call.args) })
    } catch (error) {
      body = encodeWire({
        error: error instanceof Error ? error.message : String(error),
      })
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    response.end(body)
  }

  function events(request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Tells a buffering proxy — Vite's, in development — to pass each frame
      // through as it comes.
      "x-accel-buffering": "no",
    })
    response.write(": connected\n\n")
    options.streams.add(response)
    request.on("close", () => options.streams.delete(response))
  }

  async function noteFile(
    request: IncomingMessage,
    response: ServerResponse,
    name: string
  ) {
    let file: string
    try {
      file = options.noteFilePath(name)
    } catch {
      return refuse(response, 403, "Forbidden")
    }
    await sendFile(
      request,
      response,
      file,
      contentTypeOf(name) ?? "application/octet-stream"
    )
  }

  async function staticFile(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string
  ) {
    if (!staticDir) return refuse(response, 404, "Not found")
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "")
    let target = path.resolve(staticDir, relative || "index.html")
    // Never let a crafted URL walk out of the bundle.
    if (target !== staticDir && !target.startsWith(staticDir + path.sep)) {
      return refuse(response, 403, "Forbidden")
    }
    try {
      if ((await stat(target)).isDirectory()) {
        target = path.join(target, "index.html")
      }
    } catch {
      // An app route rather than a file: the page decides what it means.
      target = path.join(staticDir, "index.html")
    }
    const type =
      STATIC_TYPES[path.extname(target).toLowerCase()] ??
      "application/octet-stream"
    if (type.startsWith("text/html")) {
      response.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
      })
      response.end(await readFile(target))
      return
    }
    await sendFile(request, response, target, type)
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    if (!LOOPBACK.has(hostnameOf(request.headers.host, false) ?? "")) {
      return refuse(response, 403, "Forbidden host")
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (!url.pathname.startsWith(`${WIRE_PREFIX}/`)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return refuse(response, 405, "Method not allowed")
      }
      return staticFile(request, response, url.pathname)
    }

    // A call from a page is from *some* origin; it has to be this machine.
    const origin = request.headers.origin
    if (origin && !LOOPBACK.has(hostnameOf(origin, true) ?? "")) {
      return refuse(response, 403, "Forbidden origin")
    }

    const header = request.headers[TOKEN_HEADER]
    const token =
      (typeof header === "string" ? header : null) ??
      url.searchParams.get(TOKEN_PARAM)
    if (!tokenMatches(token)) return refuse(response, 401, "Bad token")

    const api = url.pathname.slice(WIRE_PREFIX.length)
    if (api === "/invoke" && request.method === "POST") {
      return invoke(request, response)
    }
    if (api === "/events" && request.method === "GET") {
      return events(request, response)
    }
    if (api.startsWith("/note-file/") && request.method === "GET") {
      return noteFile(
        request,
        response,
        decodeURIComponent(api.slice("/note-file/".length))
      )
    }
    return refuse(response, 404, "Not found")
  }

  return (request, response) => {
    route(request, response).catch((error: unknown) => {
      console.error(error)
      if (!response.headersSent) refuse(response, 500, "Internal error")
      else response.end()
    })
  }
}

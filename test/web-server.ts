import { mkdtemp, rm, writeFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough, Readable } from "node:stream"

import type { Handler } from "../src/main/ipc"
import { eventStreams, requestListener } from "../src/server/http"
import { decodeWire, encodeWire, TOKEN_HEADER } from "../src/shared/wire"
import { check, finish, section } from "./harness"

/**
 * The web server's locks, driven without a socket.
 *
 * Worth a test because what it guards is the whole machine: a request that
 * slips past is a `claude` with full access, a shell, a write anywhere in the
 * workspace — and each of the locks fails *open* when it is wrong, with nothing
 * on screen to say so. So every one of them is checked to refuse, and a call
 * that passes all three is checked to arrive intact.
 */

const TOKEN = "s3cret-token"

type Answer = { status: number; headers: Record<string, unknown>; body: string }

const dir = await mkdtemp(path.join(tmpdir(), "yasuo-web-"))
await writeFile(path.join(dir, "index.html"), "<html>studio</html>")
await writeFile(path.join(dir, "app.js"), "console.log(1)")
await writeFile(path.join(dir, "picture.png"), "0123456789")

const seen: unknown[][] = []
const handlers = new Map<string, Handler>([
  [
    "echo",
    (_caller, ...args) => {
      seen.push(args)
      return { args }
    },
  ],
  [
    "fails",
    () => {
      throw new Error("refused on purpose")
    },
  ],
])

const events = eventStreams()
const listener = requestListener({
  token: TOKEN,
  handlers,
  noteFilePath: (name) => {
    if (name !== "picture.png") throw new Error("not ours")
    return path.join(dir, name)
  },
  streams: events.streams,
  staticDir: dir,
})

/** One request through the listener, answered in full. */
function request(options: {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** Resolve on the first chunk rather than the end — an event stream never
   * ends. */
  stream?: boolean
}): Promise<Answer> {
  const incoming = Readable.from(
    options.body ? [Buffer.from(options.body)] : []
  ) as unknown as IncomingMessage
  Object.assign(incoming, {
    method: options.method ?? "GET",
    url: options.url,
    headers: { host: "127.0.0.1:4317", ...options.headers },
  })

  const response = new PassThrough()
  const answer: Answer = { status: 0, headers: {}, body: "" }
  Object.assign(response, {
    headersSent: false,
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      answer.status = status
      answer.headers = headers
      Object.assign(response, { headersSent: true })
      return response
    },
  })

  return new Promise((resolve) => {
    response.on("data", (chunk: Buffer) => {
      answer.body += chunk.toString()
      if (options.stream) resolve(answer)
    })
    response.on("end", () => resolve(answer))
    listener(incoming, response as unknown as ServerResponse)
  })
}

const call = (
  channel: string,
  args: unknown[],
  headers: Record<string, string> = { [TOKEN_HEADER]: TOKEN }
) =>
  request({
    method: "POST",
    url: "/__yasuo/invoke",
    headers,
    body: encodeWire({ channel, args }),
  })

section("the Host lock")
{
  const rebound = await request({
    url: "/__yasuo/events?token=" + TOKEN,
    headers: { host: "evil.example:4317" },
  })
  check("a rebound hostname is refused", rebound.status === 403, rebound)

  const page = await request({
    url: "/",
    headers: { host: "evil.example" },
  })
  check("even for the static page", page.status === 403, page)

  const ipv6 = await request({ url: "/", headers: { host: "[::1]:4317" } })
  check("[::1] is loopback", ipv6.status === 200, ipv6.status)
}

section("the token lock")
{
  const none = await call("echo", [1], {})
  check("no token is 401", none.status === 401, none)

  const wrong = await call("echo", [1], { [TOKEN_HEADER]: "s3cret-tokem" })
  check("a wrong token is 401", wrong.status === 401, wrong)

  const longer = await call("echo", [1], { [TOKEN_HEADER]: TOKEN + "x" })
  check("a longer one is 401, not a throw", longer.status === 401, longer)

  check("nothing reached a handler", seen.length === 0, seen)
}

section("the Origin lock")
{
  const foreign = await call("echo", [1], {
    [TOKEN_HEADER]: TOKEN,
    origin: "https://evil.example",
  })
  check("a foreign origin is refused", foreign.status === 403, foreign)

  const vite = await call("echo", [1], {
    [TOKEN_HEADER]: TOKEN,
    origin: "http://localhost:5173",
  })
  check("the dev server's origin passes", vite.status === 200, vite)
}

section("a call that passes")
{
  seen.length = 0
  const bytes = new Uint8Array([1, 2, 3])
  const answer = await call("echo", ["a", undefined, bytes])
  const value = decodeWire<{ value: { args: unknown[] } }>(answer.body).value
  check("is answered", answer.status === 200, answer)
  check("arguments arrive as sent", seen[0]?.length === 3, seen)
  check("undefined stays undefined", seen[0]?.[1] === undefined)
  check("bytes stay bytes", seen[0]?.[2] instanceof Uint8Array)
  check(
    "and come back the same way",
    value.args[2] instanceof Uint8Array && value.args[2][2] === 3
  )

  const failed = decodeWire<{ error?: string }>((await call("fails", [])).body)
  check("a throw is an error answer", failed.error === "refused on purpose")

  const unknown = decodeWire<{ error?: string }>((await call("nope", [])).body)
  check(
    "an unknown channel says so",
    unknown.error?.includes("No handler") === true,
    unknown
  )
}

section("events")
{
  const opened = await request({
    url: `/__yasuo/events?token=${TOKEN}`,
    stream: true,
  })
  check("the stream opens with the token in the query", opened.status === 200)
  check("one stream is held", events.streams.size === 1)
}

section("files")
{
  const picture = await request({
    url: `/__yasuo/note-file/picture.png?token=${TOKEN}`,
  })
  check("a note file is served", picture.body === "0123456789", picture)

  const ranged = await request({
    url: `/__yasuo/note-file/picture.png?token=${TOKEN}`,
    headers: { range: "bytes=2-4" },
  })
  check(
    "with a range honoured",
    ranged.status === 206 && ranged.body === "234",
    ranged
  )

  const foreign = await request({
    url: `/__yasuo/note-file/..%2Fetc%2Fpasswd?token=${TOKEN}`,
  })
  check("a name the store refuses is 403", foreign.status === 403, foreign)

  const unauth = await request({ url: "/__yasuo/note-file/picture.png" })
  check("and none without the token", unauth.status === 401)

  const route = await request({ url: "/projects/whatever" })
  check(
    "an app route falls back to the page",
    route.body.includes("studio"),
    route
  )

  const escape = await request({ url: "/%2e%2e/%2e%2e/etc/hosts" })
  check(
    "an encoded climb stays in the bundle",
    escape.status === 403 || escape.body.includes("studio"),
    escape
  )

  const post = await request({ method: "POST", url: "/app.js" })
  check("the bundle is read-only", post.status === 405)
}

await rm(dir, { recursive: true, force: true })
finish()

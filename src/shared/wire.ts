/**
 * How a call crosses HTTP for the web build — the one place both the server
 * (`src/server/`) and the tab's `window.desktop` (`src/renderer/web/`) read it.
 *
 * Electron's IPC is a structured clone, and the contract was written against
 * that: `writeNoteFile` hands over a `Uint8Array`, and an optional argument the
 * renderer left off arrives as `undefined` rather than as nothing. JSON keeps
 * neither — bytes become `{"0":137,"1":80,…}` and an `undefined` in an argument
 * list becomes `null`, which a handler's default parameter does not replace. So
 * both are tagged on the way out and restored on the way in, and everything
 * else is plain JSON.
 */

/** Every route the server answers lives under this, so the static renderer and
 * the API can share an origin without either shadowing the other. */
export const WIRE_PREFIX = "/__yasuo"

/** The header a call carries its token in. A custom header is also what makes
 * a cross-origin `fetch` preflight — which the server never answers — so a page
 * on another origin cannot fire a call blind. */
export const TOKEN_HEADER = "x-yasuo-token"

/** The query parameter the token rides in where no header can be set: an
 * `EventSource`, an `img` src. */
export const TOKEN_PARAM = "token"

/** One push event on the stream. */
export type WireEvent = { channel: string; payload: unknown }

/** Channels the server pushes that are not part of `IPC` — the web build's own,
 * answered by the tab rather than by the app. */
export const WEB_NOTICE_CHANNEL = "web:notice"

const BYTES = "$yasuoBytes"
const UNDEFINED = "$yasuoUndefined"

/** Big enough to be fast, small enough that `String.fromCharCode` never sees
 * more arguments than an engine will take. */
const CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function encodeWire(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key, current) {
    // Read off the holder rather than taking `current`: a Node `Buffer` has a
    // `toJSON` that has already run by the time `current` arrives.
    const raw = (this as Record<string, unknown>)[key]
    if (raw instanceof Uint8Array) return { [BYTES]: toBase64(raw) }
    if (raw instanceof ArrayBuffer) {
      return { [BYTES]: toBase64(new Uint8Array(raw)) }
    }
    // Only inside an array: an object property that is `undefined` is simply
    // absent, which every reader already treats the same.
    if (current === undefined && Array.isArray(this)) return { [UNDEFINED]: 1 }
    return current as unknown
  })
}

export function decodeWire<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (typeof record[BYTES] === "string") return fromBase64(record[BYTES])
      if (record[UNDEFINED] === 1) return undefined
    }
    return value
  }) as T
}

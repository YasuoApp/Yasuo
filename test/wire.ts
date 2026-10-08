import { decodeWire, encodeWire } from "../src/shared/wire"
import { check, finish, section } from "./harness"

/**
 * The web build's codec — what a call becomes on its way over HTTP.
 *
 * Worth a test because both of the things it exists for fail quietly: bytes
 * sent as plain JSON arrive as an object of numbered keys and are written into
 * a note file as `[object Object]`, and an `undefined` argument arriving as
 * `null` skips a handler's default parameter without a word.
 */

section("bytes")
{
  const bytes = new Uint8Array([0, 1, 2, 250, 255])
  const back = decodeWire<{ args: unknown[] }>(encodeWire({ args: [bytes] }))
  const read = back.args[0]
  check("a Uint8Array comes back as one", read instanceof Uint8Array)
  check(
    "with the same bytes",
    read instanceof Uint8Array && [...read].join() === [...bytes].join()
  )

  // A Node `Buffer` has a `toJSON` that runs before a replacer sees the value.
  const buffer = Buffer.from("héllo")
  const fromBuffer = decodeWire<unknown[]>(encodeWire([buffer]))[0]
  check(
    "a Buffer is bytes too, not its toJSON",
    fromBuffer instanceof Uint8Array &&
      Buffer.from(fromBuffer).toString() === "héllo"
  )

  const big = new Uint8Array(200_000).map((_, index) => index % 256)
  const bigBack = decodeWire<Uint8Array[]>(encodeWire([big]))[0]
  check(
    "past one chunk of String.fromCharCode",
    bigBack.length === big.length && bigBack[199_999] === big[199_999]
  )

  const buffer2 = new Uint8Array([7, 8]).buffer
  const fromArrayBuffer = decodeWire<unknown[]>(encodeWire([buffer2]))[0]
  check(
    "an ArrayBuffer arrives as bytes",
    fromArrayBuffer instanceof Uint8Array && fromArrayBuffer[1] === 8
  )
}

section("undefined")
{
  const args = decodeWire<unknown[]>(encodeWire(["chat", undefined, 3]))
  check("keeps its place in an argument list", args.length === 3, args)
  check("and is undefined rather than null", args[1] === undefined, args)

  const spread = ((a: unknown, b = "default") => [a, b])(...args)
  check("so a default parameter applies", spread[1] === "default", spread)

  const object = decodeWire<{ value?: unknown }>(
    encodeWire({ value: undefined })
  )
  check("an undefined property is simply absent", !("value" in object))
}

section("everything else is JSON")
{
  const value = { a: [1, "two", null, { b: true }], c: "x" }
  check(
    "round-trips unchanged",
    JSON.stringify(decodeWire(encodeWire(value))) === JSON.stringify(value)
  )
}

finish()

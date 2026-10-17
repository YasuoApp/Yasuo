import { describe, expect, test } from "bun:test"
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose"

import {
  allowedModel,
  listOf,
  upstreamHeaders,
} from "../server/utils/anthropic.ts"
import { tokenOf, verifyIdToken } from "../server/utils/firebase.ts"
import { dayKey, StreamUsage, usageOf, weighted } from "../server/utils/usage.ts"

/**
 * The parts of the server that decide who gets through and what they are
 * charged — tested without Anthropic or Google: the ID tokens are signed here
 * with a key of the test's own, the way `securetoken` signs real ones.
 */

const PROJECT = "simm-chat"
const { publicKey, privateKey } = await generateKeyPair("RS256")
const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }
const keys = createLocalJWKSet({ keys: [jwk] })

function idToken(claims: Record<string, unknown> = {}, project = PROJECT) {
  return new SignJWT({ email: "a@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(`https://securetoken.google.com/${project}`)
    .setAudience(project)
    .setSubject("uid-1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey)
}

describe("verifyIdToken", () => {
  test("a live token of this project is its user", async () => {
    const user = await verifyIdToken(await idToken(), PROJECT, keys)
    expect(user).toEqual({ uid: "uid-1", email: "a@example.com" })
  })

  test("another project's token is nobody", async () => {
    expect(
      await verifyIdToken(await idToken({}, "other-app"), PROJECT, keys)
    ).toBeNull()
  })

  test("an expired token is nobody", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey)
    expect(await verifyIdToken(expired, PROJECT, keys)).toBeNull()
  })

  test("a token signed by another key is nobody", async () => {
    const stranger = await generateKeyPair("RS256")
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-1")
      .setExpirationTime("1h")
      .sign(stranger.privateKey)
    expect(await verifyIdToken(forged, PROJECT, keys)).toBeNull()
  })

  test("not a JWT is nobody", async () => {
    expect(await verifyIdToken("sk-ant-something", PROJECT, keys)).toBeNull()
  })
})

describe("tokenOf", () => {
  test("a bearer", () => {
    expect(tokenOf(new Headers({ authorization: "Bearer abc" }))).toBe("abc")
  })
  test("x-api-key, the CLI's other copy", () => {
    expect(tokenOf(new Headers({ "x-api-key": "abc" }))).toBe("abc")
  })
  test("neither", () => {
    expect(tokenOf(new Headers())).toBeNull()
  })
})

describe("allowedModel", () => {
  const allowed = listOf(" claude-haiku-5-5 , ")
  test("the free model", () => {
    expect(allowedModel({ model: "claude-haiku-5-5" }, allowed)).toBe(
      "claude-haiku-5-5"
    )
  })
  test("anything else", () => {
    expect(allowedModel({ model: "claude-opus-5-5" }, allowed)).toBeNull()
    expect(allowedModel({ model: "haiku" }, allowed)).toBeNull()
    expect(allowedModel({}, allowed)).toBeNull()
  })
})

describe("upstreamHeaders", () => {
  test("the user's token never goes to Anthropic", () => {
    const headers = upstreamHeaders(
      new Headers({
        authorization: "Bearer user-id-token",
        "x-api-key": "user-id-token",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "anthropic-version": "2023-06-01",
      }),
      "sk-server"
    )
    expect(headers.get("x-api-key")).toBe("sk-server")
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31")
  })
})

describe("usage", () => {
  test("weighted by price", () => {
    expect(
      weighted({
        input_tokens: 100,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 10,
      })
    ).toBe(100 + 125 + 100 + 50)
  })

  test("a non-streamed answer's usage", () => {
    expect(usageOf({ input_tokens: 5, output_tokens: 7 })).toEqual({
      input_tokens: 5,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  test("a stream: start, then running output totals, split across chunks", () => {
    const sse = [
      "event: message_start\n",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":300,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tok',
      'ens":40}}\n\n',
      'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\r\n\r\n',
    ]
    const meter = new StreamUsage()
    const encoder = new TextEncoder()
    for (const part of sse) meter.push(encoder.encode(part))
    expect(meter.usage).toEqual({
      input_tokens: 12,
      output_tokens: 55,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 300,
    })
  })

  test("the day is UTC", () => {
    expect(dayKey(new Date("2026-10-17T23:30:00-05:00"))).toBe("2026-10-18")
  })
})

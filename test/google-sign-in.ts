/**
 * The loopback half of Google sign-in, run against a real socket.
 *
 * The browser is stood in for by the test: it takes the URL the flow would open
 * and posts to it the way the sign-in page does. What matters is what the
 * server does with each request — a token is accepted only on the nonce's path,
 * only from localhost, and only once — since any local page can reach the port.
 */
import { request } from "node:http"

import {
  cancelSignInWithGoogle,
  parseAnswer,
  signInWithGoogle,
} from "../src/main/google-sign-in"
import {
  FIREBASE_CONFIG,
  FIREBASE_SDK_VERSION,
  SIGN_IN_CANCELLED,
} from "../src/shared/firebase"
import { check, finish, section } from "./harness"

type Reply = { status: number; body: string }

/** A request sent to 127.0.0.1 under `host`, so the Host header can be chosen
 * the way a browser or a rebinding page would choose it. */
function send(
  url: string,
  options: { method?: string; host?: string; body?: string } = {}
): Promise<Reply> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: target.pathname,
        method: options.method ?? "GET",
        headers: { host: options.host ?? target.host },
      },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => (body += chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body })
        )
      }
    )
    req.on("error", reject)
    req.end(options.body)
  })
}

/** Starts an attempt and hands back the URL the browser would be sent to. */
function attempt(): Promise<{ url: string; outcome: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const outcome = signInWithGoogle((url) => resolve({ url, outcome }))
    // A server that cannot listen fails the attempt before any URL exists;
    // without this the test would wait for a URL that never comes.
    outcome.catch(reject)
  })
}

/** The attempt's answer as a plain value, whichever way it went. */
function settled(outcome: Promise<string>): Promise<string> {
  return outcome.then(
    (token) => `resolved:${token}`,
    (error: Error) => `rejected:${error.message}`
  )
}

const post = (url: string, answer: unknown) =>
  send(url, {
    method: "POST",
    body: typeof answer === "string" ? answer : JSON.stringify(answer),
  })

section("the sign-in page")

const first = await attempt()
const page = await send(first.url)
check("serves the page on its own path", page.status === 200, page.status)
check(
  "loads the Firebase SDK at the version the package resolves",
  page.body.includes(`firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`)
)
check(
  "initialises Firebase with the project's config",
  page.body.includes(FIREBASE_CONFIG.apiKey)
)
const wrongPath = await send(new URL(first.url).origin + "/not-the-nonce")
check("answers nothing on any other path", wrongPath.status === 404)

section("the token")

const rebound = await send(first.url + "/token", {
  method: "POST",
  host: "evil.example",
  body: JSON.stringify({ idToken: "forged" }),
})
check(
  "refuses a request whose Host is not localhost",
  rebound.status === 403,
  rebound.status
)

const notFromPage = await post(first.url + "/token", "not json")
check("refuses a body that is not JSON", notFromPage.status === 400)

const accepted = await post(first.url + "/token", { idToken: "abc.def" })
check("accepts the token on the attempt's own path", accepted.status === 204)
check(
  "resolves the attempt with that token",
  (await settled(first.outcome)) === "resolved:abc.def"
)

// The server is closed once the attempt has its answer, so a replay finds
// nothing listening rather than getting a reply.
const replayed = await post(first.url + "/token", { idToken: "again" }).then(
  (reply) => `answered:${reply.status}`,
  () => "closed"
)
check(
  "a second token for a finished attempt goes nowhere",
  replayed === "closed",
  replayed
)

section("a failed answer")

const failing = await attempt()
const refused = await post(failing.url + "/token", {
  error: "The popup was closed.",
})
check("the page's error is received", refused.status === 204)
check(
  "the attempt rejects with the page's reason",
  (await settled(failing.outcome)) === "rejected:The popup was closed."
)

section("a second press of the button")

const older = await attempt()
const newer = await attempt()
check(
  "the older attempt is ended with a reason",
  (await settled(older.outcome)).startsWith(
    "rejected:Sign-in was started again"
  )
)
await post(newer.url + "/token", { idToken: "newer" })
check(
  "the newer attempt still takes its token",
  (await settled(newer.outcome)) === "resolved:newer"
)

section("a cancelled sign-in")

// The tab was closed, so nothing will ever answer: cancelling is the only way
// the attempt ends before its timeout.
const abandoned = await attempt()
cancelSignInWithGoogle()
check(
  "the attempt ends at once with the shared cancel reason",
  (await settled(abandoned.outcome)) === `rejected:${SIGN_IN_CANCELLED}`
)
check(
  "the port is released — nothing answers the cancelled URL",
  (await send(abandoned.url).then(
    () => "answered",
    () => "closed"
  )) === "closed"
)

section("what counts as an answer")

check(
  "a token is an answer",
  JSON.stringify(parseAnswer('{"idToken":"x"}')) === '{"idToken":"x"}'
)
check(
  "an error is an answer",
  JSON.stringify(parseAnswer('{"error":"no"}')) === '{"error":"no"}'
)
check(
  "an empty object is an answer with neither",
  JSON.stringify(parseAnswer("{}")) === "{}"
)
check(
  "a non-object is refused",
  parseAnswer("[]") === null && parseAnswer("42") === null
)
check(
  "a token that is not a string is refused",
  parseAnswer('{"idToken":42}') === null
)
check("an empty token is refused", parseAnswer('{"idToken":""}') === null)

finish()

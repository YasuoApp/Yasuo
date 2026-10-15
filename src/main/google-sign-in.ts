import { randomBytes } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

import {
  FIREBASE_CONFIG,
  FIREBASE_SDK_VERSION,
  SIGN_IN_CANCELLED,
} from "../shared/firebase"

/**
 * Google sign-in for a desktop window, which cannot run Google's own flow.
 *
 * Firebase's popup needs an origin on the project's authorized domains, and the
 * built renderer is `app://studio`, which is not one. Google also refuses
 * OAuth from an embedded browser, so the flow cannot run in a window of this
 * app at all. Instead the user's own browser opens a page on `localhost` (which
 * Firebase authorizes by default), that page runs the ordinary popup, and posts
 * the Google ID token back here, to a server that only exists for this one
 * attempt.
 *
 * Free of `electron` — the browser is opened through a callback — so
 * `test/google-sign-in.ts` can run the whole exchange against a real socket.
 */

/** How long the browser may take. Long enough to pick an account and read a
 * consent screen; short enough that an abandoned tab does not leave a server
 * listening for the rest of the session. */
const TIMEOUT_MS = 5 * 60_000

/** A token is about 1 KB. Anything much bigger is not from our page. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * The app's mark, as the sign-in page draws it. A copy of `resources/logo.svg`:
 * the page is served from here rather than from a file, because a packaged app
 * does not ship `resources/`. Change both together.
 */
const APP_MARK = `<svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
<polyline points="28,24 6,50 28,76" stroke="#1F9CF0" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
<polyline points="72,24 94,50 72,76" stroke="#1F9CF0" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
<path transform="translate(32.6 32.6) scale(1.45)" fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>
</svg>`

/** The attempt in progress, if any. A second press of the button ends the
 * first, rather than leaving two servers and two tabs racing for one answer. */
let pending: ((outcome: string | Error) => void) | null = null

/**
 * Signs in with Google through the user's browser and resolves with the Google
 * ID token the renderer hands to Firebase.
 *
 * `openUrl` is how the browser is opened — the main process's `shell`, passed
 * in so this module does not import it.
 */
export function signInWithGoogle(
  openUrl: (url: string) => void
): Promise<string> {
  pending?.(new Error("Sign-in was started again before this one finished."))

  return new Promise<string>((resolve, reject) => {
    // Only a path that is unguessable can post a token: anything else on this
    // machine could otherwise send one to the server while it is listening.
    const nonce = randomBytes(24).toString("base64url")
    let port = 0
    let done = false

    const server = createServer((request, response) => {
      void serve(request, response)
    })

    const timer = setTimeout(
      () => finish(new Error("Sign-in timed out in the browser.")),
      TIMEOUT_MS
    )

    /** Ends the attempt once, whichever of the four ways it ends first. */
    function finish(outcome: string | Error): void {
      if (done) return
      done = true
      clearTimeout(timer)
      if (pending === finish) pending = null
      // `close` stops accepting; the response to the page that posted the
      // token has already been written, so nothing in flight is cut off.
      server.close()
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    pending = finish

    server.on("error", (error) => finish(error))

    async function serve(
      request: IncomingMessage,
      response: ServerResponse
    ): Promise<void> {
      // A DNS-rebinding page would arrive with its own name in `Host`. Only
      // the two names this server is reached by get an answer.
      const host = request.headers.host
      if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
        response.writeHead(403).end()
        return
      }

      const { pathname } = new URL(request.url ?? "/", "http://localhost")

      if (request.method === "GET" && pathname === `/${nonce}`) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        response.end(signInPage())
        return
      }

      if (request.method === "POST" && pathname === `/${nonce}/token`) {
        const body = await readBody(request)
        const answer = parseAnswer(body)
        if (!answer) {
          response.writeHead(400).end()
          return
        }
        response.writeHead(204).end()
        finish(
          "idToken" in answer
            ? answer.idToken
            : new Error(answer.error ?? "Google returned no sign-in.")
        )
        return
      }

      response.writeHead(404).end()
    }

    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port
      openUrl(`http://localhost:${port}/${nonce}`)
    })
  })
}

/**
 * Ends the attempt in progress as cancelled. For a browser tab that was closed
 * before it answered: the server would otherwise wait out its whole timeout
 * with the button locked. A no-op when there is no attempt.
 */
export function cancelSignInWithGoogle(): void {
  pending?.(new Error(SIGN_IN_CANCELLED))
}

/**
 * The page the browser loads. It runs Firebase's own popup and posts the
 * result back to the path it was served from, so nothing about the page needs
 * to know the nonce.
 *
 * The SDK comes from Google's CDN at the version `package.json` resolves, which
 * keeps this page out of the bundle while the protocol stays in step.
 */
function signInPage(): string {
  const sdk = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`
  // The config is trusted, but a `<` in a string could still close the script.
  const config = JSON.stringify(FIREBASE_CONFIG).replace(/</g, "\\u003c")
  const favicon = `data:image/svg+xml,${encodeURIComponent(APP_MARK)}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Visual Studio Claude — sign in</title>
<link rel="icon" href="${favicon}" />
<style>
  :root {
    color-scheme: light dark;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --page: #f4f4f5;
    --card: #ffffff;
    --edge: #e4e4e7;
    --ink: #18181b;
    --muted: #71717a;
    --button: #ffffff;
    --button-hover: #f4f4f5;
    --button-edge: #d4d4d8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #1b1c1f;
      --card: #26282c;
      --edge: #3a3d43;
      --ink: #f4f4f5;
      --muted: #a1a1aa;
      --button: #2e3035;
      --button-hover: #383b41;
      --button-edge: #4a4d54;
    }
  }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: var(--page);
    color: var(--ink);
  }
  .card {
    width: min(23rem, 90vw);
    padding: 2.25rem 2rem 2rem;
    border: 1px solid var(--edge);
    border-radius: 14px;
    background: var(--card);
    text-align: center;
    box-shadow: 0 10px 32px rgb(0 0 0 / 0.12);
  }
  /* The button's own display rule would otherwise win over the hidden attribute. */
  [hidden] {
    display: none !important;
  }
  #intro > svg {
    display: block;
    width: 3.5rem;
    height: 3.5rem;
    margin: 0 auto 1rem;
  }
  #done svg {
    display: block;
    width: min(15rem, 100%);
    height: auto;
    margin: 0 auto 1.25rem;
  }
  #done h1 {
    margin-bottom: 0.35rem;
  }
  #done .lede {
    margin-bottom: 0;
  }
  h1 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .lede {
    margin: 0 0 1.5rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  #status {
    min-height: 2.6em;
    margin: 0 0 1.25rem;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--muted);
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 1.1rem;
    border: 1px solid var(--button-edge);
    border-radius: 8px;
    background: var(--button);
    color: var(--ink);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--button-hover);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button svg {
    width: 18px;
    height: 18px;
  }
</style>
</head>
<body>
<main class="card">
  <div id="intro">
    ${APP_MARK}
    <h1>Sign in to Visual Studio Claude</h1>
    <p class="lede">Use the Google account you signed up with.</p>
    <p id="status">Continue to sign in with Google.</p>
    <button id="continue" type="button">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Continue with Google
    </button>
  </div>
  <section id="done" hidden>
    <svg viewBox="0 0 240 150" fill="none" aria-hidden="true">
      <circle cx="120" cy="75" r="64" fill="#34A853" fill-opacity="0.08"/>
      <circle cx="120" cy="75" r="31" stroke="#34A853" stroke-opacity="0.25" stroke-width="2"/>
      <path d="M50 22 L53.5 31.5 L63 35 L53.5 38.5 L50 48 L46.5 38.5 L37 35 L46.5 31.5Z" fill="#D97757"/>
      <path d="M196 18 L198 23.5 L203.5 25.5 L198 27.5 L196 33 L194 27.5 L188.5 25.5 L194 23.5Z" fill="#1F9CF0"/>
      <circle cx="176" cy="124" r="3" fill="#D97757" fill-opacity="0.6"/>
      <circle cx="62" cy="122" r="2.5" fill="#1F9CF0" fill-opacity="0.6"/>
      <path d="M86 75 H98 M142 75 H154" stroke="#71717a" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 6"/>
      <rect x="22" y="46" width="62" height="58" rx="16" fill="#1F9CF0"/>
      <polyline points="44,68 34,75 44,82" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="62,68 72,75 62,82" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="120" cy="75" r="22" fill="#34A853"/>
      <path d="M110.5 75.5 L117 82 L130 68.5" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="186" cy="70" r="16" fill="#D97757"/>
      <circle cx="186" cy="65" r="5.5" fill="#fff"/>
      <path d="M177 85 Q186 75 195 85 Z" fill="#fff"/>
    </svg>
    <h1>You're signed in</h1>
    <p class="lede">Head back to Visual Studio Claude. You can close this tab.</p>
  </section>
</main>
<script type="module">
import { initializeApp } from "${sdk}/firebase-app.js"
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
} from "${sdk}/firebase-auth.js"

const intro = document.getElementById("intro")
const done = document.getElementById("done")
const status = document.getElementById("status")
const button = document.getElementById("continue")
const post = (answer) =>
  fetch(location.pathname + "/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(answer),
  })

// The popup has to open inside the click. A browser blocks one opened on page
// load with no gesture behind it (auth/popup-blocked), which is why this page
// waits for the button rather than starting the flow itself.
const auth = getAuth(initializeApp(${config}))
const provider = new GoogleAuthProvider()
provider.setCustomParameters({ prompt: "select_account" })

button.addEventListener("click", async () => {
  button.disabled = true
  status.textContent = "Waiting for Google…"
  try {
    const result = await signInWithPopup(auth, provider)
    const { idToken } = GoogleAuthProvider.credentialFromResult(result)
    await post({ idToken })
    // Gone rather than disabled: a button that is still there invites a second
    // press on a page that has nothing left to do.
    intro.hidden = true
    done.hidden = false
  } catch (error) {
    // The server takes one answer and closes, so a retry on this page would
    // reach nothing. The button goes and the tab says to start again from the app.
    await post({ error: String(error?.message ?? error) })
    button.hidden = true
    status.textContent =
      "Sign-in did not finish. Close this tab and try again from Visual Studio Claude."
  }
})
</script>
</body>
</html>
`
}

/** The body of a token post, read whole — it is small, and a partial read of
 * JSON is no use to anybody. Resolves empty past the limit, which then fails
 * to parse. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        request.destroy()
        resolve("")
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", () => resolve(""))
  })
}

/** What the page posts: a token, or the reason there is none. Anything else is
 * not from the page and is refused. */
export function parseAnswer(
  body: string
): { idToken: string } | { error?: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const { idToken, error } = parsed as Record<string, unknown>
  if (typeof idToken === "string" && idToken.length > 0) return { idToken }
  if (idToken === undefined) {
    return typeof error === "string" ? { error } : {}
  }
  return null
}

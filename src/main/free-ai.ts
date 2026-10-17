/**
 * The free AI's half in main: where its `CLAUDE_CONFIG_DIR` is, the token the
 * CLI sends, and what every `claude` started on a profile is handed.
 *
 * **The token is a file the CLI reads, not a variable it is given.** A
 * Firebase ID token lives an hour and a chat session can stay open all day, so
 * a token fixed into a process's env at spawn is a session that starts failing
 * at minute sixty. Instead the directory's own `settings.json` names an
 * `apiKeyHelper` that prints `vsclaude-token`, the CLI re-runs it every five
 * minutes (`freeAiEnv`), and the renderer hands over each token Firebase
 * refreshes (`setFreeAiToken`). The directory is this app's, under the
 * workspace, so writing the CLI's settings file there is writing nobody's.
 *
 * Written `0600` and deleted on sign-out. It is not sealed by the keychain the
 * way a long-lived secret would be: the CLI has to read it with `cat`, and what
 * is in it stops working within the hour.
 *
 * Free of `electron`. Module state rather than a class threaded through: every
 * place that starts a `claude` already asks `accountEnv` by directory.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  apiKeyHelperCommand,
  FREE_AI_URL,
  freeAiEnv,
  normalizeAiUrl,
} from "../shared/free-ai"

const TOKEN_FILE = "vsclaude-token"

let freeDir: string | null = null
/** Whether this run has been handed a token — a file left by an earlier run
 * is not one, since nobody has said that user is still signed in. */
let signedIn = false

/** Called once by `ipc.ts`, with the workspace's own directory for it. */
export function setFreeAiDir(dir: string): void {
  freeDir = dir
}

export function freeAiDir(): string | null {
  return freeDir
}

/** The server, or null for none configured — which hides the free AI. */
export function freeAiUrl(): string | null {
  return normalizeAiUrl(process.env.VSCLAUDE_AI_URL || FREE_AI_URL)
}

/** Whether a turn on the free AI can run right now. */
export function freeAiReady(): boolean {
  return signedIn && freeAiUrl() !== null && freeDir !== null
}

/**
 * The signed-in user's current Firebase ID token, or null on sign-out.
 *
 * `settings.json` is merged rather than written whole: the CLI keeps its own
 * keys in the same file, and this only owns `apiKeyHelper`.
 */
export async function setFreeAiToken(token: string | null): Promise<boolean> {
  const dir = freeDir
  if (!dir) return false
  const file = path.join(dir, TOKEN_FILE)

  if (!token) {
    signedIn = false
    await rm(file, { force: true })
    return false
  }

  await mkdir(dir, { recursive: true })
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 })

  const settingsFile = path.join(dir, "settings.json")
  let settings: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsFile, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    // Missing or unreadable — it is about to be this app's anyway.
  }
  const helper = apiKeyHelperCommand(file, process.platform)
  if (settings.apiKeyHelper !== helper) {
    await writeFile(
      settingsFile,
      JSON.stringify({ ...settings, apiKeyHelper: helper }, null, 2),
      "utf8"
    )
  }

  signedIn = true
  return freeAiReady()
}

/**
 * `CLAUDE_CONFIG_DIR` for a profile's directory, plus the free AI's server and
 * models when it is that one — nothing at all for the default login.
 *
 * What every `claude` started on a profile is handed in place of building
 * `{ CLAUDE_CONFIG_DIR }` itself: a chat's session, a rewind, the commit draft
 * and the usage meter.
 */
export function accountEnv(configDir: string | null): Record<string, string> {
  if (!configDir) return {}
  const url = freeAiUrl()
  return {
    CLAUDE_CONFIG_DIR: configDir,
    ...(url && configDir === freeDir ? freeAiEnv(url) : {}),
  }
}

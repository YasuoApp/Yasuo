import type { AgentModel, ChatOptions } from "./api"

/**
 * The free AI: chats run through this app's own server rather than an account
 * of the user's, for anybody signed in to the studio — Haiku only.
 *
 * It is an account in the composer's menu like a profile, but **not a
 * profile**: nothing in Settings names it, renames it or deletes it, and it is
 * there exactly while somebody is signed in. Its id is this constant on a
 * chat's `profileId`, and main resolves it to a `CLAUDE_CONFIG_DIR` of its own
 * (`main/free-ai.ts`).
 *
 * Pure and shared: the composer draws a free chat's model the way main runs it.
 * `test/free-ai.ts`.
 */

export const FREE_PROFILE_ID = "vsclaude-free"

/**
 * The server the free AI's requests go to — empty until there is one, which
 * hides the free AI everywhere. `VSCLAUDE_AI_URL` in the environment main is
 * started with overrides it, for a server running on this machine.
 *
 * The server is sent the signed-in user's Firebase ID token on every request,
 * as `Authorization: Bearer` and as `x-api-key` both (the CLI's own habit with
 * an `apiKeyHelper`), and is expected to verify it, refuse any model but
 * `FREE_AI_MODEL`, and forward to Anthropic with a key of its own.
 */
export const FREE_AI_URL = ""

/** The one model the free AI runs. A full id rather than the `haiku` alias,
 * because it is also what every alias is pinned to — see `freeAiEnv`. */
export const FREE_AI_MODEL = "claude-haiku-5-5"

/**
 * A chat's options as a free chat runs them: Haiku, at the CLI's own effort.
 *
 * Applied in main at send time, not only drawn: the toolbar of a chat switched
 * to the free AI may still say Opus, and the server would refuse it.
 */
export function forFreeAi(options: ChatOptions): ChatOptions {
  return options.profileId === FREE_PROFILE_ID
    ? { ...options, model: "haiku", effort: null }
    : options
}

/** Whether a row of the model picker is Haiku — the only rows a free chat's
 * picker draws. By the wire id where the CLI sent one, since `default` can be
 * Haiku too. */
export function isHaiku(model: AgentModel): boolean {
  return /haiku/i.test(model.resolvedModel ?? model.value)
}

/**
 * `input` as a base URL, or null for something that is not one: `https`,
 * or `http` to this machine alone, since the user's token goes there on every
 * request. A trailing slash is dropped — the CLI appends `/v1/messages`.
 */
export function normalizeAiUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return null
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/**
 * What a `claude` running on the free AI is handed, beside its
 * `CLAUDE_CONFIG_DIR` — whose `settings.json` names the `apiKeyHelper` that
 * reads the token (`apiKeyHelperCommand`).
 *
 * **Every model is pinned to Haiku**, not only the one picked: the CLI asks for
 * other models on its own — a subagent, the `opus` behind an alias — and each
 * of those would be a request the server refuses halfway through a turn.
 *
 * **The user's own credentials are emptied**: a spawned `claude` gets the login
 * shell's whole env, and an `ANTHROPIC_API_KEY` exported there would win over
 * the helper and be sent to this app's server — somebody's key for Anthropic,
 * handed to a third party.
 *
 * The helper is re-run every five minutes, well inside the hour a Firebase ID
 * token lives, so a session open all afternoon keeps sending a live one.
 */
export function freeAiEnv(url: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(5 * 60_000),
    ANTHROPIC_MODEL: FREE_AI_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: FREE_AI_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: FREE_AI_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: FREE_AI_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: FREE_AI_MODEL,
  }
}

/**
 * The `apiKeyHelper` that prints the token file — `type` on Windows, where the
 * CLI runs it through `cmd.exe` (measured against a local server: the token
 * arrived), `cat` everywhere else.
 */
export function apiKeyHelperCommand(
  tokenFile: string,
  platform: string
): string {
  return platform === "win32"
    ? `type "${tokenFile}"`
    : `cat '${tokenFile.replaceAll("'", `'\\''`)}'`
}

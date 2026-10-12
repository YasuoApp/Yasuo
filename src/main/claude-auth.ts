import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"

import type { ClaudeAccount } from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { expandHome, locate, spawnEnvironment } from "./shell-env"

const run = promisify(execFile)

/**
 * Who a profile's `CLAUDE_CONFIG_DIR` is signed in as — the check beside each
 * row in Settings › Claude.
 *
 * **Asked of the CLI, not read off disk**, for the reason `mcp-servers.ts`
 * gives: `<dir>/.claude.json` does hold an `oauthAccount`, but that file is the
 * CLI's, its shape moves between releases, and on macOS the token itself is not
 * in it at all — it is in the login keychain, so a directory can name an
 * account it can no longer authenticate as. `claude auth status --json` is the
 * CLI answering about its own login, and it costs a process and no tokens.
 *
 * **The directory is stat'd first and a missing one is never spawned into.**
 * `claude` creates whatever `CLAUDE_CONFIG_DIR` points at, `mkdir -p`, before
 * it answers — so a probe of a typo would leave a directory tree behind and
 * then report it as merely signed out. Settings says the profile's own sentence
 * about that: nothing here starts a config directory off.
 */
export async function claudeAccount(configDir: string): Promise<ClaudeAccount> {
  // Empty is the default login — no `CLAUDE_CONFIG_DIR` at all, which is what a
  // chat with no profile picked runs under. Worth naming for the same reason
  // the profiles are: it is the account the rest are being told apart from.
  const dir = configDir.trim() ? expandHome(configDir.trim()) : ""

  if (dir && !(await isDirectory(dir))) {
    return {
      ...blank(dir),
      state: "missing",
    }
  }

  const binary = await locate(claudeBinary())
  if (!binary) {
    return {
      ...blank(dir),
      state: "error",
      error: `Could not find \`${claudeBinary()}\` on your PATH. Set CLAUDE_BIN if it is installed somewhere unusual.`,
    }
  }

  try {
    const { stdout } = await run(binary, ["auth", "status", "--json"], {
      // The user's home rather than a project: the answer is about the config
      // directory, and a repository's own settings have no say in it.
      cwd: process.env.HOME ?? undefined,
      env: await spawnEnvironment(dir ? { CLAUDE_CONFIG_DIR: dir } : {}),
      timeout: TIMEOUT_MS,
    })
    return readAuthStatus(dir, stdout)
  } catch (error) {
    // A CLI old enough to have no `auth status` fails here with its own usage
    // error, which is the honest thing to show: this app cannot tell that case
    // from a login that is genuinely broken, and the user's fix is the same
    // sentence either way.
    const stderr = (error as { stderr?: string }).stderr?.trim()
    return {
      ...blank(dir),
      state: "error",
      error: stderr || (error instanceof Error ? error.message : String(error)),
    }
  }
}

/** Long enough for the login-shell resolve `locate` pays for; the status
 * itself answers out of the config directory in well under a second. */
const TIMEOUT_MS = 15_000

/**
 * The CLI's JSON, kept to the fields this app draws.
 *
 * Read leniently — `subscriptionType` is absent for an API-key login and
 * `email` for anything that never signed in — because a field this app does not
 * recognise must degrade to "signed in" rather than to an error.
 */
export function readAuthStatus(
  configDir: string,
  stdout: string
): ClaudeAccount {
  const start = stdout.indexOf("{")
  if (start < 0) {
    return { ...blank(configDir), state: "error", error: stdout.trim() }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown>
  } catch {
    return { ...blank(configDir), state: "error", error: stdout.trim() }
  }

  return {
    configDir,
    state: parsed.loggedIn === true ? "signedIn" : "signedOut",
    email: text(parsed.email),
    organization: text(parsed.orgName),
    method: text(parsed.authMethod),
    plan: text(parsed.subscriptionType),
    error: null,
  }
}

function blank(configDir: string): ClaudeAccount {
  return {
    configDir,
    state: "signedOut",
    email: null,
    organization: null,
    method: null,
    plan: null,
    error: null,
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path)
    .then((entry) => entry.isDirectory())
    .catch(() => false)
}

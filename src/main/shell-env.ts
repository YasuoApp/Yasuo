/**
 * How to run a shell (or a command through one) on this platform, what
 * environment to hand it, and where it would find a CLI.
 *
 * Shared by `daemon.ts` (spawns the real pty), `agent-tools.ts` and
 * `github.ts` (both just ask a shell where a CLI resolves to) so the places
 * this app decides "what a shell is" cannot quietly drift apart.
 */

import { execFile } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Resolves a path the user typed, expanding a leading `~`.
 *
 * Shared rather than local to one caller: `ipc.ts` needs it for a field that
 * accepts typing (`addFolder`, `pickFiles`'s default directory, a
 * `ClaudeProfile`'s `configDir`), and `worktree-chat.ts` needs it again at the
 * point a profile's directory becomes `CLAUDE_CONFIG_DIR` — a env var handed
 * to a process the SDK spawns directly, with no shell in between to expand a
 * literal `~` the way one typed at a prompt would be.
 */
export function expandHome(target: string): string {
  const trimmed = target.trim()
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * The user's own shell, started as a login shell — or that shell running
 * `command` and exiting, when one is given.
 *
 * `-l` matters more than it looks: a GUI app on macOS inherits a bare
 * `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so without reading the user's profile
 * the shell would not find a `node` or `npm` installed by nvm, asdf or
 * Homebrew — which is most of them. `-i` is added alongside it for a command,
 * because zsh reads `.zshrc` only when interactive, and that is where a CLI
 * installed into `~/.local/bin` or `~/.claude/local` usually joins PATH.
 */
export function shell(command?: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const file = process.env.COMSPEC ?? "powershell.exe"
    if (!command) return { file, args: [] }
    return /cmd\.exe$/i.test(file)
      ? { file, args: ["/c", command] }
      : { file, args: ["-NoLogo", "-Command", command] }
  }

  const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"
  const file = process.env.SHELL ?? fallback
  return { file, args: command ? ["-l", "-i", "-c", command] : ["-l"] }
}

/**
 * Single-quoted for the shell, so a path with spaces stays one word.
 *
 * Here rather than in either caller because both build a command line for the
 * shell above: `agent-tools.ts` to ask where a CLI resolves to, and
 * `agent-tools.ts` to build one — two places that must agree on what quoting is.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Where the user's shell would find `command`, or null.
 *
 * Asked of the same login-interactive shell that a session is spawned in, and
 * deliberately not of `process.env.PATH`: a GUI app inherits almost none of the
 * user's PATH, so checking here what the pty will resolve there is the only way
 * the two can agree. It is also the only way anything else in the main process
 * finds a CLI installed by Homebrew, nvm or asdf — `git` happens to live in the
 * bare `/usr/bin`, and every other tool this app shells out to does not.
 * `command -v` covers the aliases and shell functions these CLIs install as
 * well as real binaries.
 */
export async function locate(command: string): Promise<string | null> {
  // `where.exe` rather than `where`: in PowerShell the bare name is an alias
  // for `Where-Object`, which would filter a pipeline instead of finding
  // anything.
  const probe =
    process.platform === "win32"
      ? `where.exe "${command}"`
      : `command -v ${quote(command)}`
  const { file, args } = shell(probe)

  try {
    const { stdout } = await run(file, args, {
      // A profile that waits on the network, or a shell that stops for a prompt
      // it will never get an answer to: either way, "not found" is the useful
      // answer rather than a picker that never fills in.
      timeout: 10_000,
      // Interactive rc files can be chatty; only the last line is the answer.
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })

    const lines = stdout.split("\n").filter((line) => line.trim() !== "")
    return lines.at(-1)?.trim() ?? null
  } catch {
    // A non-zero exit is `command -v` saying it found nothing. Anything else —
    // no such shell, the timeout above — leaves the caller to treat the tool as
    // installable, which is the recoverable half of being wrong.
    return null
  }
}

/** Markers a running `claude` exports for whatever it spawns, none of which
 * any shell profile sets. */
const AGENT_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_TMPDIR",
])

/**
 * The same environment without the marks of an agent session that spawned us.
 *
 * Launching the app from inside a `claude` session — `bun dev` run by an agent,
 * which is how this app tends to get built — leaks those marks the whole way
 * down: agent → Electron → daemon → pty → the `claude` the user just opened in
 * the Terminal panel. The CLI reads `CLAUDE_CODE_CHILD_SESSION`, decides it is
 * a nested run of itself, and stops writing a transcript. That is not the
 * cosmetic warning it looks like: the chat view is a tail of that transcript,
 * so it stays empty for the entire session.
 *
 * Stripped rather than overridden, because the pty is a login shell: anything
 * the user genuinely configured in their own profile is exported again a
 * moment later, and only what was inherited is lost.
 */
export function withoutAgentSession<T extends NodeJS.ProcessEnv>(env: T): T {
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || AGENT_SESSION_VARS.has(key)) {
      delete env[key]
    }
  }
  return env
}

/** Asked once per run: a login shell's startup is the expensive part, and the
 * answer cannot change while the app is up. */
let shellPathOnce: Promise<string | null> | null = null

/**
 * The PATH the user's own login shell exports, or null.
 *
 * The counterpart to `locate` above, and written against the same fact from the
 * other side: `locate` finds `claude` through the user's shell, but the process
 * spawned at that path is handed `process.env`, whose PATH from launchd is the
 * bare `/usr/bin:/bin:/usr/sbin:/sbin`. The CLI itself runs — it was located by
 * absolute path — and then every MCP server it spawns for itself dies ENOENT
 * looking for `node` or `npx`, which is not a failure of any one server: they
 * all go at once. A pty never sees this because `shell()` gives it `-l -i`.
 */
function shellPath(): Promise<string | null> {
  shellPathOnce ??= readShellPath()
  return shellPathOnce
}

async function readShellPath(): Promise<string | null> {
  if (process.platform === "win32") return null

  // Fenced by a marker rather than read as the last line: an interactive rc file
  // is free to print anything, and unlike `command -v` the answer here is not
  // recognisable on its own.
  const marker = "__yasuo_path__"
  const { file, args } = shell(`printf '${marker}%s${marker}' "$PATH"`)

  try {
    const { stdout } = await run(file, args, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    const [, value] = stdout.split(marker)
    return value?.includes(path.delimiter) ? value : null
  } catch {
    // Same bargain as `locate`: no shell, a profile that hangs, a non-zero exit.
    // Falling back to the inherited PATH is what the app did before this existed.
    return null
  }
}

/**
 * `environment`, with the user's own PATH merged in — for a process spawned
 * *without* a shell in between, which is every `claude` this app starts.
 *
 * Merged rather than replaced: what launchd gave us is a subset in the ordinary
 * case, but an app launched *from* a terminal already has a good PATH, and a
 * plugin's own bin directory arrives that way and is on no profile.
 */
export async function spawnEnvironment(
  extra: Record<string, string> = {}
): Promise<Record<string, string | undefined>> {
  const env = environment(extra)
  const fromShell = await shellPath()
  if (!fromShell || extra.PATH) return env

  const seen = new Set(fromShell.split(path.delimiter))
  const rest = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry !== "" && !seen.has(entry))

  return { ...env, PATH: [fromShell, ...rest].join(path.delimiter) }
}

export function environment(
  extra: Record<string, string> = {}
): Record<string, string | undefined> {
  const env = withoutAgentSession({ ...process.env })

  // Set for Electron's own child processes; inside a shell it would make any
  // `electron` the user runs behave as a bare Node instead.
  delete env.ELECTRON_RUN_AS_NODE

  /*
   * An app launched from the Dock inherits no locale: launchd sets none, while
   * Terminal.app and VS Code each set one for the shells they open. A CLI that
   * asks and finds no UTF-8 falls back to ASCII — which is why Claude Code
   * draws its input box out of hyphens in here and out of lines everywhere
   * else. Filled in only when nothing else said, so a user with a locale of
   * their own keeps it, and `extra` still overrides.
   */
  const locale = env.LC_ALL ?? env.LANG

  return {
    ...env,
    ...(locale ? {} : { LANG: "en_US.UTF-8" }),
    ...extra,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }
}

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * Where everything this app keeps on disk lives, under the user's home.
 *
 * Its own module, tiny as it is, because `store.ts` reaches Electron's
 * `safeStorage` to encrypt database passwords — so anything importing the path
 * from there drags a running Electron in with it, which a test running under
 * plain `bun` cannot do.
 */
export const DATA_DIR_NAME = ".vsclaude"

/** Where the app kept it while it was called Yasuo — see `migrateLegacyDataDir`. */
const LEGACY_DATA_DIR_NAME = ".yasuo"

/**
 * `VSCLAUDE_DATA_DIR` moves the whole tree — the manifest, the workspace's own
 * files and the agent settings alike. `YASUO_DATA_DIR` is the same variable
 * under the app's old name, still read so a setup that exported it keeps its
 * workspace.
 *
 * Read on every call rather than captured once, so that a test can point it
 * somewhere disposable before the first read. That is not a detail: the
 * alternative for a test is `$HOME`, and `homedir()` is resolved at startup by
 * at least one of the runtimes this repo uses, which makes redirecting it from
 * inside the process silently do nothing.
 */
export function dataDir(): string {
  return (
    process.env.VSCLAUDE_DATA_DIR ??
    process.env.YASUO_DATA_DIR ??
    path.join(homedir(), DATA_DIR_NAME)
  )
}

/**
 * Moves `~/.yasuo` to `~/.vsclaude` the first time a build under the new name
 * runs, so the rename costs nobody their workspace.
 *
 * Everything moves except the git worktrees under `workspace/worktrees`. Those
 * are recorded in the manifest by absolute path, the repository they were cut
 * from points at them by absolute path (`.git/worktrees/*` / `gitdir`), and the
 * `claude` CLI files a session under its cwd — so a checkout that moved would
 * be a project the manifest cannot find, a worktree git calls prunable and a
 * chat that can no longer resume. They stay where they are, and only new ones
 * land under the new directory.
 *
 * Does nothing when either variable names a directory, or when the new one
 * already exists: a half-done migration is never "finished" over the top of a
 * workspace somebody is already using.
 */
export function migrateLegacyDataDir(): void {
  if (process.env.VSCLAUDE_DATA_DIR || process.env.YASUO_DATA_DIR) return
  const legacy = path.join(homedir(), LEGACY_DATA_DIR_NAME)
  const current = path.join(homedir(), DATA_DIR_NAME)
  if (existsSync(current) || !existsSync(legacy)) return
  try {
    renameSync(legacy, current)
    const moved = path.join(current, "workspace", "worktrees")
    if (existsSync(moved) && readdirSync(moved).length > 0) {
      mkdirSync(path.join(legacy, "workspace"), { recursive: true })
      renameSync(moved, path.join(legacy, "workspace", "worktrees"))
    }
    repointProfiles(path.join(current, "manifest.json"), legacy, current)
  } catch (error) {
    // Starting on an empty workspace beside an intact old one is recoverable;
    // refusing to start is not.
    console.error("Could not move ~/.yasuo to ~/.vsclaude:", error)
  }
}

/**
 * Renames `workspace/worktree-chats{,.json}` to `workspace/chats{,.json}`, the
 * name the chats were kept under while they lived in `git worktree` checkouts.
 *
 * Each of the two moves only when the old one is there and the new one is not,
 * for the reason `migrateLegacyDataDir` refuses to finish over a workspace in
 * use. Nothing outside this app points at these files — the CLI keeps its own
 * session under `~/.claude`, by session id — so a move costs no resume.
 */
export function migrateChatFiles(): void {
  const workspace = path.join(dataDir(), "workspace")
  const moves: [string, string][] = [
    ["worktree-chats.json", "chats.json"],
    ["worktree-chats", "chats"],
  ]
  for (const [from, to] of moves) {
    const source = path.join(workspace, from)
    const target = path.join(workspace, to)
    if (!existsSync(source) || existsSync(target)) continue
    try {
      renameSync(source, target)
    } catch (error) {
      console.error(`Could not move ${source} to ${target}:`, error)
    }
  }
}

/**
 * A Claude profile's `configDir` is written into the manifest as an absolute
 * path the first time it is filled in (`withConfigDirs`), so after the move it
 * names a directory that is gone — and a profile pointed at an empty config
 * directory is a signed-out account. Replaced as text, in its JSON-escaped
 * spelling, because the manifest's shape is the store's business and only this
 * one prefix is being moved.
 */
function repointProfiles(manifest: string, from: string, to: string): void {
  if (!existsSync(manifest)) return
  const escape = (dir: string) =>
    JSON.stringify(path.join(dir, "workspace", "claude-profiles")).slice(1, -1)
  const text = readFileSync(manifest, "utf8")
  const next = text.split(escape(from)).join(escape(to))
  if (next !== text) writeFileSync(manifest, next)
}

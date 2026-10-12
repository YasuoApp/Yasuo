/**
 * Naming the directory a profile's `CLAUDE_CONFIG_DIR` points at.
 *
 * **The path is the app's, not the user's.** Settings used to ask for it: a
 * text field per row, an empty default, and a paragraph explaining that nothing
 * there would create the directory. That made the one thing being asked of the
 * user the one thing they had no way to know the answer to — a config directory
 * is not a setting, it is a place, and any place would have done. So the field
 * is gone and this module answers instead. `docs/design.md` § Settings has the
 * argument, including what deleting it cost: a profile can no longer be pointed
 * at a config directory somebody already keeps.
 *
 * **Decided in the main process, and that is not a formality**: the root is
 * under the store's own workspace directory, which `VSCLAUDE_DATA_DIR` can move —
 * a renderer building `~/.vsclaude/…` for itself would write the wrong path for
 * anybody who has moved the tree, including this repo's own tests.
 *
 * The root is passed in rather than read here, which keeps this file free of
 * both `electron` and the store: the naming below is what
 * `test/claude-account.ts` checks.
 */

import path from "node:path"

import type { ClaudeProfile } from "../shared/api"

/**
 * The same profiles, with a directory filled in for any that has none — the
 * array itself when they all had one, so a caller can tell whether the file
 * needs rewriting.
 *
 * Called on the way in *and* on the way out of the manifest: on save because
 * that is where a new profile arrives with nothing but a name, and on read
 * because profiles written before the path was the app's to choose are sitting
 * on somebody's disk with an empty field and no field left to type into.
 */
export function withConfigDirs(
  profiles: ClaudeProfile[],
  root: string
): ClaudeProfile[] {
  if (profiles.every((profile) => profile.configDir.trim())) return profiles

  // The directories already spoken for, which the ones being filled in have to
  // clear as well as each other.
  const taken = profiles
    .map((profile) => profile.configDir.trim())
    .filter(Boolean)

  return profiles.map((profile) => {
    if (profile.configDir.trim()) return profile

    const dir = profileDir(root, profile.name, taken)
    taken.push(dir)
    return { ...profile, configDir: dir }
  })
}

/**
 * `<root>/<name>`, slugified, and the next free one after that.
 *
 * Named after the profile rather than given its id, because the directory
 * outlives every listing that explains it: somebody reading `claude-profiles/`
 * in a file browser, or exporting `CLAUDE_CONFIG_DIR` at a prompt to reach the
 * same login from their own terminal, has nothing but the folder name to go on.
 * A rename does **not** move it — a directory is where an account's tokens
 * already are, and moving one to keep a name tidy would sign the user out.
 *
 * Deduped, because two profiles on one directory are a single login wearing two
 * names: the app's own `accounts` map is keyed by directory, so the second row
 * would draw the first one's account and neither would be wrong on screen.
 */
export function profileDir(
  root: string,
  name: string,
  taken: string[]
): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile"
  const used = new Set(taken)

  for (let attempt = 1; ; attempt += 1) {
    const dir = path.join(root, attempt === 1 ? slug : `${slug}-${attempt}`)
    if (!used.has(dir)) return dir
  }
}

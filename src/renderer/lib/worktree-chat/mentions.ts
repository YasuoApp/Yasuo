import type { FileIndexEntry } from "@shared/api"

import { useFiles } from "../files/store"
import { gitStateOf, useGitStatus } from "../files/git-status"
import { isInside, relativeTo } from "../files/paths"
import {
  pathMentions,
  type IndexedPath,
  type PlainMention,
} from "./mention-text"

/**
 * What a chat's `@` menu offers: the folders and files of the checkout it is
 * running in, each with what mentioning it would cost the turn.
 *
 * The Explorer's index rather than a walk of its own — one answer to "what is in
 * this workspace", built once per run (`loadIndex`) and shared with the command
 * palette. It is also why the rows start where they do: the index never enters
 * `.git`, `node_modules`, `dist` and the rest (`IGNORED_DIRECTORIES` in
 * `main/files.ts`) and stops at twenty thousand paths.
 *
 * **And what git ignores is dropped on top of that.** A `.gitignore` is the
 * repository's own statement of what is not its source — build output, a
 * `.env`, a lockfile somebody generates — and none of it is what a sentence
 * means by "look at this file". The fixed list above cannot know any of it,
 * since it is per repository. Unlike the palette, which still lists an ignored
 * file: `⌘P` is somebody looking for a file they know is there, and this is a
 * menu offering what is worth pointing a turn at.
 *
 * Read from what Explorer already has (`lib/files/git-status.ts`) rather than
 * asked for here: that store holds one `git status --ignored` per root for the
 * tree's colours, and a second reader of the same question would drift from it
 * the first time one of the two refreshed. It also means git does the ignore
 * parsing — nesting, negation, `.git/info/exclude`, the user's global excludes
 * — which is the reason `main/files.ts` never tried to.
 *
 * Scoped to the chat's own checkout, and the paths are relative to it: the turn
 * runs there, so `src/main/ipc.ts` is both shorter than the absolute path and
 * what the agent would have typed. Without a root — a composer drawn with no
 * checkout behind it — the workspace's own relative paths are offered, which
 * still name something the user can read even if the agent's cwd differs.
 */

/**
 * The rows for one root, kept until the index or git's answer changes.
 *
 * The menu re-ranks on every keystroke and this is the part that is not cheap:
 * a status lookup per indexed path, then a pass over every file to total the
 * folders. Both inputs are replaced wholesale rather than mutated — `loadIndex`
 * hands back a new array, `refresh` a new `byRoot` — so their identities are the
 * whole of the cache key, and a commit or a refresh rebuilds this.
 */
let cache: {
  index: FileIndexEntry[]
  status: Record<string, unknown>
  root: string
  rows: PlainMention[]
} | null = null

export function chatMentions(root?: string): PlainMention[] {
  const index = useFiles.getState().index
  const status = useGitStatus.getState()
  const scope = root ?? ""
  if (
    cache &&
    cache.index === index &&
    cache.status === status.byRoot &&
    cache.root === scope
  ) {
    return cache.rows
  }

  const scoped: IndexedPath[] = []
  for (const entry of index) {
    if (scope && !isInside(scope, entry.path)) continue
    // A folder git reports wholesale takes its contents with it: `gitStateOf`
    // answers for a path inside `dist/` from the one entry git gave for it.
    if (gitStateOf(status, entry.path) === "ignored") continue
    const relative = scope ? relativeTo(scope, entry.path) : entry.relative
    // The root itself relativises to "", which is not a path anybody can mean.
    if (!relative) continue
    scoped.push({ relative, kind: entry.kind, bytes: entry.bytes })
  }

  const rows = pathMentions(scoped)
  cache = { index, status: status.byRoot, root: scope, rows }
  return rows
}

/**
 * Walks the workspace if nothing has yet, and reads git if nothing has, so the
 * first `@` of a launch is neither an empty menu nor one full of build output.
 *
 * Both are built on demand rather than at launch — Explorer makes the same two
 * calls — and both are a no-op once they exist. A failure leaves the menu
 * either empty or unfiltered, which the stores have already logged: nothing
 * here is worth a dialog over.
 */
export function primeMentions(): void {
  void useFiles.getState().loadIndex()
  if (Object.keys(useGitStatus.getState().byRoot).length === 0) {
    void useGitStatus.getState().refreshAll()
  }
}

import { useEffect, useState } from "react"

import type { AgentCommand } from "@shared/api"

import { visibleCommands } from "./command-text"

/**
 * The slash commands the user's own `claude` has, for the composer's `/` menu.
 *
 * A hook rather than a store, like `useAgentModels` and for the same reason:
 * there is nothing to keep. The list is whatever the CLI said, nothing in this
 * app writes to it, and the CLI's own list does not move under a live session
 * either — `/reload-skills` exists precisely because it does not.
 *
 * **Per project**, unlike the model list. A repository's own `.claude/commands`
 * and its skills belong to that checkout, so a chat in one project and a chat in
 * another are looking at different lists, and one cache for both would offer the
 * first project's commands in the second.
 *
 * **Asked when a menu is first wanted, not on mount** — which is what `wanted`
 * is for. The model list is fetched on mount because the toolbar draws the
 * model's *name* before anything is clicked; nothing here is on screen until a
 * `/` is typed, and spawning a `claude` per composer that mounts would be a
 * process for every tab switch. The cost of that choice is one visible beat on
 * the first `/` of a project, which is what `loading` is for.
 *
 * **The answer lives in the module, not in the state.** Two composers can be
 * mounted at once and a chat can be switched under one of them, so the cache is
 * shared and read at render; `landed` is only a counter that says a promise has
 * settled and this hook should look again. Written that way rather than as a
 * `setCommands` in the effect because copying a value that is already in hand
 * into state is a second render for nothing — and the shared answer would then
 * exist in as many copies as there are composers.
 */

/** Shared by every composer in the window, by project: the promise, so two
 * asking at once make one call, and the answer, so a later one makes none. */
const asked = new Map<string, Promise<AgentCommand[]>>()
const held = new Map<string, AgentCommand[]>()

/** One key for "no project", so a chat outside one shares the home-directory
 * answer rather than asking again under a different empty name. */
function keyOf(folderId: string | null): string {
  return folderId ?? ""
}

/**
 * The empty answer, as one array rather than a fresh one per render.
 *
 * Load-bearing: the composer re-runs its menu off this identity, so a new `[]`
 * every render would refresh the menu on every render, and the menu's own
 * `setMenu` would render again. A literal here is an infinite loop.
 */
const NONE: AgentCommand[] = []

export function useAgentCommands(
  folderId: string | null,
  /** Whether this composer has any use for the list yet — false until the first
   * `/` is typed in it. Latched by the caller rather than tracked here: a menu
   * that closes is not a reason to forget an answer already paid for. */
  wanted: boolean
): {
  commands: AgentCommand[]
  loading: boolean
  /** What went wrong, for the menu's one-line footer. Null while it is only
   * empty — a project whose CLI genuinely has no commands is not an error. */
  error: string | null
} {
  const key = keyOf(folderId)

  const [, setLanded] = useState(0)
  /** Kept with the project it belongs to, so a failure in one does not follow
   * the composer into the next chat it is switched to. */
  const [failure, setFailure] = useState<{
    key: string
    message: string
  } | null>(null)

  useEffect(() => {
    if (!wanted || held.has(key)) return

    let mounted = true
    let ask = asked.get(key)
    if (!ask) {
      ask = window.desktop.agentCommands(folderId).then((listing) => {
        // Thrown rather than carried, so a failed ask is not cached: `asked` is
        // cleared below and the next `/` tries again. A `claude` that was
        // missing at launch is found once it is installed.
        if (listing.error) throw new Error(listing.error)
        return visibleCommands(listing.commands)
      })
      asked.set(key, ask)
    }

    void ask
      .then((answer) => {
        held.set(key, answer)
        if (mounted) setLanded((count) => count + 1)
      })
      .catch((error: unknown) => {
        asked.delete(key)
        if (!mounted) return
        setFailure({
          key,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      mounted = false
    }
  }, [key, folderId, wanted])

  const commands = held.get(key) ?? NONE
  const error = failure?.key === key ? failure.message : null

  return {
    commands,
    // Nothing to show and nothing to say yet: an ask is out. Derived rather than
    // held, so it cannot disagree with what is actually in the cache.
    loading: wanted && !held.has(key) && !error,
    error,
  }
}

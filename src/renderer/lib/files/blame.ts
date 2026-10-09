import { create } from "zustand"

import type { ChatBlame, Snapshot } from "@shared/api"

/**
 * Which chat wrote each line of an open file — the editor's blame gutter.
 *
 * The answer comes from main (`chatBlame`), which runs `git blame` over the
 * snapshot chain for the text it is handed, so the store's job is the two
 * things an editor cannot do for itself: not ask on every keystroke, and not
 * draw an answer about text that has since been typed over. The pure helpers
 * under it turn the per-line answer into what the gutter draws, and those are
 * what `test/chat-blame.ts` checks.
 */

/**
 * How long the buffer is left alone before it is blamed again. Typing is a
 * burst of changes; one blame at the end of it is the one somebody looks at,
 * and a `git blame` per keystroke on a large file would queue behind itself.
 */
const DEBOUNCE_MS = 300

/** The palette has this many lanes; `colorOf` folds a chat id into one. */
export const BLAME_COLORS = 8

/** A stretch of consecutive lines from one snapshot. `from` inclusive, `to`
 * exclusive, both 0-based into `ChatBlame.lines`. */
export type BlameRun = { from: number; to: number; snapshotId: string }

/**
 * Contiguous runs of one snapshot, so the gutter labels a block once rather
 * than every line of it. Lines no snapshot wrote (`null`) are not runs: they
 * are the gaps between them.
 */
export function runsOf(lines: (string | null)[]): BlameRun[] {
  const runs: BlameRun[] = []
  let open: BlameRun | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const id = lines[i]
    if (open && id === open.snapshotId) {
      open.to = i + 1
      continue
    }
    open = id === null ? null : { from: i, to: i + 1, snapshotId: id }
    if (open) runs.push(open)
  }
  return runs
}

/**
 * A stable lane for a chat, from a hash of its id — so the same chat is the
 * same colour in every file and across launches, with no table to keep.
 * FNV-1a, because it is short and its low bits are well spread, which is all a
 * modulo-eight ask of a hash.
 */
export function colorOf(chatId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < chatId.length; i += 1) {
    hash ^= chatId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % BLAME_COLORS
}

function titleOf(snapshot: Snapshot, chats: ChatBlame["chats"]): string {
  const title = chats[snapshot.chatId]?.title.trim()
  return title || "Untitled chat"
}

/** The gutter's short label: the chat and the turn. */
export function labelOf(snapshot: Snapshot, chats: ChatBlame["chats"]): string {
  const title = titleOf(snapshot, chats)
  // A `before` snapshot is the tree as a turn started, so its lines are the
  // previous turn's work at the latest — "before turn n" is the honest word.
  if (snapshot.kind === "before")
    return `${title} · before turn ${snapshot.turn + 1}`
  if (snapshot.kind === "rewind") return `${title} · rewind`
  return `${title} · turn ${snapshot.turn}`
}

const PROMPT_EXCERPT = 160

/** The hover: the label, then the prompt that started the turn, then when. */
export function hoverOf(snapshot: Snapshot, chats: ChatBlame["chats"]): string {
  const lines = [labelOf(snapshot, chats)]
  const prompt = snapshot.prompt?.replace(/\s+/g, " ").trim()
  if (prompt) {
    lines.push(
      prompt.length > PROMPT_EXCERPT
        ? `${prompt.slice(0, PROMPT_EXCERPT - 1)}…`
        : prompt
    )
  }
  const at = new Date(snapshot.at)
  if (!Number.isNaN(at.getTime())) lines.push(at.toLocaleString())
  return lines.join("\n")
}

type BlameState = {
  /** The last answer per path. Null is an answer too: a file outside a
   * repository, or one no snapshot has touched. */
  byPath: Record<string, ChatBlame | null>
  /** Paths with a blame in flight or waiting on the debounce. */
  loading: string[]
  /** Asks for `text`'s blame after the pause, dropping any earlier ask for
   * the same path that has not gone out yet. */
  refresh: (path: string, text: string) => void
  /** Lets go of a path an editor has stopped showing. */
  forget: (path: string) => void
}

export const useBlame = create<BlameState>((set, get) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Bumped per path on every ask; an answer whose number has moved on is
   * about text that is no longer in the buffer and is dropped. */
  const generation = new Map<string, number>()
  /** What each held path was last blamed against, so a snapshot landing can
   * blame it again without the editor being asked. */
  const texts = new Map<string, string>()

  let listening = false
  const listen = () => {
    if (listening) return
    listening = true
    // Lazily, from the first ask rather than at import: the tests import the
    // helpers above from a process with no `window`.
    window.desktop.onSnapshotsChanged(() => {
      // Every held path rather than the folder's alone — the paths are not
      // mapped to folders here, and the set is the open editors, which is
      // small. The cached answer stays up until the new one lands, so the
      // gutter does not blink empty.
      for (const [path, text] of texts) get().refresh(path, text)
    })
  }

  const markLoading = (path: string, on: boolean) =>
    set((state) => {
      const has = state.loading.includes(path)
      if (has === on) return state
      return {
        loading: on
          ? [...state.loading, path]
          : state.loading.filter((entry) => entry !== path),
      }
    })

  return {
    byPath: {},
    loading: [],

    refresh(path, text) {
      listen()
      texts.set(path, text)
      const gen = (generation.get(path) ?? 0) + 1
      generation.set(path, gen)
      markLoading(path, true)

      const pending = timers.get(path)
      if (pending) clearTimeout(pending)
      timers.set(
        path,
        setTimeout(() => {
          timers.delete(path)
          void window.desktop
            .chatBlame(path, text)
            .catch((): ChatBlame | null => null)
            .then((blame) => {
              if (generation.get(path) !== gen) return
              markLoading(path, false)
              set((state) => ({ byPath: { ...state.byPath, [path]: blame } }))
            })
        }, DEBOUNCE_MS)
      )
    },

    forget(path) {
      const pending = timers.get(path)
      if (pending) clearTimeout(pending)
      timers.delete(path)
      texts.delete(path)
      // Bumped so an answer still in flight is dropped rather than cached for
      // nobody.
      generation.set(path, (generation.get(path) ?? 0) + 1)
      markLoading(path, false)
      set((state) => {
        if (!(path in state.byPath)) return state
        const byPath = { ...state.byPath }
        delete byPath[path]
        return { byPath }
      })
    },
  }
})

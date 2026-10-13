import { create } from "zustand"

import { useSettings } from "../settings"
import { useChanges } from "./changes"
import type { FileRoot } from "./roots"

/**
 * The commit box's state, per root, kept out of the component.
 *
 * Out of it because the box is unmounted under it: switching the `Git` tab to
 * `Commits`, or the Explorer to another project, takes `ChangesList` out of the
 * tree — and with `useState` that was a typed message gone, and a draft still
 * running whose answer landed in a component that no longer existed. Here the
 * draft finishes into the root it was asked for, and coming back finds it.
 *
 * In memory only, like `unread`: a message half-written is this run's, and
 * nothing about it is worth a file.
 */
export type CommitBoxState = {
  message: string
  committing: boolean
  drafting: boolean
  /** git's own refusal, or the draft's — drawn until the next attempt. */
  error: string | null
  /** What the last commit was, until the next word is typed. */
  done: string | null
}

const EMPTY: CommitBoxState = {
  message: "",
  committing: false,
  drafting: false,
  error: null,
  done: null,
}

type CommitBoxes = {
  byRoot: Record<string, CommitBoxState>
  setMessage: (rootId: string, message: string) => void
  commit: (root: FileRoot) => Promise<void>
  draft: (root: FileRoot) => Promise<void>
  stopDraft: (root: FileRoot) => void
}

/** Which press of Draft an answer belongs to, per root, so one that was
 * stopped — or overtaken by a commit — is dropped instead of landing over the
 * box. Not state: nothing draws it. */
const draftRuns: Record<string, number> = {}

export const useCommitBoxes = create<CommitBoxes>((set, get) => {
  const box = (rootId: string) => get().byRoot[rootId] ?? EMPTY
  const patch = (rootId: string, changes: Partial<CommitBoxState>) =>
    set((state) => ({
      byRoot: {
        ...state.byRoot,
        [rootId]: { ...(state.byRoot[rootId] ?? EMPTY), ...changes },
      },
    }))

  return {
    byRoot: {},

    setMessage(rootId, message) {
      // The last commit's line goes the moment the next message starts: it
      // describes what is no longer on screen.
      patch(rootId, { message, done: null })
    },

    async commit(root) {
      const { message, committing, drafting } = box(root.id)
      if (!message.trim() || committing) return
      // A draft still running is about what is being committed right now, and
      // would land over the message it was committed with.
      if (drafting) get().stopDraft(root)
      patch(root.id, { committing: true, error: null })
      try {
        const written = await useChanges.getState().commit(root, message)
        patch(root.id, {
          message: "",
          done: `${written.sha} · ${written.subject}`,
        })
      } catch (failed) {
        patch(root.id, {
          error: failed instanceof Error ? failed.message : String(failed),
        })
      } finally {
        patch(root.id, { committing: false })
      }
    },

    async draft(root) {
      const { drafting, committing } = box(root.id)
      if (drafting || committing) return
      const run = (draftRuns[root.id] = (draftRuns[root.id] ?? 0) + 1)
      patch(root.id, { drafting: true, error: null })
      const settings = useSettings.getState()
      // Settings › `Commit message drafts`, because this is the one read-only
      // `claude` with one place to be configured.
      const answer = await window.desktop
        .draftCommitMessage(
          root.folderId,
          settings.reviewModel,
          settings.reviewEffort,
          settings.reviewProfileId
        )
        .catch((failed: unknown) => ({
          error: failed instanceof Error ? failed.message : String(failed),
        }))
      if (run !== draftRuns[root.id]) return

      if ("error" in answer) {
        patch(root.id, { drafting: false, error: answer.error })
        return
      }
      // Replaced, not appended, and this is the one place the draft touches
      // something the user may have typed — which is why the button is theirs
      // to press and why what lands is editable rather than committed.
      patch(root.id, {
        drafting: false,
        message: answer.text.trim(),
        done: null,
      })
    },

    stopDraft(root) {
      draftRuns[root.id] = (draftRuns[root.id] ?? 0) + 1
      patch(root.id, { drafting: false })
      void window.desktop.cancelCommitDraft(root.folderId)
    },
  }
})

/** One root's box, with the empty one standing in until it is first touched. */
export function useCommitBox(rootId: string): CommitBoxState {
  return useCommitBoxes((state) => state.byRoot[rootId] ?? EMPTY)
}

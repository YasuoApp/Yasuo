import { useState, type KeyboardEvent } from "react"
import { Check, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Claude } from "@/components/ui/svgs/claude"
import { Textarea } from "@/components/ui/textarea"
import { useChanges } from "@/lib/files/changes"
import type { FileRoot } from "@/lib/files/roots"
import { useSettings } from "@/lib/settings"
import { isStudioShortcut } from "@/lib/shortcuts"

/**
 * The message, and the button that ends a reading of the diff.
 *
 * **This app did not commit, deliberately, and this is the reversal.** The rule
 * was that staging and discarding are answered by pointing at rows while a
 * commit is a *sentence somebody writes* — and a panel this narrow is a bad
 * place to write a paragraph, with a shell one click away in the dock that is a
 * better one. What changed is the sentence: the read-only `claude` this app
 * already runs can draft it off the staged diff (`draftCommitMessage`), so the
 * gesture is now reading a diff and then ending that reading, which is the one
 * thing every other panel here lets somebody do to what it is showing.
 *
 * The line moved by exactly one step and no further. There is no amend, no log,
 * no branch and no push, and there will not be: those are a git client, and the
 * shell in the dock is a better one than this would ever become.
 * `docs/design.md` § Committing carries the argument in full.
 *
 * Drawn only when something is **staged**, which is also what makes it honest
 * about what it commits. A box that was always there would be a box that
 * commits nothing most of the time, and one that committed the working tree
 * would be a second meaning for `Staged` two rows below it.
 */
export function CommitBox({ root }: { root: FileRoot }) {
  const [message, setMessage] = useState("")
  const [committing, setCommitting] = useState(false)
  const [drafting, setDrafting] = useState(false)
  /** git's own refusal, or the draft's — drawn until the next attempt. Not a
   * toast: what it is about is on screen, and the message it happened to is
   * still in the box. */
  const [error, setError] = useState<string | null>(null)
  /** What the last commit was, until the next word is typed. The list empties
   * itself the moment a commit lands, so without this the only sign that
   * anything happened is rows disappearing — which is also what `Discard all`
   * looks like. */
  const [done, setDone] = useState<string | null>(null)

  const busy = committing || drafting

  async function commit() {
    if (!message.trim() || busy) return
    setCommitting(true)
    setError(null)
    try {
      const written = await useChanges.getState().commit(root, message)
      setMessage("")
      setDone(`${written.sha} · ${written.subject}`)
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : String(failed))
    } finally {
      setCommitting(false)
    }
  }

  async function draft() {
    if (busy) return
    setDrafting(true)
    setError(null)
    const settings = useSettings.getState()
    // Settings › `Helper turns`, because this is the one read-only `claude`
    // with one place to be configured.
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
    setDrafting(false)

    if ("error" in answer) {
      setError(answer.error)
      return
    }
    // Replaced, not appended, and this is the one place the draft touches
    // something the user may have typed — which is why the button is theirs to
    // press and why what lands is editable rather than committed.
    setMessage(answer.text.trim())
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 px-3 py-2">
      <Textarea
        value={message}
        onChange={(event) => {
          setMessage(event.target.value)
          // The last commit's line goes the moment the next message starts:
          // it describes what is no longer on screen.
          if (done) setDone(null)
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          // ⌘⏎ commits, which is the shortcut every message box in every forge
          // and editor has. A bare Enter must not: a commit message has a body,
          // and this is the field it is typed in.
          // Lowercased, which is what `isStudioShortcut` compares against.
          if (!isStudioShortcut(event.nativeEvent, "enter")) return
          event.preventDefault()
          void commit()
        }}
        placeholder="Message (⌘⏎ to commit)"
        // Two lines to start with, which is a subject and the blank line under
        // it — the shape of the message this is for. It grows as one is typed.
        rows={2}
        className="min-h-14 resize-none text-xs"
      />

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void draft()}
          className="h-6 gap-1.5 px-2 text-[0.6875rem]"
          title="Have Claude write a message from the staged diff"
        >
          {drafting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Claude className="size-3" />
          )}
          Draft
        </Button>

        <div className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground">
          {/* One line, and the failure wins it: an error and a receipt are
              never both news, and the error is the one somebody has to act
              on. */}
          {error ? (
            <span className="text-destructive" title={error}>
              {error}
            </span>
          ) : done ? (
            <span className="flex items-center gap-1" title={done}>
              <Check className="size-3 shrink-0" />
              <span className="truncate">{done}</span>
            </span>
          ) : null}
        </div>

        <Button
          size="sm"
          disabled={busy || !message.trim()}
          onClick={() => void commit()}
          className="h-6 px-2 text-[0.6875rem]"
        >
          {committing ? <Loader2 className="size-3 animate-spin" /> : null}
          Commit
        </Button>
      </div>
    </div>
  )
}

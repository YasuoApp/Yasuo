import type { KeyboardEvent } from "react"
import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Claude } from "@/components/ui/svgs/claude"
import { Textarea } from "@/components/ui/textarea"
import { useCommitBox, useCommitBoxes } from "@/lib/files/commit-box"
import type { FileRoot } from "@/lib/files/roots"
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
  // In a store rather than `useState`: this box is unmounted by switching the
  // `Git` tab to `Commits`, and a draft or a typed message has to survive that.
  const { message, committing, drafting, error, done } = useCommitBox(root.id)
  const boxes = useCommitBoxes.getState()
  const commit = () => boxes.commit(root)
  const draft = () => boxes.draft(root)
  const stopDraft = () => boxes.stopDraft(root)

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 px-3 py-2">
      {/* `rounded-lg` is the textarea's own, which the ring inherits; the
          border is the textarea's too, so the ring does not reach past it. */}
      <div
        className="border-run rounded-lg [--run-edge:0px]"
        data-running={drafting || undefined}
      >
        <Textarea
          value={message}
          onChange={(event) => boxes.setMessage(root.id, event.target.value)}
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
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={committing}
          onClick={() => (drafting ? stopDraft() : void draft())}
          className="h-6 gap-1.5 px-2 text-[0.6875rem]"
          title={
            drafting
              ? "Stop drafting"
              : "Have Claude write a message from the staged diff"
          }
        >
          {drafting ? (
            <Spinner className="size-3" />
          ) : (
            <Claude className="size-3" />
          )}
          {drafting ? "Stop" : "Draft"}
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
          disabled={committing || !message.trim()}
          onClick={() => void commit()}
          className="h-6 px-2 text-[0.6875rem]"
        >
          {committing ? <Spinner className="size-3" /> : null}
          Commit
        </Button>
      </div>
    </div>
  )
}

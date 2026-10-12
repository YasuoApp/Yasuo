import { useEffect, useRef, useState, type ReactNode } from "react"

import { stemEnd } from "@/lib/files/paths"
import { cn } from "@/lib/utils"
import { SIDE_ROW_SHAPE, sideRowIndent } from "./side-row"

/**
 * A sidebar row while it is being renamed: the name replaced by a field, in
 * place, the way every editor's tree does it.
 *
 * Every list in the studio renames this way — the Explorer's files and
 * directories, the saved requests and their folders, and a session. It used to be a dialog for all of them, which asked for the one thing
 * the row was already showing, in a box over the top of it. What is still a
 * dialog is the two renames that are not a row's own name: a workspace folder,
 * whose name is the studio's label and not the directory on disk and which needs
 * somewhere to say so, and a database table or column, where a rename is a
 * schema change run against a server rather than a label being corrected.
 *
 * A field cannot live inside the row's `<button>` — an input in a button is
 * neither valid markup nor something that can be typed into — so this is a `div`
 * wearing the row's own geometry (`SIDE_ROW_SHAPE`), which is exported from
 * `side-row.tsx` for exactly this and so the two cannot drift apart.
 *
 * **Enter renames, Escape leaves it alone, and clicking away renames** — what the
 * editors do. A rename that fails keeps the field open with the caret back in it
 * and the reason under the row: the name is wrong and it is still the best thing
 * to start from.
 */
export function RenameRow({
  name,
  indent = 0,
  selection = "all",
  label,
  lead,
  onRename,
  onCancel,
}: {
  /** What the row is called now, which is what the field opens with. */
  name: string
  indent?: number
  /**
   * How much of the name opens selected.
   *
   * `"stem"` for a file, whose extension is a fact about it rather than a name
   * someone chose: renaming `report.txt` is renaming `report`, and an extension
   * typed over by accident is a file the editor opens as something else.
   * Everything else is `"all"` — a directory can have a dot in its name and mean
   * it, and a note, a request or a session has no extension for this to be
   * about.
   */
  selection?: "all" | "stem"
  /** The accessible name for the field, e.g. "Folder name". */
  label: string
  /** The chevron, icon or method badge from the row this stands in for, so the
   * field opens exactly where the name was rather than a few pixels off it. */
  lead?: ReactNode
  /** Resolves to why the name was refused, or null. Shown under the row, so it
   * can be fixed rather than retyped. */
  onRename: (name: string) => Promise<string | null>
  onCancel: () => void
}) {
  const field = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  /* Whether this rename has already been decided, so the blur that follows Enter
     or Escape does not ask a second time. Both of those move focus — Escape by
     unmounting this, Enter by way of the rename itself — and a blur handler that
     committed again would rename the *renamed* thing. */
  const settled = useRef(false)

  useEffect(() => {
    const input = field.current
    if (!input) return
    input.focus()
    input.setSelectionRange(
      0,
      selection === "stem" ? stemEnd(name) : name.length
    )
    // The name it opened with is the one being replaced; re-selecting on a later
    // render would swallow what has been typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function cancel() {
    settled.current = true
    onCancel()
  }

  async function commit() {
    const input = field.current
    if (!input || settled.current) return

    const next = input.value.trim()
    // Nothing to do and nothing to report: a field left unchanged is the same
    // gesture as Escape.
    if (!next || next === name) return cancel()

    settled.current = true
    const failure = await onRename(next)
    if (!failure) return

    setError(failure)
    // Open again, with the caret back in it.
    settled.current = false
    field.current?.focus()
  }

  /* The field is deliberately never disabled while a rename is in flight.
     Disabling a focused input blurs it, which would arrive here as a second
     commit — and re-enabling it a render later means the `focus()` above lands on
     an input that is still disabled and does nothing. `settled` is what stops a
     second rename; there is nothing to wait for on screen. */

  return (
    <>
      <div style={sideRowIndent(indent)} className={SIDE_ROW_SHAPE}>
        {lead}
        <input
          ref={field}
          defaultValue={name}
          spellCheck={false}
          aria-label={label}
          aria-invalid={error !== null}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void commit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              cancel()
            }
          }}
          onBlur={() => void commit()}
          className={cn(
            "min-w-0 flex-1 rounded-sm border bg-background px-1 py-0 text-xs text-foreground outline-none",
            error ? "border-destructive" : "border-ring"
          )}
        />
      </div>
      {error && (
        <p
          style={sideRowIndent(indent)}
          className="py-0.5 pr-2 text-[0.7rem] text-destructive"
        >
          {error}
        </p>
      )}
    </>
  )
}

/**
 * Keeps a closing context menu from taking focus off the field it just opened.
 *
 * Base UI moves focus back to the trigger when a menu closes, which is right for
 * every item except a rename: that one puts a text field in the row, and a field
 * that loses focus the instant it appears is one the next keystroke goes nowhere
 * near — worse, the blur commits an unchanged name and closes it again.
 *
 * So the item that means to take focus calls `handOff` and the menu asks
 * `finalFocus`, which answers for that one close and goes back to the default.
 * Spelled out here rather than in each of the four sidebars, because it is not a
 * detail any of them would think to write twice.
 */
export function useMenuFocusHandoff(): {
  handOff: () => void
  finalFocus: () => boolean
} {
  const takesFocus = useRef(false)

  return {
    handOff: () => {
      takesFocus.current = true
    },
    finalFocus: () => {
      const takes = takesFocus.current
      takesFocus.current = false
      return !takes
    },
  }
}

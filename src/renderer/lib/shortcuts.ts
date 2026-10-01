import { IS_MAC } from "@/components/studio/title-bar"

/**
 * Whether a keydown is one of the studio's own window shortcuts, and one it is
 * entitled to take.
 *
 * The five there are — `⌘P` for the search palette, `⌘F` for the chat pane's
 * find bar, `⌘W` for the tab strip, `⌘S` for the Explorer's open file, `⌘B` for
 * the sidebar — agree on everything but the letter, and are answered in the
 * places that know what they act on rather than in a keymap here: the palette
 * owns its own dialog, which tab is the current one is only the strip's answer,
 * only the Explorer knows which file is on screen, and the sidebar is the
 * workbench's own. What they share is this predicate.
 *
 * `⌘F` is the one that has to ask a second question before it takes the key, and
 * the chat pane asks it: every editor here is CodeMirror with `searchKeymap`, so
 * inside a file or a diff that key belongs to the text on screen. It is claimed
 * only while the chat pane is the one showing — which that pane can answer and
 * this predicate cannot, since the panes are hidden rather than unmounted.
 *
 * `⌃` on macOS and `⌘` elsewhere are refused rather than ignored, so that
 * `⌃⌘W` — a chord something may yet be given — is not read as `⌘W` with a key
 * held down.
 */
export function isStudioShortcut(event: KeyboardEvent, key: string): boolean {
  if (event.repeat) return false
  if (event.key.toLowerCase() !== key) return false
  if (event.altKey || event.shiftKey) return false
  if (IS_MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey) return false
  if (!IS_MAC && event.metaKey) return false

  /*
   * Off macOS these are all `Ctrl`-, and the letters are readline's before
   * they are ours: `Ctrl+P` walks a shell's history, `Ctrl+W` deletes the word
   * behind the cursor and `Ctrl+S` stops the terminal's output. The dock's
   * shell keeps them — the editing keys of the thing running in the pty are not
   * the studio's to take, and there is no second way to press them. Nothing is given up on macOS,
   * where xterm never sends `⌘` to the process.
   */
  if (!IS_MAC && inTerminal(event.target)) return false

  return true
}

/**
 * `⇧⌘F` — the left column's Search, which is the key the editors give `Find in
 * files`. The one studio letter with Shift, so it cannot go through
 * `isStudioShortcut`, which refuses Shift so that `⇧⌘W` is not read as `⌘W`.
 * Nothing in CodeMirror's keymap uses it.
 */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.repeat) return false
  if (event.key.toLowerCase() !== "f") return false
  if (event.altKey || !event.shiftKey) return false
  if (IS_MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey) return false
  if (!IS_MAC && event.metaKey) return false
  return IS_MAC || !inTerminal(event.target)
}

/** Whether the key was pressed inside a terminal, where xterm hands it to the
 * process. */
function inTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".xterm") !== null
}

/**
 * `⌃\`` — the dock's Terminal tab, which is the key the editors bind it to.
 *
 * `Ctrl` on **every** platform, macOS included, which is what VS Code does too:
 * the key is the editor's convention rather than the platform's, and `⌘\`` on
 * macOS is already the system's "next window".
 *
 * Read off `event.code`, not `event.key`: the binding is the physical key beside
 * `1`, and what `key` reports for it with `Ctrl` held varies by layout. Shift is
 * refused rather than accepted, so the key sometimes written `⌃~` is not this
 * one — that leaves `⌃⇧\`` free, which is where those editors put "new
 * terminal" if this ever grows one.
 *
 * **Not refused inside a terminal**, unlike the letters above. A pty has nothing
 * bound to `⌃\``, and hiding the panel from inside the shell — having just run
 * something in it — is most of what the key is for.
 */
export function isTerminalShortcut(event: KeyboardEvent): boolean {
  if (event.repeat) return false
  if (event.code !== "Backquote") return false
  if (event.altKey || event.shiftKey || event.metaKey) return false
  return event.ctrlKey
}

/**
 * `⌘⇧[` / `⌘⇧]` — the tab to the left or right of the one on screen, the key
 * the editors and the browsers agree on for it; `Ctrl+PageUp` / `Ctrl+PageDown`
 * elsewhere, which is theirs too. `Ctrl+Tab` / `Ctrl+⇧Tab` on every platform
 * besides, since it is the one everybody tries first.
 *
 * `-1`, `1`, or null for a key that is not this. Read off `event.code` for the
 * brackets, as `⌃\`` is: with Shift held, `key` is `{` on one layout and
 * something else on the next.
 *
 * Refused inside a terminal off macOS like the letters are — `Ctrl+PageUp` is
 * the shell's own history on some setups, and `Ctrl+Tab` is a pty's to lose.
 */
export function tabStepOf(event: KeyboardEvent): -1 | 1 | null {
  if (event.repeat || event.altKey) return null
  if (!IS_MAC && inTerminal(event.target)) return null

  if (event.ctrlKey && !event.metaKey && event.code === "Tab") {
    return event.shiftKey ? -1 : 1
  }

  if (IS_MAC) {
    if (!event.metaKey || event.ctrlKey || !event.shiftKey) return null
    if (event.code === "BracketLeft") return -1
    if (event.code === "BracketRight") return 1
    return null
  }

  if (!event.ctrlKey || event.metaKey || event.shiftKey) return null
  if (event.code === "PageUp") return -1
  if (event.code === "PageDown") return 1
  return null
}

/**
 * `⌘1` … `⌘9` — the n-th tab, with `9` the last one whatever the count, which
 * is the browsers' reading and the editors'. `Ctrl` off macOS.
 *
 * The 1-based number, or null. `Digit` codes rather than `key`, so a layout
 * that puts symbols on the unshifted row still answers.
 */
export function tabNumberOf(event: KeyboardEvent): number | null {
  if (event.repeat || event.altKey || event.shiftKey) return null
  if (IS_MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey) return null
  if (!IS_MAC && event.metaKey) return null
  if (!IS_MAC && inTerminal(event.target)) return null

  const match = /^Digit([1-9])$/.exec(event.code)
  return match ? Number(match[1]) : null
}

/**
 * Whether the caret is in a rich-text editor, where `⌘B` is bold.
 *
 * The one shortcut that has to ask. `⌘P`, `⌘W` and `⌘S` mean nothing to
 * ProseMirror, but `⌘B` is bold in every editor there has ever been — and this
 * studio has three of them on screen at once: a note, a `.md` opened in the
 * block editor, and the chat composer. Taking the key on the capture phase
 * would take it *before* the editor saw it, so a note would have no way to bold
 * a word. The sidebar has a menu item, a rail click and a second way in;
 * bolding text does not.
 *
 * Asked of the element rather than of the editor libraries: `contenteditable`
 * is what they all have in common, and it is also true of anything else that
 * accepts rich text, which is the right answer for those too. A plain `<input>`
 * or a code editor is not one — neither does anything with `⌘B` — so the sidebar keeps
 * the key while a name is being typed or a file edited, exactly as it does in
 * the editor this borrows the shortcut from.
 */
export function isEditingRichText(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.isContentEditable
}

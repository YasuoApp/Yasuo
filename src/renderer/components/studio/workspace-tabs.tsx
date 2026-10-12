import { useEffect } from "react"

import {
  closeAllTabs,
  closeOtherTabs,
  closeShownTab,
  closeTab,
  keepTab,
  reorderTabs,
  selectTab,
  tabIds,
  useActiveTabId,
} from "@/lib/panels"
import { isStudioShortcut, tabNumberOf, tabStepOf } from "@/lib/shortcuts"
import { useStudio, type Pane } from "@/lib/store"
import { useTabItems } from "./tab-items"
import { TabStrip } from "./tab-strip"

/**
 * One strip of tabs for the whole workbench, above whichever panel is showing.
 *
 * The panels each used to draw their own, which meant that leaving Database
 * for API took the tables off the screen — they were still open, but nothing
 * said so, and coming back was a trip through the rail. Since the strips were
 * identical anyway, they are now one: a table, a request, a spec and a session
 * sit side by side, and clicking any of them goes to the panel that shows it.
 *
 * Tabs open grouped by panel rather than interleaved in the order they were
 * opened, so an untouched strip reads as runs rather than a shuffle. Dragging
 * overrides that and may put a tab anywhere, including between two of another
 * panel's: the arrangement is the user's, and a strip that silently sprang a
 * tab back to its own run was refusing a move for a reason only the code knew.
 *
 * The order that results cannot live in any one panel — a request between two
 * tables is a position none of the three stores has anywhere to record — so it
 * is `tabOrder` on the studio store, and the panels keep only their own
 * membership. `arrange` in `lib/tabs.ts` reconciles the two.
 *
 * A tab here is not always one thing open. With grouping on, a panel's tabs are
 * gathered under the folder each belongs to and this strip holds one tab per
 * folder, with `GroupTabs` drawing that folder's own tabs inside it. Which ids
 * that leaves is `tabIds` in `lib/panels.ts`; what each of them looks like is
 * `useTabItems`, shared with the strip inside.
 */
export function WorkspaceTabs({ pane }: { pane: Pane }) {
  // Read for the subscription: the strip is `tabIds` reconciled against this,
  // and both are computed rather than held, so this is what tells the component
  // that a drag has changed the answer.
  useStudio((state) => state.tabOrder)

  const byId = useTabItems()
  const items = tabIds().flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })

  const activeId = useActiveTabId(pane)

  /*
   * ⌘W closes the tab the pane is showing, the way an editor's does.
   *
   * Answered here because the strip is where the key belongs: the File menu
   * cannot claim the accelerator — see `registerAccelerator` in
   * `electron/menu.ts` — so it displays the key and sends the intent, and this
   * is where both arrive.
   *
   * With an empty strip the key is left alone rather than swallowed: there is
   * no tab to close, and the window's own ⇧⌘W is the menu's.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isStudioShortcut(event, "w")) return
      if (!activeId) return

      event.preventDefault()
      closeShownTab(activeId)
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [activeId])

  /*
   * `⌘⇧[` / `⌘⇧]` and `⌘1`…`⌘9` — walking the strip from the keyboard.
   *
   * Over `items` rather than the panels' own lists, because the strip is the
   * order somebody can see: with grouping on a step lands on the next *folder*,
   * which is what the next tab on screen is. Wraps at either end, as a browser
   * does. `⌘9` is the last tab however many there are.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (items.length === 0) return

      const step = tabStepOf(event)
      if (step !== null) {
        event.preventDefault()
        const at = items.findIndex((item) => item.id === activeId)
        const next = items[(at + step + items.length) % items.length]
        if (next) selectTab(next.id)
        return
      }

      const number = tabNumberOf(event)
      if (number !== null) {
        const target =
          number === 9 ? items[items.length - 1] : items[number - 1]
        if (!target) return
        event.preventDefault()
        selectTab(target.id)
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [items, activeId])

  // The same intent from the menu, which is the way to it without a keyboard —
  // and, on the platforms where a session's terminal keeps Ctrl+W, the way to
  // it from a terminal.
  useEffect(
    () =>
      window.desktop.onMenuCommand((command) => {
        if (command === "close-tab" && activeId) closeShownTab(activeId)
      }),
    [activeId]
  )

  return (
    <TabStrip
      label="Open tabs"
      items={items}
      activeId={activeId}
      onSelect={selectTab}
      onKeep={keepTab}
      onClose={closeTab}
      onCloseOthers={closeOtherTabs}
      onCloseAll={closeAllTabs}
      onReorder={reorderTabs}
    />
  )
}

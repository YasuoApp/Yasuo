import { cn } from "@/lib/utils"

/**
 * Whether the window is leaving its title bar to the app.
 *
 * macOS hides the bar and insets the traffic lights into whatever is drawn at
 * the top (see `titleBarStyle` in electron/main.ts); Windows and Linux keep
 * their own frame, and need none of this.
 */
export const IS_MAC = window.desktop.platform === "darwin"

/** Whether there are traffic lights inset into the top-left to leave room for —
 * the Electron window on macOS. A browser tab on a Mac has keyboard shortcuts
 * on ⌘ (`IS_MAC`) and the browser's own frame around it. */
export const HAS_TRAFFIC_LIGHTS =
  IS_MAC && window.desktop.runtime === "electron"

/**
 * An invisible strip standing in for the title bar the window does not have.
 *
 * The workbench's own header is the drag handle in the normal case; this is
 * for the screens shown before it, or over it — the splash, a storage
 * failure, the setup overlay — where there would otherwise be nothing left to
 * drag the window by.
 *
 * Not `pointer-events-none` while it is on: a drag region has to be able to take
 * the press. Only use it where the top of the screen holds nothing clickable.
 *
 * **`active` is why this is a prop and not a mount.** macOS keeps a drag region
 * after the element that asked for it is gone (electron#20926), and this strip
 * covers the whole top of the window — including where the workbench then draws
 * its crumb and the `…` beside it. A stale rect there leaves those taking no
 * clicks, which reads as "the button works sometimes" rather than as a bug with
 * a cause. So the element stays in the tree and gives its rect up instead of
 * being unmounted: a live element that changes style is a region Chromium
 * recomputes, which is the case that works.
 *
 * The 64px it stops short of the right edge is the second line of defence, for
 * the button in that corner. Deliberately more than the button is wide, because
 * a stale rect is stale in its *coordinates* too — one left behind from another
 * window width can reach further in than the rect drawn here ever did.
 */
export function TitleBarDragStrip({ active = true }: { active?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "fixed top-0 right-16 left-0 z-50",
        // No height and no press once it is off: an empty rect is no rect, and
        // a full-width box over the header would otherwise swallow the clicks
        // this exists to protect.
        active ? "drag-region h-11" : "pointer-events-none h-0"
      )}
    />
  )
}

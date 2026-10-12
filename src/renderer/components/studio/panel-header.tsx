import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

import { SECTION_ACCENT } from "./section-marks"
import type { Section } from "@/lib/sections"

/**
 * Every panel's header already carries the label the rail uses for it, so the
 * hue follows from the title rather than from a prop each caller has to
 * remember to pass — and a header that is not a rail section simply gets none.
 *
 * Empty right now, and kept rather than removed with its two entries: the
 * Database and API headers were the only titles in it, and the mechanism is
 * what a third panel's header would use. Explorer was never in it — that
 * panel's header is two tabs (`All files | Changes`), and a title with a hue
 * beside it is what they replaced.
 */
const ACCENT_BY_TITLE: Record<string, Section> = {}

/**
 * A section's fold, handed to a panel by the column that stacks it.
 *
 * A pair rather than a boolean plus a callback prop on every panel: the three
 * lists pass it straight through to their own header, and a single object is
 * one thing to forward rather than two to keep in step.
 */
export type Fold = { open: boolean; onToggle: () => void }

/**
 * The header strip at the top of a sidebar panel: a section label, and the
 * actions that belong to that section.
 *
 * Shared so both sidebars — Files and Database — line up pixel for pixel with
 * each other and with the toolbars in the main pane, which all use the same
 * `h-9` strip. Each panel used to spell this out itself, and they had already
 * drifted apart.
 */
export function PanelHeader({
  title,
  children,
  open,
  onToggle,
}: {
  title: string
  children?: ReactNode
  /**
   * Whether the panel under this header is showing.
   *
   * Set only by the left column, which stacks four of these and folds them
   * (`WorkspaceSidebar`). A panel that fills its own space — the Explorer on
   * the right — leaves both of these off and the header is what it always was:
   * a label and its buttons, no chevron, nothing to click.
   */
  open?: boolean
  onToggle?: () => void
}) {
  const section = ACCENT_BY_TITLE[title]
  const accent = section ? SECTION_ACCENT[section] : undefined

  const label = (
    <>
      {accent && (
        <span
          aria-hidden
          style={{ backgroundColor: accent }}
          className="size-1.5 shrink-0 rounded-full"
        />
      )}
      <span className="truncate">{title}</span>
    </>
  )

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
      <h2 className="flex min-w-0 flex-1 items-center gap-2 text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase">
        {onToggle ? (
          // The whole label folds, not a chevron beside it: a 14px target in a
          // column somebody is flicking through is a target they miss.
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                open && "rotate-90"
              )}
            />
            {label}
          </button>
        ) : (
          label
        )}
      </h2>
      {children && (
        <div className="flex shrink-0 items-center gap-0.5">{children}</div>
      )}
    </div>
  )
}

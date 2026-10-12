import type { ComponentProps, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * An icon-only control with a real tooltip.
 *
 * The workbench is full of these — new file, reload, toggle a pane — and they
 * used to lean on the `title` attribute, which the OS renders in its own style
 * after its own delay. `label` does three jobs here: the tooltip, the
 * accessible name, and nothing else to keep in sync.
 *
 * **Everything it is not asked about goes to the button**, `ref` included, and
 * that is what makes it usable as another component's trigger. Base UI's
 * `render` prop clones the element it is handed and passes it the trigger's own
 * props — the ref it anchors a popup to, `aria-expanded`, `onMouseDown` — so a
 * component that names its props and drops the rest silently swallows all of
 * them: `DropdownMenuTrigger render={<IconButton …/>}` drew a button that
 * highlighted, toggled a menu open, and opened it against no anchor at all,
 * which reads as a button that does nothing. There is nothing to warn about it
 * either, since dropping a prop is what every component does with props it does
 * not take.
 */
export function IconButton({
  label,
  onClick,
  disabled = false,
  pressed,
  variant = "ghost",
  side,
  className,
  style,
  children,
  ...rest
}: {
  label: string
  /** Which side the tooltip goes on. Worth setting only where the default
   * (above) has nowhere to go — a button against the top of the window. */
  side?: "top" | "bottom" | "left" | "right"
  onClick?: () => void
  disabled?: boolean
  /** Set for a toggle, which dims itself when off. */
  pressed?: boolean
  variant?: "ghost" | "outline"
  className?: string
  children: ReactNode
} & Omit<
  ComponentProps<typeof Button>,
  "children" | "variant" | "size" | "disabled" | "onClick"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant={variant}
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
            aria-pressed={pressed}
            className={className}
            style={style}
            {...rest}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

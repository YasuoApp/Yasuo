import { BadgeCheck } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * The mark beside a plugin that ships with the app.
 *
 * Drawn off `bundled` and nothing else. A manifest's `author` is a string
 * anybody can type, so a badge read from it would be one a plugin could award
 * itself; whether a plugin came out of this app's own bundle is the one fact a
 * plugin cannot claim, because main decides it by which folder it was found in.
 */
export function OfficialBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label="Official — ships with Visual Studio Claude"
            className={cn("inline-flex shrink-0 text-primary", className)}
          >
            <BadgeCheck className="size-3.5" />
          </span>
        }
      />
      <TooltipContent>
        Official — ships with Visual Studio Claude
      </TooltipContent>
    </Tooltip>
  )
}

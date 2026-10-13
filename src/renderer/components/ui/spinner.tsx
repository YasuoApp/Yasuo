import { cn } from "@/lib/utils"

// The drawing is `.spinner` in `styles/motion.css`, which says why it is not
// lucide's `Loader2` any more.
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("spinner size-4 shrink-0", className)}
      {...props}
    />
  )
}

export { Spinner }

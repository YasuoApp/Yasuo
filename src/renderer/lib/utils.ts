import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// `text-chat` is a size from `globals.css`'s theme. Unregistered, the merge
// reads it as a colour and keeps the `text-sm` it was meant to replace, and
// which of the two wins is down to stylesheet order.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["chat"] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

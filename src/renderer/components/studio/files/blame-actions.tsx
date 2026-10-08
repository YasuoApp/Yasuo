import { createContext, use, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import {
  Check,
  Copy,
  FileCode,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquarePlus,
} from "lucide-react"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { BlameActions } from "@/lib/editor-git-blame"

/**
 * The blame card's buttons, as icons whose names are their tooltips — the card
 * is a hover over code, and a row of sentences under it was a second paragraph
 * to read past to get back to the line.
 *
 * React in a CodeMirror tooltip, mounted by hand: the card itself is DOM the
 * editor builds (`lib/editor-git-blame.ts`), and this is handed in from the
 * component side so that `lib/` does not import a component. Its own root, so
 * its own `TooltipProvider` — context does not cross roots. Rendered with
 * `flushSync` so the card has its full size when the editor measures it.
 */
export function mountBlameActions(
  host: HTMLElement,
  props: BlameActions
): () => void {
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <Layer value={host}>
        <TooltipProvider delay={400}>
          <Actions {...props} />
        </TooltipProvider>
      </Layer>
    )
  )
  // Unmounted on the next tick: the tooltip is destroyed inside a CodeMirror
  // update, which may itself be inside a React render.
  return () => queueMicrotask(() => root.unmount())
}

/**
 * Where the labels are portalled: into the card, not the body.
 *
 * The app's `IconButton` puts its tooltip on the body at `z-50`, and the card
 * is a CodeMirror tooltip — `z-index: 500`, inside the stacking context of the
 * pane that holds the editor — so the labels were drawn under the card they
 * name, and lowering the card did not reach past the pane. A label that is the
 * card's own child is above the card by construction, whatever the panes do.
 */
const Layer = createContext<HTMLElement | null>(null)

function ActionButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: ReactNode
}) {
  const container = use(Layer)
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            onClick={onClick}
            className={className}
          >
            {children}
          </Button>
        }
      />
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Positioner
          sideOffset={4}
          className="pointer-events-none isolate z-50"
        >
          <TooltipPrimitive.Popup className="pointer-events-none rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

function Actions({
  hash,
  summary,
  forge,
  commitHref,
  fileHref,
  issues,
  onAsk,
}: BlameActions) {
  const [copied, setCopied] = useState<"hash" | "message" | null>(null)

  function copy(what: "hash" | "message", text: string) {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1200)
  }

  // `window.open`, which `setWindowOpenHandler` in `main.ts` sends to the
  // system browser — and which the browser build opens as a tab.
  const open = (href: string) => window.open(href, "_blank", "noreferrer")

  return (
    <div className="flex items-center gap-0.5">
      <ActionButton
        label={copied === "hash" ? "Copied" : "Copy commit SHA"}
        onClick={() => copy("hash", hash)}
        className="w-auto px-1.5 font-mono text-[0.65rem] text-warning"
      >
        {hash.slice(0, 7)}
      </ActionButton>
      <ActionButton
        label={copied === "message" ? "Copied" : "Copy message"}
        onClick={() => copy("message", summary)}
      >
        {copied === "message" ? <Check /> : <Copy />}
      </ActionButton>
      <ActionButton label="Ask in chat" onClick={onAsk}>
        <MessageSquarePlus />
      </ActionButton>

      {forge && (
        <>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {commitHref && (
            <ActionButton
              label={`Open commit on ${forge}`}
              onClick={() => open(commitHref)}
            >
              <GitCommitHorizontal />
            </ActionButton>
          )}
          {fileHref && (
            <ActionButton
              label="Open file at this commit"
              onClick={() => open(fileHref)}
            >
              <FileCode />
            </ActionButton>
          )}
          {issues.map(({ number, href }) => (
            <ActionButton
              key={number}
              label={`Open #${number} on ${forge}`}
              onClick={() => open(href)}
            >
              <GitPullRequest />
            </ActionButton>
          ))}
        </>
      )}
    </div>
  )
}

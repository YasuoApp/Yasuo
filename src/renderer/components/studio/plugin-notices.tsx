import { X } from "lucide-react"

import { usePlugins } from "@/lib/plugins/store"

/**
 * What plugins said through `app.notice`, stacked in the corner.
 *
 * The studio has no toasts of its own — what it has to say is said beside the
 * thing it is about. A plugin has no such place yet, so this is the one
 * transient surface, and it carries the plugin's name so a line nobody expected
 * can be traced to what wrote it.
 */
export function PluginNotices() {
  const notices = usePlugins((state) => state.notices)
  const plugins = usePlugins((state) => state.plugins)
  const dismiss = usePlugins((state) => state.dismissNotice)

  if (notices.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-80 flex-col gap-2">
      {notices.map((notice) => {
        const name =
          plugins.find((plugin) => plugin.id === notice.pluginId)?.manifest
            ?.name ?? notice.pluginId
        return (
          <div
            key={notice.key}
            role="status"
            className="pointer-events-auto flex items-start gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[0.7rem] text-muted-foreground">{name}</p>
              <p className="break-words whitespace-pre-wrap">{notice.text}</p>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(notice.key)}
              className="shrink-0 rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

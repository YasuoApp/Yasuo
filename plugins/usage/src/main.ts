import { createElement } from "react"
import { createRoot, type Root } from "react-dom/client"

import type { PluginApp } from "@/lib/plugins/app"

import { CostDashboard } from "./dashboard"

/**
 * The usage dashboard: the rail's `Usage` button, and the same in the palette.
 *
 * It draws itself in a React root of its own on a node under `body` — the
 * dialog portals out of it anyway — with the app's React, which
 * `scripts/build-plugins.mjs` hands it instead of a copy. One dialog at a time:
 * a second press while it is up is the same dialog, not a twin over it.
 */
export default {
  onload(app: PluginApp) {
    let open: { root: Root; host: HTMLElement } | null = null

    const close = () => {
      if (!open) return
      open.root.unmount()
      open.host.remove()
      open = null
    }

    const show = () => {
      if (open) return
      const host = document.createElement("div")
      host.dataset.plugin = app.manifest.id
      document.body.append(host)
      const root = createRoot(host)
      open = { root, host }
      root.render(
        createElement(CostDashboard, {
          onClose: close,
          loadSpend: app.chats.spend,
          folders: app.folders(),
        })
      )
    }

    // Switching the plugin off with the dialog up takes the dialog down too.
    app.register(close)

    app.addRailButton({ id: "open", label: "Usage", icon: "chart", run: show })
    app.addCommand({ id: "open", name: "Show usage", run: show })
  },
}

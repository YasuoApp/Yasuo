import { create } from "zustand"

import {
  pluginUrl,
  type PluginInfo,
  type PluginInstall,
  type PluginSource,
} from "@shared/plugins"
import { getSetting, setSetting } from "@/lib/workspace"

import { createPluginApp } from "./app"
import { exposeSharedModules } from "./shared-modules"
import {
  PluginRegistry,
  type PluginChatMenuItem,
  type PluginRailButton,
} from "./registry"

/**
 * The plugins: which are on disk, which are switched on, and running them.
 *
 * A plugin of the user's is off until somebody switches it on in Settings ›
 * Plugins — it is code with the whole of this window's reach (`lib/plugins/app.ts`
 * says why that is not narrowed), so running one is a decision, never a
 * default. A **built-in** one is the other way round: it is a feature the app
 * has always had, moved into a plugin, and it is on until switched off.
 */

/** The user's plugins switched on, as a JSON array — a key of its own rather
 * than a field in `workbench.settings`, so the bag the Settings dialog rewrites
 * whole cannot drop it. */
const ENABLED_KEY = "plugins.enabled"

/** The built-in plugins switched off, the same way. Two lists rather than one
 * of everything on, so a built-in plugin added by an update starts on for
 * everybody without anybody's saved list having to know its name. */
const DISABLED_KEY = "plugins.disabled"

/** How long a plugin's `notice` stays up. */
const NOTICE_MS = 4000

export type PluginStatus =
  | { state: "off" }
  | { state: "loading" }
  | { state: "on" }
  | { state: "failed"; error: string }

export type PluginNotice = { key: number; pluginId: string; text: string }

type PluginsState = {
  loaded: boolean
  plugins: PluginInfo[]
  enabled: string[]
  disabled: string[]
  status: Record<string, PluginStatus>
  chatMenuItems: PluginChatMenuItem[]
  railButtons: PluginRailButton[]
  notices: PluginNotice[]

  /** Lists the directory and starts every plugin switched on. Once, at launch. */
  restore: () => Promise<void>
  /** Lists the directory again — a plugin dropped in since launch. */
  refresh: () => Promise<void>
  setEnabled: (id: string, on: boolean) => Promise<void>
  /** Unloads and imports a plugin again, for somebody editing its `main.js`. */
  reload: (id: string) => Promise<void>
  /**
   * Installs a plugin from a folder or a `.zip` the user picks, or updates the
   * one already installed under that id. A new plugin is left **off** — the
   * standing warning in Settings is the decision point, not the picker — and an
   * updated one that was running is reloaded onto its new files. Null when the
   * picker was cancelled; throws with the reason when the install was refused.
   */
  install: (source: PluginSource) => Promise<PluginInstall | null>
  /** Switches a user's plugin off and moves it to the trash. */
  remove: (id: string) => Promise<void>
  /** A notice in the plugin's name — `app.notice`. */
  notify: (pluginId: string, text: string) => void
  dismissNotice: (key: number) => void
}

const registry = new PluginRegistry()

let noticeKey = 0

export const usePlugins = create<PluginsState>((set, get) => {
  registry.subscribe(() =>
    set({
      chatMenuItems: registry.chatMenuList(),
      railButtons: registry.railButtonList(),
    })
  )

  const on = (id: string): boolean => {
    const state = get()
    const plugin = state.plugins.find((candidate) => candidate.id === id)
    return plugin ? isOn(plugin, state) : false
  }

  const setStatus = (id: string, status: PluginStatus) =>
    set((state) => ({ status: { ...state.status, [id]: status } }))

  const notice = (pluginId: string, text: string) => {
    const key = ++noticeKey
    set((state) => ({
      notices: [...state.notices, { key, pluginId, text }],
    }))
    setTimeout(() => get().dismissNotice(key), NOTICE_MS)
  }

  async function start(id: string): Promise<void> {
    const info = get().plugins.find((plugin) => plugin.id === id)
    if (!info?.manifest || info.error) {
      setStatus(id, {
        state: "failed",
        error: info?.error ?? "This plugin is not in the plugins folder.",
      })
      return
    }

    // Out first, before anything new is tracked against it: `registry.load`
    // would otherwise unload the copy already running and take the stylesheet
    // added below with it.
    if (registry.isLoaded(id)) await registry.unload(id)

    setStatus(id, { state: "loading" })
    const bust = String(Date.now())
    try {
      if (info.hasStyles) {
        const link = document.createElement("link")
        link.rel = "stylesheet"
        link.href = pluginUrl(id, "styles.css", bust)
        link.dataset.plugin = id
        document.head.append(link)
        registry.track(id, () => link.remove())
      }
      const exported: unknown = await import(
        /* @vite-ignore */ pluginUrl(id, "main.js", bust)
      )
      await registry.load(
        id,
        exported,
        createPluginApp(info.manifest, registry, notice)
      )
      setStatus(id, { state: "on" })
    } catch (error) {
      // The stylesheet was tracked before the import, so a failed load takes
      // it back out too.
      await registry.unload(id)
      setStatus(id, { state: "failed", error: messageOf(error) })
      console.error(`[plugin ${id}]`, error)
    }
  }

  async function stop(id: string): Promise<void> {
    for (const error of await registry.unload(id)) {
      console.error(`[plugin ${id}] unloading:`, error)
    }
    setStatus(id, { state: "off" })
  }

  async function list(): Promise<PluginInfo[]> {
    const plugins = await window.desktop.listPlugins()
    set({ plugins })
    return plugins
  }

  return {
    loaded: false,
    plugins: [],
    enabled: [],
    disabled: [],
    status: {},
    chatMenuItems: [],
    railButtons: [],
    notices: [],

    async restore() {
      if (get().loaded) return
      exposeSharedModules()
      const [plugins, enabled, disabled] = await Promise.all([
        list(),
        getSetting(ENABLED_KEY),
        getSetting(DISABLED_KEY),
      ])
      set({ loaded: true, enabled: idsOf(enabled), disabled: idsOf(disabled) })
      // Sequentially, in the listing's order — built-in first — so two plugins
      // adding the same thing land the same way round on every launch.
      for (const plugin of plugins) {
        if (on(plugin.id)) await start(plugin.id)
      }
    },

    async refresh() {
      await list()
    },

    async setEnabled(id, next) {
      const bundled = get().plugins.some(
        (plugin) => plugin.id === id && plugin.bundled
      )
      // A built-in plugin is recorded by being switched off, a user's by being
      // switched on — see `DISABLED_KEY`.
      const key = bundled ? "disabled" : "enabled"
      const listed = bundled ? !next : next
      const ids = listed
        ? [...new Set([...get()[key], id])]
        : get()[key].filter((candidate) => candidate !== id)
      set({ [key]: ids })
      await setSetting(
        bundled ? DISABLED_KEY : ENABLED_KEY,
        JSON.stringify(ids)
      )
      if (next) await start(id)
      else await stop(id)
    },

    async reload(id) {
      await stop(id)
      await list()
      if (on(id)) await start(id)
    },

    async install(source) {
      const installed = await window.desktop.installPlugin(source)
      if (!installed) return null
      await list()
      if (installed.replaced && registry.isLoaded(installed.id)) {
        await stop(installed.id)
        await start(installed.id)
      }
      return installed
    },

    async remove(id) {
      await stop(id)
      if (get().enabled.includes(id)) await get().setEnabled(id, false)
      await window.desktop.removePlugin(id)
      await list()
      set((state) => {
        const status = { ...state.status }
        delete status[id]
        return { status }
      })
    },

    notify: notice,

    dismissNotice(key) {
      set((state) => ({
        notices: state.notices.filter((entry) => entry.key !== key),
      }))
    },
  }
})

/** Whether a plugin is switched on: a built-in one unless it was switched off,
 * a user's only once it was switched on. */
export function isOn(
  plugin: PluginInfo,
  lists: { enabled: string[]; disabled: string[] }
): boolean {
  return plugin.bundled
    ? !lists.disabled.includes(plugin.id)
    : lists.enabled.includes(plugin.id)
}

function idsOf(stored: string | null): string[] {
  if (!stored) return []
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

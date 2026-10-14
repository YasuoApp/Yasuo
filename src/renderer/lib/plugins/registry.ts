/**
 * What each running plugin has put into the studio, so switching it off can
 * take all of it back out.
 *
 * Obsidian's bargain: a plugin never removes what it added — everything it
 * registers through the app is recorded against it here, and `unload` undoes
 * the lot in reverse. A plugin that forgot to unsubscribe from the chats is
 * then still a plugin that stops when it is switched off.
 *
 * Pure, with no store and no `window.desktop`, so `test/plugin-registry.ts` can
 * drive it; `lib/plugins/store.ts` holds one and `lib/plugins/app.ts` builds
 * what a plugin is handed on top of it.
 */

/**
 * The marks a plugin's menu item may carry, by name: a plugin cannot hand the
 * studio a React component, and an item with no mark sits misaligned in a menu
 * where every other one has one. `lib/plugins/icons.ts` draws them.
 */
export const PLUGIN_ICONS = [
  "copy",
  "download",
  "code",
  "file",
  "share",
  "chart",
  "puzzle",
] as const
export type PluginIcon = (typeof PLUGIN_ICONS)[number]

/** One item a plugin added to a chat row's context menu. */
export type PluginChatMenuItem = {
  /** `<plugin id>:<the plugin's own id>`, so two plugins can both call an
   * item `export` without one replacing the other. */
  id: string
  pluginId: string
  name: string
  icon: PluginIcon
  run: (chatId: string) => void | Promise<void>
}

/** One button a plugin added to the window's rail, under Search. */
export type PluginRailButton = {
  id: string
  pluginId: string
  label: string
  icon: PluginIcon
  run: () => void | Promise<void>
}

/** What `main.js` has to export as its default. */
export type PluginModule<App> = {
  onload: (app: App) => void | Promise<void>
  onunload?: () => void | Promise<void>
}

export class PluginRegistry {
  private readonly disposers = new Map<string, (() => void)[]>()
  private readonly chatMenuItems = new Map<string, PluginChatMenuItem>()
  private readonly railButtons = new Map<string, PluginRailButton>()
  private readonly modules = new Map<string, PluginModule<unknown>>()
  private readonly listeners = new Set<() => void>()

  /** Records something to undo when `pluginId` is unloaded. */
  track(pluginId: string, dispose: () => void): void {
    const list = this.disposers.get(pluginId) ?? []
    list.push(dispose)
    this.disposers.set(pluginId, list)
  }

  addChatMenuItem(
    pluginId: string,
    item: {
      id: string
      name: string
      icon?: string
      run: PluginChatMenuItem["run"]
    }
  ): void {
    if (typeof item?.run !== "function") {
      throw new Error("A menu item needs a `run` function.")
    }
    const id = `${pluginId}:${String(item.id)}`
    this.chatMenuItems.set(id, {
      id,
      pluginId,
      name: String(item.name || item.id),
      icon: iconOf(item.icon),
      run: item.run,
    })
    this.track(pluginId, () => {
      // Only if it is still this one: a plugin re-adding the same id replaced
      // it, and the first registration's undo must not take the second away.
      if (this.chatMenuItems.get(id)?.run === item.run) {
        this.chatMenuItems.delete(id)
      }
    })
    this.changed()
  }

  /** Every chat menu item, in the order they were added. */
  chatMenuList(): PluginChatMenuItem[] {
    return [...this.chatMenuItems.values()]
  }

  addRailButton(
    pluginId: string,
    button: {
      id: string
      label: string
      icon?: string
      run: PluginRailButton["run"]
    }
  ): void {
    if (typeof button?.run !== "function") {
      throw new Error("A rail button needs a `run` function.")
    }
    const id = `${pluginId}:${String(button.id)}`
    this.railButtons.set(id, {
      id,
      pluginId,
      label: String(button.label || button.id),
      icon: iconOf(button.icon),
      run: button.run,
    })
    this.track(pluginId, () => {
      if (this.railButtons.get(id)?.run === button.run) {
        this.railButtons.delete(id)
      }
    })
    this.changed()
  }

  /** Every rail button, in the order they were added. */
  railButtonList(): PluginRailButton[] {
    return [...this.railButtons.values()]
  }

  isLoaded(pluginId: string): boolean {
    return this.modules.has(pluginId)
  }

  /**
   * Runs a plugin's `onload`. A plugin whose `onload` throws is unloaded again
   * at once — whatever it managed to register before the throw is taken back —
   * and the error is rethrown for the caller to show.
   */
  async load<App>(
    pluginId: string,
    exported: unknown,
    app: App
  ): Promise<void> {
    if (this.modules.has(pluginId)) await this.unload(pluginId)

    const module = moduleOf<App>(exported)
    this.modules.set(pluginId, module as PluginModule<unknown>)
    try {
      await module.onload(app)
    } catch (error) {
      await this.unload(pluginId)
      throw error
    }
  }

  /**
   * Calls `onunload`, then undoes everything the plugin registered, newest
   * first. Never throws: a plugin failing on its way out is still out, and the
   * errors come back for the caller to log.
   */
  async unload(pluginId: string): Promise<unknown[]> {
    const errors: unknown[] = []
    const module = this.modules.get(pluginId)
    this.modules.delete(pluginId)

    if (module?.onunload) {
      try {
        await module.onunload()
      } catch (error) {
        errors.push(error)
      }
    }

    const list = this.disposers.get(pluginId) ?? []
    this.disposers.delete(pluginId)
    for (const dispose of list.reverse()) {
      try {
        dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    this.changed()
    return errors
  }

  /** Called whenever what plugins contribute changes. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** A mark by name, or the puzzle piece for a name that is not one of ours. */
function iconOf(name: string | undefined): PluginIcon {
  return (PLUGIN_ICONS as readonly string[]).includes(name ?? "")
    ? (name as PluginIcon)
    : "puzzle"
}

/**
 * The plugin out of what its `main.js` exported.
 *
 * Either an object with `onload` or a class whose instances have one — the
 * second is how an Obsidian plugin is written, and costs nothing to accept.
 */
export function moduleOf<App>(exported: unknown): PluginModule<App> {
  const candidate =
    exported && typeof exported === "object" && "default" in exported
      ? (exported as { default: unknown }).default
      : exported

  if (typeof candidate === "function") {
    const instance: unknown = new (candidate as new () => unknown)()
    return moduleOf<App>(instance)
  }

  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as { onload?: unknown }).onload === "function"
  ) {
    const plugin = candidate as PluginModule<App>
    return {
      onload: (app) => plugin.onload(app),
      ...(typeof plugin.onunload === "function"
        ? { onunload: () => plugin.onunload!() }
        : {}),
    }
  }

  throw new Error("main.js must `export default` an object with an `onload`.")
}

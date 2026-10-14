import { moduleOf, PluginRegistry } from "../src/renderer/lib/plugins/registry"
import { check, finish, section } from "./harness"

/**
 * What switching a plugin off takes back, and that one plugin failing is that
 * plugin's problem alone.
 */

type App = { registry: PluginRegistry; id: string }

section("module shapes")
{
  const loads: string[] = []
  moduleOf({ default: { onload: () => loads.push("object") } }).onload({})
  class Plugin {
    name = "class"
    onload() {
      loads.push(this.name)
    }
  }
  moduleOf({ default: Plugin }).onload({})
  check("an object and a class", loads.join(",") === "object,class", loads)

  let threw = false
  try {
    moduleOf({ default: {} })
  } catch {
    threw = true
  }
  check("no onload is refused", threw)
}

section("load and unload")
{
  const registry = new PluginRegistry()
  const undone: string[] = []
  let changes = 0
  registry.subscribe(() => (changes += 1))

  await registry.load<App>(
    "a",
    {
      default: {
        onload(app: App) {
          app.registry.addRailButton(app.id, {
            id: "go",
            label: "Go",
            run: () => {},
          })
          app.registry.track(app.id, () => undone.push("first"))
          app.registry.track(app.id, () => undone.push("second"))
        },
        onunload() {
          undone.push("onunload")
        },
      },
    },
    { registry, id: "a" }
  )
  check("namespaced", registry.railButtonList()[0]?.id === "a:go")
  check("subscribers told", changes > 0)
  check("is loaded", registry.isLoaded("a"))

  await registry.load<App>(
    "b",
    {
      default: {
        onload(app: App) {
          app.registry.addRailButton(app.id, {
            id: "go",
            label: "Go",
            run: () => {},
          })
        },
      },
    },
    { registry, id: "b" }
  )
  check("same id, two plugins", registry.railButtonList().length === 2)

  const errors = await registry.unload("a")
  check("no errors", errors.length === 0)
  check(
    "onunload, then newest first",
    undone.join(",") === "onunload,second,first",
    undone
  )
  check(
    "only its own buttons go",
    registry
      .railButtonList()
      .map((button) => button.id)
      .join(",") === "b:go"
  )
  check("not loaded", !registry.isLoaded("a"))
}

section("failures")
{
  const registry = new PluginRegistry()
  let failed = false
  try {
    await registry.load<App>(
      "bad",
      {
        default: {
          onload(app: App) {
            app.registry.addRailButton(app.id, {
              id: "half",
              label: "Half",
              run: () => {},
            })
            throw new Error("boom")
          },
        },
      },
      { registry, id: "bad" }
    )
  } catch {
    failed = true
  }
  check("onload's throw comes back", failed)
  check("what it added is taken back", registry.railButtonList().length === 0)
  check("not left loaded", !registry.isLoaded("bad"))

  await registry.load<App>(
    "messy",
    {
      default: {
        onload(app: App) {
          app.registry.track(app.id, () => {
            throw new Error("dispose")
          })
          app.registry.addRailButton(app.id, {
            id: "x",
            label: "X",
            run: () => {},
          })
        },
        onunload() {
          throw new Error("unload")
        },
      },
    },
    { registry, id: "messy" }
  )
  const errors = await registry.unload("messy")
  check("errors collected, not thrown", errors.length === 2)
  check("still cleaned up", registry.railButtonList().length === 0)
}

section("re-adding a button")
{
  const registry = new PluginRegistry()
  const first = () => {}
  const second = () => {}
  registry.addRailButton("p", { id: "c", label: "One", run: first })
  registry.addRailButton("p", { id: "c", label: "Two", run: second })
  check("replaced", registry.railButtonList()[0]?.label === "Two")
  await registry.unload("p")
  check("both registrations undone", registry.railButtonList().length === 0)
}

section("chat menu items")
{
  const registry = new PluginRegistry()
  registry.addChatMenuItem("p", {
    id: "export",
    name: "Export",
    icon: "download",
    run: () => {},
  })
  registry.addChatMenuItem("p", {
    id: "odd",
    name: "Odd",
    icon: "not-an-icon",
    run: () => {},
  })
  const items = registry.chatMenuList()
  check("namespaced", items[0]?.id === "p:export")
  check("a known icon is kept", items[0]?.icon === "download")
  check("an unknown one is the default", items[1]?.icon === "puzzle")
  await registry.unload("p")
  check("taken back on unload", registry.chatMenuList().length === 0)
}

section("rail buttons")
{
  const registry = new PluginRegistry()
  registry.addRailButton("usage", {
    id: "open",
    label: "Usage",
    icon: "chart",
    run: () => {},
  })
  const buttons = registry.railButtonList()
  check("namespaced", buttons[0]?.id === "usage:open")
  check("its icon", buttons[0]?.icon === "chart")
  await registry.unload("usage")
  check("taken back on unload", registry.railButtonList().length === 0)
}

finish()

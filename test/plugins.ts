import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  listAllPlugins,
  listPlugins,
  parseManifest,
  pluginFilePath,
  pluginRootOf,
  readPluginData,
  writePluginData,
} from "../src/main/plugins"
import { isPluginId, pluginFileOf, pluginUrl } from "../src/shared/plugins"
import { check, finish, section } from "./harness"

/**
 * The plugins folder, against real directories: what is listed, what is
 * refused, and that nothing a URL names can reach outside `PLUGIN_FILES`.
 */

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "plugins-"))
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  return root
}

const manifest = (id: string, extra: object = {}) =>
  JSON.stringify({ id, name: "Hello", version: "1.0.0", ...extra })

section("ids")
check("lower case and dashes", isPluginId("hello-world"))
check("no capitals", !isPluginId("Hello"))
check("no dots", !isPluginId(".."))
check("no slashes", !isPluginId("a/b"))
check("not empty", !isPluginId(""))

section("URLs")
check(
  "round trip",
  JSON.stringify(pluginFileOf(pluginUrl("hello", "main.js", "1"))) ===
    JSON.stringify({ id: "hello", file: "main.js" })
)
check(
  "data.json is not served",
  pluginFileOf("vsc-plugin://hello/data.json") === null
)
check(
  "manifest is not served",
  pluginFileOf("vsc-plugin://hello/manifest.json") === null
)
check(
  "no climbing out",
  pluginFileOf("vsc-plugin://hello/../other/main.js") === null
)
check("other schemes", pluginFileOf("https://hello/main.js") === null)

section("manifest")
{
  const parsed = parseManifest(
    manifest("hello", { description: " Hi " }),
    "hello"
  )
  check(
    "reads name and version",
    parsed.name === "Hello" && parsed.version === "1.0.0"
  )
  check("trims", parsed.description === "Hi")

  const throws = (text: string, dir = "hello") => {
    try {
      parseManifest(text, dir)
      return false
    } catch {
      return true
    }
  }
  check("not JSON", throws("{"))
  check("an array", throws("[]"))
  check("id must be the folder's", throws(manifest("other")))
  check("needs a name", throws(JSON.stringify({ id: "hello", version: "1" })))
  check("needs a version", throws(JSON.stringify({ id: "hello", name: "x" })))
}

section("listing")
{
  const root = await folder({
    "hello/manifest.json": manifest("hello"),
    "hello/main.js": "export default { onload() {} }",
    "hello/styles.css": "",
    "no-main/manifest.json": manifest("no-main"),
    "broken/manifest.json": "{",
    "broken/main.js": "",
    "Bad Name/manifest.json": manifest("bad"),
    ".hidden/manifest.json": manifest("hidden"),
    "loose-file.txt": "",
  })
  try {
    const listed = await listPlugins(root)
    const byId = new Map(listed.map((plugin) => [plugin.id, plugin]))

    check(
      "every directory but the hidden one",
      listed.map((plugin) => plugin.id).join(",") ===
        "Bad Name,broken,hello,no-main",
      listed.map((plugin) => plugin.id)
    )
    check(
      "a good one",
      byId.get("hello")?.error === null && byId.get("hello")?.hasStyles === true
    )
    check("no main.js", byId.get("no-main")?.error === "There is no main.js.")
    check("bad JSON is listed with why", !!byId.get("broken")?.error)
    check("a bad folder name is listed with why", !!byId.get("Bad Name")?.error)
    check(
      "no folder is no plugins",
      (await listPlugins(path.join(root, "absent"))).length === 0
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

section("built-in and user folders")
{
  const root = await folder({
    "bundled/chat-export/manifest.json": manifest("chat-export"),
    "bundled/chat-export/main.js": "",
    "user/chat-export/manifest.json": manifest("chat-export"),
    "user/chat-export/main.js": "",
    "user/mine/manifest.json": manifest("mine"),
    "user/mine/main.js": "",
  })
  const roots = {
    bundled: path.join(root, "bundled"),
    user: path.join(root, "user"),
  }
  try {
    const listed = await listAllPlugins(roots)
    check(
      "built-in first",
      listed.map((plugin) => `${plugin.id}:${plugin.bundled}`).join(",") ===
        "chat-export:true,chat-export:false,mine:false",
      listed.map((plugin) => plugin.id)
    )
    check("the built-in one is fine", listed[0]?.error === null)
    check(
      "a user's folder cannot take a built-in id",
      listed[1]?.error === "A built-in plugin already has this id."
    )
    check("a user's own is fine", listed[2]?.error === null)

    check(
      "a built-in id is served from the built-in folder",
      pluginRootOf(roots, "chat-export") === roots.bundled
    )
    check(
      "anything else from the user's",
      pluginRootOf(roots, "mine") === roots.user
    )
    check(
      "no built-in folder at all",
      pluginRootOf({ bundled: null, user: roots.user }, "chat-export") ===
        roots.user
    )
    check(
      "a build without built-ins lists the user's",
      (await listAllPlugins({ bundled: null, user: roots.user })).length === 2
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

section("files and data")
{
  const root = await folder({ "hello/main.js": "" })
  const dataRoot = path.join(root, "plugin-data")
  try {
    check(
      "a plugin's file",
      pluginFilePath(root, "hello", "main.js") ===
        path.join(root, "hello", "main.js")
    )
    let refused = false
    try {
      pluginFilePath(root, "..", "main.js")
    } catch {
      refused = true
    }
    check("refuses an id that climbs", refused)

    check(
      "nothing saved yet",
      (await readPluginData(dataRoot, "hello")) === null
    )
    await writePluginData(dataRoot, "hello", { count: 2 })
    check(
      "saved and read back",
      JSON.stringify(await readPluginData(dataRoot, "hello")) === '{"count":2}'
    )
    check(
      "in the data folder, not beside the plugin's files",
      (await readFile(path.join(dataRoot, "hello.json"), "utf8")).includes(
        '"count": 2'
      )
    )

    let climbing = false
    try {
      await writePluginData(dataRoot, "../escape", {})
    } catch {
      climbing = true
    }
    check("refuses an id that climbs out of the data folder", climbing)

    let large = false
    try {
      await writePluginData(dataRoot, "hello", "x".repeat(2 * 1024 * 1024))
    } catch {
      large = true
    }
    check("capped", large)

    await writeFile(path.join(dataRoot, "hello.json"), "{")
    check(
      "a broken file reads as nothing",
      (await readPluginData(dataRoot, "hello")) === null
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

finish()

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { strToU8, zipSync } from "fflate"

import {
  installedPluginDir,
  installPlugin,
  readPluginFolder,
  readPluginZip,
} from "../src/main/plugin-install"
import { check, finish, section } from "./harness"

/**
 * Installing a plugin from a folder or a `.zip`, against real directories and
 * real archives: what is copied, what is refused, and that an update replaces.
 */

const manifest = (id: string, version = "1.0.0") =>
  JSON.stringify({ id, name: `Plugin ${id}`, version })

async function throwsWith(
  run: () => Promise<unknown> | unknown,
  fragment: string
): Promise<boolean> {
  try {
    await run()
    return false
  } catch (error) {
    return error instanceof Error && error.message.includes(fragment)
  }
}

const root = await mkdtemp(path.join(tmpdir(), "plugin-install-"))
const roots = {
  bundled: path.join(root, "bundled"),
  user: path.join(root, "user"),
}
await mkdir(path.join(roots.bundled, "usage"), { recursive: true })

try {
  section("from a folder")
  {
    // A repository: the built files beside its source and its dependencies.
    const source = path.join(root, "my-plugin-main")
    await mkdir(path.join(source, "node_modules", "x"), { recursive: true })
    await writeFile(path.join(source, "manifest.json"), manifest("hello"))
    await writeFile(path.join(source, "main.js"), "export default {}")
    await writeFile(path.join(source, "styles.css"), "p{}")
    await writeFile(path.join(source, "README.md"), "#")

    const installed = await installPlugin(roots, await readPluginFolder(source))
    check("named by its manifest, not its folder", installed.id === "hello")
    check("a first install", installed.replaced === false)
    const copied = (await readdir(path.join(roots.user, "hello"))).sort()
    check(
      "the three served files and nothing else",
      copied.join(",") === "main.js,manifest.json,styles.css",
      copied
    )

    await writeFile(
      path.join(source, "manifest.json"),
      manifest("hello", "2.0.0")
    )
    await writeFile(path.join(source, "main.js"), "export default { v: 2 }")
    const again = await installPlugin(roots, await readPluginFolder(source))
    check("the same id again is an update", again.replaced === true)
    check(
      "with the new files",
      (await readFile(path.join(roots.user, "hello", "main.js"), "utf8")) ===
        "export default { v: 2 }"
    )
    check(
      "and no working folders left behind",
      (await readdir(roots.user)).join(",") === "hello"
    )

    const bare = path.join(root, "bare")
    await mkdir(bare)
    await writeFile(path.join(bare, "manifest.json"), manifest("bare"))
    check(
      "no main.js is refused",
      await throwsWith(() => readPluginFolder(bare), "no main.js")
    )
    check(
      "no manifest is refused",
      await throwsWith(
        () => readPluginFolder(path.join(root, "absent")),
        "no manifest.json"
      )
    )
  }

  section("from a zip")
  {
    const nested = zipSync({
      "chat-tools-1.2.0/manifest.json": strToU8(manifest("chat-tools")),
      "chat-tools-1.2.0/main.js": strToU8("export default {}"),
      "chat-tools-1.2.0/src/index.ts": strToU8("// source"),
      "chat-tools-1.2.0/../../escape.js": strToU8("nope"),
    })
    const installed = await installPlugin(roots, readPluginZip(nested))
    check(
      "inside one folder, as GitHub zips are",
      installed.id === "chat-tools"
    )
    check(
      "only the served files",
      (await readdir(path.join(roots.user, "chat-tools"))).sort().join(",") ===
        "main.js,manifest.json"
    )
    check(
      "nothing written outside the plugins folder",
      !(await readdir(root)).includes("escape.js")
    )

    const flat = zipSync({
      "manifest.json": strToU8(manifest("flat")),
      "main.js": strToU8("export default {}"),
    })
    check(
      "at the archive's root",
      (await installPlugin(roots, readPluginZip(flat))).id === "flat"
    )

    check(
      "two plugins in one archive are refused",
      await throwsWith(
        () =>
          readPluginZip(
            zipSync({
              "a/manifest.json": strToU8(manifest("a")),
              "b/manifest.json": strToU8(manifest("b")),
            })
          ),
        "more than one"
      )
    )
    check(
      "a manifest buried deeper is not found",
      await throwsWith(
        () =>
          readPluginZip(
            zipSync({ "a/b/manifest.json": strToU8(manifest("deep")) })
          ),
        "no manifest.json"
      )
    )
    check(
      "a manifest with no main.js beside it is refused",
      await throwsWith(
        () =>
          readPluginZip(zipSync({ "manifest.json": strToU8(manifest("x")) })),
        "no main.js"
      )
    )
    check(
      "a script past the limit is refused",
      await throwsWith(
        () =>
          readPluginZip(
            zipSync({
              "manifest.json": strToU8(manifest("big")),
              "main.js": new Uint8Array(11 * 1024 * 1024),
            })
          ),
        "too large"
      )
    )
  }

  section("refusals")
  {
    const files = (text: string) => ({
      manifest: text,
      main: strToU8("export default {}"),
      styles: null,
    })
    check(
      "a built-in plugin's id",
      await throwsWith(
        () => installPlugin(roots, files(manifest("usage"))),
        "built-in"
      )
    )
    check(
      "an id that is not one",
      await throwsWith(
        () => installPlugin(roots, files(manifest("../escape"))),
        "lower-case"
      )
    )
    check(
      "not JSON",
      await throwsWith(() => installPlugin(roots, files("{")), "valid JSON")
    )
  }

  section("removing")
  {
    check(
      "an installed plugin's folder",
      (await installedPluginDir(roots, "hello")) ===
        path.join(roots.user, "hello")
    )
    check(
      "never a built-in one",
      await throwsWith(() => installedPluginDir(roots, "usage"), "built-in")
    )
    check(
      "never outside the folder",
      await throwsWith(() => installedPluginDir(roots, ".."), "Not a plugin id")
    )
    check(
      "one that is not installed",
      await throwsWith(
        () => installedPluginDir(roots, "gone"),
        "No such plugin"
      )
    )
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

finish()

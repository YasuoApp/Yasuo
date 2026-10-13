import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { unzipSync } from "fflate"

import { isPluginId, type PluginInstall } from "../shared/plugins"
import { parseManifest, type PluginRoots } from "./plugins"

/**
 * Putting a plugin from outside the app into the user's plugins folder — from a
 * folder or a `.zip` today, and from the marketplace when there is one, which
 * will download and hand its bytes to the same `installPlugin`.
 *
 * An install **copies three files and nothing else**: `manifest.json`,
 * `main.js` and `styles.css`, the ones `pluginFileOf` serves. A plugin's
 * folder is usually its repository — `src/`, `node_modules/`, a `.git` — and
 * none of that is read by the app, so none of it is carried in. It is also what
 * keeps a zip from writing anywhere: no path inside an archive becomes a path
 * on disk, only those three names under a directory this module chose.
 *
 * Free of `electron` (`test/plugins.ts`); the pickers are `host`'s.
 */

/** The ceilings on what is read in, so a zip bomb is refused rather than
 * inflated. A plugin's script is code somebody wrote, not an asset store. */
const LIMITS = {
  "manifest.json": 64 * 1024,
  "main.js": 10 * 1024 * 1024,
  "styles.css": 2 * 1024 * 1024,
} as const

type InstallFile = keyof typeof LIMITS

/** A plugin's files, read out of wherever it came from. */
export type PluginFiles = {
  manifest: string
  main: Uint8Array
  styles: Uint8Array | null
}

/** The files from a folder on disk — the one a plugin was built into. */
export async function readPluginFolder(dir: string): Promise<PluginFiles> {
  const read = async (name: InstallFile): Promise<Uint8Array | null> => {
    const file = path.join(dir, name)
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return null
    }
    if (size > LIMITS[name]) throw new Error(`${name} is too large.`)
    return readFile(file)
  }

  const manifest = await read("manifest.json")
  if (!manifest) throw new Error("That folder has no manifest.json.")
  const main = await read("main.js")
  if (!main) throw new Error("That folder has no main.js.")
  return {
    manifest: new TextDecoder().decode(manifest),
    main,
    styles: await read("styles.css"),
  }
}

/**
 * The files from a `.zip`.
 *
 * At the archive's root, or inside **one** folder at its root — which is how
 * GitHub's "Download ZIP" and most release archives are laid out
 * (`my-plugin-1.0.0/manifest.json`). Anything deeper, or two manifests, is
 * refused rather than guessed between.
 */
export function readPluginZip(bytes: Uint8Array): PluginFiles {
  const manifests: string[] = []
  // A first pass that inflates nothing: only the names, to find the folder.
  unzipSync(bytes, {
    filter: (entry) => {
      if (/^(?:[^/]+\/)?manifest\.json$/.test(entry.name)) {
        manifests.push(entry.name)
      }
      return false
    },
  })
  if (manifests.length === 0) {
    throw new Error("That archive has no manifest.json at its top level.")
  }
  if (manifests.length > 1) {
    throw new Error("That archive holds more than one plugin.")
  }
  const prefix = manifests[0]!.slice(0, -"manifest.json".length)

  const wanted = new Map<string, InstallFile>(
    (Object.keys(LIMITS) as InstallFile[]).map((name) => [prefix + name, name])
  )
  const files = unzipSync(bytes, {
    filter: (entry) => {
      const name = wanted.get(entry.name)
      if (!name) return false
      if (entry.originalSize > LIMITS[name]) {
        throw new Error(`${name} is too large.`)
      }
      return true
    },
  })

  const manifest = files[prefix + "manifest.json"]
  const main = files[prefix + "main.js"]
  if (!manifest) throw new Error("That archive has no manifest.json.")
  if (!main) throw new Error("That archive has no main.js beside its manifest.")
  return {
    manifest: new TextDecoder().decode(manifest),
    main,
    styles: files[prefix + "styles.css"] ?? null,
  }
}

/**
 * Writes a plugin into the user's folder under the id its manifest gives —
 * not the name of the folder or archive it came in, which is `my-plugin-main`
 * as often as not.
 *
 * Installing an id that is already there **replaces** it, which is what an
 * update is. The new copy is written beside the old one and swapped in by
 * rename, so a failure part-way leaves the installed plugin as it was. A
 * built-in plugin's id is refused: it would be listed as broken and never run.
 */
export async function installPlugin(
  roots: PluginRoots,
  files: PluginFiles
): Promise<PluginInstall> {
  let raw: unknown
  try {
    raw = JSON.parse(files.manifest)
  } catch {
    throw new Error("manifest.json is not valid JSON.")
  }
  const id = (raw as { id?: unknown } | null)?.id
  if (!isPluginId(id)) {
    throw new Error(
      "manifest.json needs an `id` of lower-case letters, digits and dashes."
    )
  }
  const manifest = parseManifest(files.manifest, id)

  if (roots.bundled && (await exists(path.join(roots.bundled, id)))) {
    throw new Error(`"${id}" is the id of a built-in plugin.`)
  }

  const target = path.join(roots.user, id)
  // Dot-named, so a listing that runs meanwhile skips both.
  const incoming = path.join(roots.user, `.${id}.installing`)
  const outgoing = path.join(roots.user, `.${id}.replaced`)

  await rm(incoming, { recursive: true, force: true })
  await mkdir(incoming, { recursive: true })
  await writeFile(path.join(incoming, "manifest.json"), files.manifest, "utf8")
  await writeFile(path.join(incoming, "main.js"), files.main)
  if (files.styles) {
    await writeFile(path.join(incoming, "styles.css"), files.styles)
  }

  const replaced = await exists(target)
  await rm(outgoing, { recursive: true, force: true })
  if (replaced) await rename(target, outgoing)
  try {
    await rename(incoming, target)
  } catch (error) {
    if (replaced) await rename(outgoing, target)
    throw error
  }
  await rm(outgoing, { recursive: true, force: true })

  return { id, name: manifest.name, replaced }
}

/**
 * The installed plugin's folder, for removing it — never a built-in one, which
 * is switched off rather than removed, and never anything outside the user's
 * folder, since the id comes from the renderer.
 */
export async function installedPluginDir(
  roots: PluginRoots,
  id: string
): Promise<string> {
  if (!isPluginId(id)) throw new Error(`Not a plugin id: ${id}`)
  if (roots.bundled && (await exists(path.join(roots.bundled, id)))) {
    throw new Error("A built-in plugin can be switched off, not removed.")
  }
  const dir = path.join(roots.user, id)
  if (!(await exists(dir))) throw new Error(`No such plugin: ${id}`)
  return dir
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

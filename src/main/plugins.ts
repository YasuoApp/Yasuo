import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  isPluginId,
  PLUGIN_FILES,
  type PluginFile,
  type PluginInfo,
  type PluginManifest,
} from "../shared/plugins"

/**
 * The plugins on disk: listing them, finding their files, and the one file of
 * their own they may write.
 *
 * There are two folders. The **built-in** one ships inside the app — built
 * from `plugins/` in the repository by `scripts/build-plugins.mjs`, carried as
 * an `extraResources` entry — and the **user's** is `workspace/plugins/`. Every
 * function takes the directories rather than finding them, so the tests can
 * point them at temporary ones; `ipc.ts` passes the real ones. Free of
 * `electron` for the same reason.
 *
 * Nothing here runs a plugin. Which ones are switched on is a setting the
 * renderer keeps, and the renderer is where `main.js` is imported — see
 * `lib/plugins/`.
 */

/** A manifest is a few lines; one larger than this is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024

/** What `saveData` will write — a plugin's settings, not its database. */
export const MAX_PLUGIN_DATA_BYTES = 1024 * 1024

/** Both folders, the built-in one absent where this build carries none. */
export type PluginRoots = { bundled: string | null; user: string }

/**
 * Every plugin in both folders, built-in first.
 *
 * A user's folder that takes a built-in plugin's id is listed with an error
 * rather than allowed to replace it: the id is what the URL, the settings and
 * the saved data are keyed by, and two plugins answering to one would have each
 * reading the other's.
 */
export async function listAllPlugins(
  roots: PluginRoots
): Promise<PluginInfo[]> {
  const bundled = roots.bundled ? await listPlugins(roots.bundled, true) : []
  const taken = new Set(bundled.map((plugin) => plugin.id))
  const user = (await listPlugins(roots.user, false)).map((plugin) =>
    taken.has(plugin.id)
      ? {
          ...plugin,
          error: "A built-in plugin already has this id.",
        }
      : plugin
  )
  return [...bundled, ...user]
}

/** The folder a plugin's files are served from: the built-in one when it has
 * that id, which is the same precedence `listAllPlugins` reports. */
export function pluginRootOf(roots: PluginRoots, id: string): string {
  if (roots.bundled && existsSync(path.join(roots.bundled, id))) {
    return roots.bundled
  }
  return roots.user
}

/**
 * Every directory under `root`, each with its manifest or the reason it has
 * none. An absent `root` is no plugins rather than an error: nobody has made
 * the directory until they install the first one.
 */
export async function listPlugins(
  root: string,
  bundled = false
): Promise<PluginInfo[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  return Promise.all(directories.map((name) => readPlugin(root, name, bundled)))
}

async function readPlugin(
  root: string,
  name: string,
  bundled: boolean
): Promise<PluginInfo> {
  const dir = path.join(root, name)
  const listed = { id: name, bundled, manifest: null, hasStyles: false }

  if (!isPluginId(name)) {
    return {
      ...listed,
      error: "The folder's name must be lower-case letters, digits and dashes.",
    }
  }

  let manifest: PluginManifest
  try {
    manifest = parseManifest(
      await readCapped(path.join(dir, "manifest.json"), MAX_MANIFEST_BYTES),
      name
    )
  } catch (error) {
    return { ...listed, error: messageOf(error) }
  }

  if (!(await isFile(path.join(dir, "main.js")))) {
    return { ...listed, manifest, error: "There is no main.js." }
  }

  return {
    id: name,
    bundled,
    manifest,
    hasStyles: await isFile(path.join(dir, "styles.css")),
    error: null,
  }
}

/**
 * A manifest's text, checked.
 *
 * `id` has to equal the directory's name because both are used: the directory
 * is what the URL finds files in, the id is what the enabled list and the
 * plugin's commands are keyed by, and two that disagree are a plugin whose
 * settings follow one and whose files follow the other.
 */
export function parseManifest(text: string, dirName: string): PluginManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("manifest.json is not valid JSON.")
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest.json is not an object.")
  }
  const record = raw as Record<string, unknown>

  const id = record.id
  if (!isPluginId(id)) {
    throw new Error(
      "manifest.json needs an `id` of lower-case letters, digits and dashes."
    )
  }
  if (id !== dirName) {
    throw new Error(`The manifest's id "${id}" is not the folder's name.`)
  }

  const name = text255(record.name)
  const version = text255(record.version)
  if (!name) throw new Error("manifest.json needs a `name`.")
  if (!version) throw new Error("manifest.json needs a `version`.")

  const description = text255(record.description)
  const author = text255(record.author)
  return {
    id,
    name,
    version,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
  }
}

/**
 * The file a plugin URL names, as a path.
 *
 * Checked here rather than at the protocol handler alone, the way
 * `noteFilePath` is: the id and the file come out of a URL, and a URL is
 * whatever the page asked for.
 */
export function pluginFilePath(
  root: string,
  id: string,
  file: PluginFile
): string {
  if (!isPluginId(id)) throw new Error(`Not a plugin id: ${id}`)
  if (!(PLUGIN_FILES as readonly string[]).includes(file)) {
    throw new Error(`Not a plugin file: ${file}`)
  }
  return path.join(root, id, file)
}

/**
 * Where a plugin's `saveData` goes: `<dataRoot>/<id>.json`.
 *
 * Not beside the plugin's own files, where it was first: a built-in plugin's
 * folder is inside the app bundle, which is read-only on a signed install and
 * replaced wholesale by every update. One folder for both kinds keeps the rule
 * the same for each, and it is not under either plugins folder, so nothing that
 * serves a plugin's files can serve it.
 */
function dataFileOf(dataRoot: string, id: string): string {
  if (!isPluginId(id)) throw new Error(`Not a plugin id: ${id}`)
  return path.join(dataRoot, `${id}.json`)
}

/** What the plugin last saved, or null when it never has. */
export async function readPluginData(
  dataRoot: string,
  id: string
): Promise<unknown> {
  let text: string
  try {
    text = await readCapped(dataFileOf(dataRoot, id), MAX_PLUGIN_DATA_BYTES)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    // A hand-edited file gone wrong is a plugin starting from its defaults,
    // not one that cannot load at all.
    return null
  }
}

export async function writePluginData(
  dataRoot: string,
  id: string,
  data: unknown
): Promise<void> {
  const file = dataFileOf(dataRoot, id)
  const text = JSON.stringify(data ?? null, null, 2)
  if (Buffer.byteLength(text) > MAX_PLUGIN_DATA_BYTES) {
    throw new Error("A plugin's saved data is limited to 1 MB.")
  }
  await mkdir(dataRoot, { recursive: true })
  await writeFile(file, text, "utf8")
}

async function readCapped(file: string, limit: number): Promise<string> {
  const stats = await stat(file)
  if (stats.size > limit) {
    throw new Error(`${path.basename(file)} is too large.`)
  }
  return readFile(file, "utf8")
}

function text255(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 255) : null
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
}

function messageOf(error: unknown): string {
  if (isNotFound(error)) return "There is no manifest.json."
  return error instanceof Error ? error.message : String(error)
}

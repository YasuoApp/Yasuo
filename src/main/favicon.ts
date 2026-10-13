import { readdir, stat } from "node:fs/promises"
import path from "node:path"

/**
 * The directories a web project's own icon is conventionally kept in, relative
 * to the project — the root itself, the bundlers' static directories, and
 * Next's `app/`, which serves an `icon.*` beside its layout.
 *
 * A list rather than a walk: the projects column asks this of every folder in
 * the workspace on first draw, and a walk under a monorepo's `node_modules`
 * would find somebody else's favicon before the project's own.
 */
const DIRECTORIES = [
  "",
  "public",
  "static",
  "assets",
  "app",
  "src",
  "src/app",
  "src/assets",
  "web/public",
  "client/public",
  "frontend/public",
]

/** Where a monorepo keeps its packages — one level of them is looked into, for
 * the same `public/` and `app/`, after the root's own have all missed. */
const WORKSPACES = ["apps", "packages"]

/** Best first: a vector icon draws sharp at 16px, an `.ico` is what a browser
 * would actually use, and `icon.*` is Next's spelling. */
const NAMES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "icon.svg",
  "icon.png",
  "icon.ico",
]

/** An icon is a few kilobytes; anything past this is a photograph named badly,
 * and it is base64'd across the bridge for a 16px square. */
export const MAX_FAVICON_BYTES = 512 * 1024

async function fileIn(dir: string): Promise<string | null> {
  for (const name of NAMES) {
    const candidate = path.join(dir, name)
    try {
      const stats = await stat(candidate)
      if (stats.isFile() && stats.size <= MAX_FAVICON_BYTES) return candidate
    } catch {
      // Absent is the ordinary answer.
    }
  }
  return null
}

/** The project's favicon, or null for a project that has none — most of them. */
export async function findFavicon(root: string): Promise<string | null> {
  for (const dir of DIRECTORIES) {
    const found = await fileIn(path.join(root, dir))
    if (found) return found
  }
  for (const workspace of WORKSPACES) {
    let entries
    try {
      entries = await readdir(path.join(root, workspace), {
        withFileTypes: true,
      })
    } catch {
      continue
    }
    const packages = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of packages) {
      for (const dir of ["public", "app", "src/app", "static"]) {
        const found = await fileIn(path.join(root, workspace, name, dir))
        if (found) return found
      }
    }
  }
  return null
}

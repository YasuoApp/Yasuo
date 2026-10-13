import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { findFavicon, MAX_FAVICON_BYTES } from "../src/main/favicon"
import { check, finish, section } from "./harness"

/**
 * Where a project's favicon is found, against real directories — the order is
 * the behaviour, and it is the one thing a fixture could not get wrong.
 */

async function project(files: Record<string, number>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "favicon-"))
  for (const [relative, size] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.alloc(size))
  }
  return root
}

async function found(files: Record<string, number>): Promise<string | null> {
  const root = await project(files)
  try {
    const hit = await findFavicon(root)
    return hit && path.relative(root, hit)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

section("findFavicon")

check(
  "none in a project without one",
  (await found({ "README.md": 10 })) === null
)
check(
  "public/ of a Vite app",
  (await found({ "public/favicon.ico": 10 })) === "public/favicon.ico"
)
check(
  "Next's app/icon",
  (await found({ "src/app/icon.png": 10 })) === "src/app/icon.png"
)
check(
  "an svg wins over an ico in the same directory",
  (await found({ "public/favicon.ico": 10, "public/favicon.svg": 10 })) ===
    "public/favicon.svg"
)
check(
  "the root's own wins over a package's",
  (await found({
    "public/favicon.ico": 10,
    "apps/web/public/favicon.svg": 10,
  })) === "public/favicon.ico"
)
check(
  "a monorepo's app is looked into",
  (await found({ "apps/web/public/favicon.ico": 10 })) ===
    "apps/web/public/favicon.ico"
)
check(
  "node_modules is never looked into",
  (await found({ "node_modules/x/public/favicon.ico": 10 })) === null
)
check(
  "an oversized file is passed over",
  (await found({
    "favicon.png": MAX_FAVICON_BYTES + 1,
    "public/favicon.ico": 10,
  })) === "public/favicon.ico"
)
check(
  "a directory named like an icon is not one",
  (await found({ "favicon.ico/x": 10 })) === null
)

finish()

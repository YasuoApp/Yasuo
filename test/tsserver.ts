import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { TsServers, tsServerPathFor } from "../src/main/tsserver"
import { check, finish, section } from "./harness"

/**
 * The editor's hovers and go-to-definition, against a real TypeScript server.
 *
 * Run against this repository rather than a fixture, and with nothing mocked:
 * the thing worth checking is precisely the part a fixture would stand in for —
 * that `Content-Length` framing is reassembled correctly, that a 1-based line
 * and column mean the same thing here as they do to tsserver, and that a
 * project is found at all. A mock would agree with whatever this client
 * believes about the protocol, which is the belief being tested.
 *
 * The repository is also the honest test subject for the second half: hovering
 * an `import` from `node_modules` is the case Monaco's own worker cannot
 * answer, and the reason this process exists.
 */

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")

/** A file's text and the 1-based line a marker sits on. */
async function locate(
  relative: string,
  marker: string
): Promise<{ file: string; text: string; line: number; column: number }> {
  const file = path.join(root, relative)
  const text = await readFile(file, "utf8")
  const lines = text.split("\n")
  const index = lines.findIndex((line) => line.includes(marker))
  if (index === -1) throw new Error(`No line matching ${marker} in ${relative}`)

  return {
    file,
    text,
    line: index + 1,
    // Just inside the marker, so the position lands on a symbol rather than on
    // the whitespace before it.
    column: lines[index]!.indexOf(marker) + 2,
  }
}

async function main() {
  section("tsServerPathFor")

  check(
    "a folder with TypeScript installed is served by its own copy",
    tsServerPathFor(root)?.startsWith(path.join(root, "node_modules")) === true,
    tsServerPathFor(root)
  )
  check(
    "a folder without one is served by nothing",
    tsServerPathFor(path.join(root, "src")) === null,
    "no bundled fallback — see the note at the top of src/main/tsserver.ts"
  )

  // `node`, not this process: the studio runs tsserver on Electron's own
  // binary as plain Node, and a test process is bun. Left to the default,
  // tsserver would be running on bun's Node compatibility layer — a runtime
  // the app never spawns it on, and one whose file-system calls are what
  // module resolution is made of. `bun run test` is what runs this, so the
  // difference is invisible until it isn't.
  const servers = new TsServers(async () => [root], "node")

  try {
    section("hover")

    const own = await locate(
      "src/renderer/lib/files/paths.ts",
      "export function nameOf"
    )
    await servers.open(own.file, own.text)

    // The first request is the one tsserver loads this whole repository for,
    // and on a busy machine that outlasts `REQUEST_TIMEOUT_MS` — which then
    // answers null, and the check below failed on load time rather than on
    // anything this client got wrong. Asked again until it answers, bounded so
    // a server that never does still fails.
    const loading = Date.now() + 60_000
    while (
      (await servers.hover(
        own.file,
        own.line,
        own.column + "export function ".length
      )) === null &&
      Date.now() < loading
    ) {
      // A timed-out request is still queued in tsserver; the next one is
      // answered as soon as the project is in.
    }

    const hover = await servers.hover(
      own.file,
      own.line,
      own.column + "export function ".length
    )
    check(
      "a function in the open file gives its signature",
      hover?.signature.includes("nameOf(target: string): string") === true,
      hover
    )
    check(
      "and the doc comment above it",
      hover?.documentation.includes("last segment") === true,
      hover?.documentation
    )

    const nothing = await servers.hover(own.file, 1, 1)
    check(
      "a position with nothing under it gives null rather than an error",
      nothing === null,
      nothing
    )

    section("across the project")

    const imported = await locate(
      "src/renderer/lib/files/store.ts",
      'from "zustand"'
    )
    await servers.open(imported.file, imported.text)

    // The symbol, not the module string: the position walks back to `create`
    // on the same line.
    const at =
      imported.text.split("\n")[imported.line - 1]!.indexOf("create") + 2

    const packageHover = await servers.hover(imported.file, imported.line, at)
    check(
      "hovering an import from node_modules resolves it",
      packageHover?.signature.includes("create") === true,
      packageHover
    )

    const definitions = await servers.definition(
      imported.file,
      imported.line,
      at
    )
    check(
      "go-to-definition lands in the package's own types",
      definitions[0]?.path.includes("node_modules/zustand") === true,
      definitions
    )
    check(
      "with a 1-based line and column, the way Monaco counts",
      (definitions[0]?.line ?? 0) > 0 && (definitions[0]?.column ?? 0) > 0,
      definitions[0]
    )

    section("unsaved edits")

    // What the server is told about is the editor's text, not the file's: this
    // is the whole reason the three sync calls exist.
    const edited = `${own.text}\n\nconst afterTheEnd = nameOf("/a/b.ts")\n`
    await servers.change(own.file, edited)

    const editedHover = await servers.hover(
      own.file,
      edited.split("\n").length - 1,
      7
    )
    check(
      "a symbol typed since the last save is known",
      editedHover?.signature.includes("afterTheEnd") === true,
      editedHover
    )
  } finally {
    servers.stopAll()
  }

  finish()
}

await main()

import { check, finish, section } from "./harness"

/**
 * The Explorer's store, and what it reads when.
 *
 * Written for a bug that shipped: a reload put the picture tabs back but left
 * the pane on "Reading…" until something else happened to open them. `restore`
 * read every remembered tab as *text*, which for a PNG comes back "binary" —
 * enough to keep the tab and nothing the image view could draw. The half a tab
 * needs depends on how it will be shown, and that is what these check.
 *
 * The store is a renderer module, so `window.desktop` is stubbed here rather
 * than mocked over: the bridge is a plain object of functions, and a stub of it
 * is a smaller thing than a fake of the store. Everything below the stub — the
 * viewer rules, the reads, the way the two halves are kept apart — is the real
 * module.
 */

/** What the fake bridge was asked for, so "did it read this twice" is a
 * question the test can put. */
const calls = { image: [] as string[], text: [] as string[] }

/** What the fake disk holds, for the files a test rewrites under the pane. */
const disk: Record<string, string> = {}

const remembered = {
  openIds: ["/w/logo.png", "/w/notes.md", "/w/gone.png"],
  selectedId: "/w/logo.png",
}

;(globalThis as { window?: unknown }).window = {
  desktop: {
    getSetting: async (key: string) =>
      key === "files.tabs" ? JSON.stringify(remembered) : null,
    setSetting: async () => {},
    readImageFile: async (filePath: string) => {
      calls.image.push(filePath)
      if (filePath.includes("gone")) throw new Error("ENOENT")
      return `data:image/png;base64,${filePath.length}`
    },
    readTextFile: async (filePath: string) => {
      calls.text.push(filePath)
      return { kind: "text", text: disk[filePath] ?? `text of ${filePath}` }
    },
  },
}

const { isDeleted, opening, useFiles, viewOf } =
  await import("../src/renderer/lib/files/store")
const { keepSelected } = await import("../src/renderer/lib/files/changes")

async function main() {
  section("restore")

  await useFiles.getState().restore()
  const restored = useFiles.getState()

  check(
    "a remembered picture comes back with its picture read",
    restored.images["/w/logo.png"]?.kind === "image",
    restored.images["/w/logo.png"]
  )
  check(
    "and was never read as text on the way",
    !calls.text.includes("/w/logo.png"),
    calls.text
  )
  check(
    "a remembered text file comes back as text",
    restored.docs["/w/notes.md"]?.kind === "text",
    restored.docs["/w/notes.md"]
  )
  check(
    "a file that no longer reads is dropped from the strip",
    !restored.openIds.includes("/w/gone.png"),
    restored.openIds
  )
  check(
    "the rest of the strip survives it",
    restored.openIds.join() === "/w/logo.png,/w/notes.md",
    restored.openIds
  )
  check(
    "and the selected tab is the remembered one",
    restored.selectedId === "/w/logo.png"
  )

  section("ensureLoaded")

  const before = calls.image.length
  await useFiles.getState().ensureLoaded("/w/logo.png", "image")
  check(
    "asking for something already held reads nothing",
    calls.image.length === before,
    "the pane asks on every mount; it must be free when there is nothing to do"
  )

  section("two halves of an SVG")

  await useFiles.getState().open("/w/icon.svg")
  check(
    "an SVG opens as a picture",
    viewOf(useFiles.getState(), "/w/icon.svg") === "image" &&
      useFiles.getState().images["/w/icon.svg"]?.kind === "image"
  )
  check(
    "and is not read as text until it is asked for",
    !calls.text.includes("/w/icon.svg")
  )

  await useFiles.getState().setView("/w/icon.svg", "text")
  const both = useFiles.getState()
  check(
    "switching to the editor reads the other half",
    both.docs["/w/icon.svg"]?.kind === "text",
    both.docs["/w/icon.svg"]
  )
  check(
    "and keeps the first one",
    both.images["/w/icon.svg"]?.kind === "image",
    "switching back must not re-read what is already here"
  )

  const images = calls.image.length
  await useFiles.getState().setView("/w/icon.svg", "image")
  check(
    "switching back reads nothing at all",
    calls.image.length === images,
    calls.image
  )

  section("a file rewritten under the pane")

  /*
   * The bug this is written for: a file opened from the `Changes` list and then
   * edited again by the turn that was running kept drawing the text it was
   * opened at, while the row's `+`/`-` counted the new one. The `Changes` pane
   * shows a file without giving it a tab, and the watchers' re-read follows
   * `openIds` — so nothing re-read it. `reload` is what the pane calls when git's
   * answer for its checkout moves.
   */
  disk["/w/rewritten.ts"] = "one"
  await useFiles.getState().ensureLoaded("/w/rewritten.ts", "text")
  check(
    "a file with no tab is still read",
    !useFiles.getState().openIds.includes("/w/rewritten.ts"),
    useFiles.getState().openIds
  )

  disk["/w/rewritten.ts"] = "two"
  await useFiles.getState().reload("/w/rewritten.ts")
  const reloaded = useFiles.getState().docs["/w/rewritten.ts"]
  check(
    "and re-read on demand, tab or no tab",
    reloaded?.kind === "text" && reloaded.text === "two",
    reloaded
  )

  useFiles.getState().setText("/w/rewritten.ts", "typed")
  disk["/w/rewritten.ts"] = "three"
  await useFiles.getState().reload("/w/rewritten.ts")
  const dirty = useFiles.getState().docs["/w/rewritten.ts"]
  check(
    "an unsaved edit is not overwritten by what landed on disk",
    dirty?.kind === "text" && dirty.text === "typed",
    "the same bargain Refresh and the watchers make"
  )

  const reads = calls.text.length
  await useFiles.getState().reload("/w/never-opened.ts")
  check(
    "a file nothing has read is not read by asking to re-read it",
    calls.text.length === reads,
    calls.text
  )

  section("the All changes tab's selection")

  /*
   * The case worth a test: a commit made in the dock's shell empties the list
   * under a tab that is showing one of its files, and a selection left pointing
   * into it is a diff of a file with nothing left to diff.
   */
  const change = (path: string) => ({
    path,
    state: "modified" as const,
    staged: false,
    directory: false,
    added: 1,
    removed: 0,
  })

  check(
    "a file still in the list stays selected",
    keepSelected({ r1: "/w/a.ts" }, "r1", [change("/w/a.ts")]).r1 === "/w/a.ts"
  )

  check(
    "a file that has stopped being a change is dropped",
    keepSelected({ r1: "/w/a.ts" }, "r1", [change("/w/b.ts")]).r1 === null
  )

  check(
    "an emptied list drops it too",
    keepSelected({ r1: "/w/a.ts" }, "r1", []).r1 === null
  )

  check(
    "another root's selection is left alone",
    keepSelected({ r1: "/w/a.ts", r2: "/w/c.ts" }, "r1", []).r2 === "/w/c.ts",
    "one tab per checkout, and they are read one at a time"
  )

  check(
    "nothing selected is nothing to drop, and the record comes back as it was",
    (() => {
      const before = { r1: null }
      return keepSelected(before, "r1", []) === before
    })(),
    "the same object, so a re-read cannot look like a change to React"
  )

  section("what makes a tab say deleted")

  /*
   * The bug this is written for: a file an agent had just created was opened
   * from the Changes list, git had it as `U`, and the tab said `deleted` —
   * because the listing the tree held had been read before the file existed.
   */
  const listing = {
    entries: {
      "/w": [
        { name: "kept.ts", path: "/w/kept.ts", kind: "file" as const },
        { name: "edited.ts", path: "/w/edited.ts", kind: "file" as const },
      ],
    },
  }

  check(
    "git saying deleted is enough on its own",
    isDeleted("deleted", listing, "/w/kept.ts")
  )

  check(
    "a file git currently calls untracked exists, whatever a stale listing says",
    !isDeleted("untracked", listing, "/w/fresh.ts"),
    "the listing was read before the file was written"
  )

  check(
    "and so does one it calls added",
    !isDeleted("added", listing, "/w/fresh.ts")
  )

  check(
    "a listing that has stopped mentioning a file git says nothing about",
    isDeleted(null, listing, "/w/gone.ts"),
    "an untracked file deleted: git stops reporting it, so only the tree knows"
  )

  check(
    "a tracked file with no changes is neither",
    !isDeleted(null, listing, "/w/kept.ts")
  )

  check(
    "a directory nothing has read says nothing either way",
    !isDeleted(null, { entries: {} }, "/elsewhere/unknown.ts"),
    "a tab must not be labelled gone for never having been looked for"
  )

  section("the preview tab")

  /*
   * The editors' rule, and the whole of what it is for: reading through a
   * repository is one click per file, and before this each of those clicks left
   * a tab behind. One slot, holding whatever was last only looked at.
   */
  check(
    "a look replaces the last look, in the slot it was already in",
    (() => {
      const next = opening(
        { openIds: ["/w/a.ts", "/w/b.ts"], previewId: "/w/a.ts" },
        "/w/c.ts",
        true
      )
      return (
        next.openIds.join() === "/w/c.ts,/w/b.ts" &&
        next.previewId === "/w/c.ts" &&
        next.replaced === "/w/a.ts"
      )
    })(),
    "in place, so the tab does not move out from under the pointer"
  )

  check(
    "with nothing previewing, a look adds the slot",
    (() => {
      const next = opening(
        { openIds: ["/w/a.ts"], previewId: null },
        "/w/b.ts",
        true
      )
      return (
        next.openIds.join() === "/w/a.ts,/w/b.ts" &&
        next.previewId === "/w/b.ts" &&
        next.replaced === null
      )
    })()
  )

  check(
    "an open file is left exactly as it is",
    (() => {
      const state = { openIds: ["/w/a.ts", "/w/b.ts"], previewId: "/w/b.ts" }
      const kept = opening(state, "/w/a.ts", true)
      const previewed = opening(state, "/w/b.ts", true)
      return (
        kept.previewId === "/w/b.ts" &&
        kept.replaced === null &&
        previewed.previewId === "/w/b.ts"
      )
    })(),
    "clicking around the tree must not demote the file being edited"
  )

  check(
    "opening deliberately leaves the preview slot alone",
    (() => {
      const next = opening(
        { openIds: ["/w/a.ts"], previewId: "/w/a.ts" },
        "/w/b.ts",
        false
      )
      return (
        next.openIds.join() === "/w/a.ts,/w/b.ts" &&
        next.previewId === "/w/a.ts" &&
        next.replaced === null
      )
    })(),
    "the palette and a definition jumped to are opens, not looks"
  )

  await useFiles.getState().open("/w/one.ts", { preview: true })
  const opened = useFiles.getState().openIds.length
  await useFiles.getState().open("/w/two.ts", { preview: true })
  check(
    "a second look through the store adds no tab",
    useFiles.getState().openIds.length === opened &&
      !useFiles.getState().openIds.includes("/w/one.ts") &&
      useFiles.getState().previewId === "/w/two.ts",
    useFiles.getState().openIds
  )

  useFiles.getState().setText("/w/two.ts", "typed into")
  check(
    "typing in it keeps it",
    useFiles.getState().previewId === null,
    "an edit is the point at which somebody plainly means to stay"
  )

  await useFiles.getState().open("/w/three.ts", { preview: true })
  check(
    "so the next look does not evict it",
    useFiles.getState().openIds.includes("/w/two.ts") &&
      useFiles.getState().previewId === "/w/three.ts",
    useFiles.getState().openIds
  )

  useFiles.getState().close("/w/three.ts")
  check(
    "closing the preview empties the slot rather than handing it on",
    useFiles.getState().previewId === null,
    "the neighbour that takes the selection was opened on its own terms"
  )

  finish()
}

await main()

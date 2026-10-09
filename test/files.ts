import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  compareEntries,
  createFile,
  indexFiles,
  insideAny,
  listDirectory,
  nameError,
  readTextFile,
  renamePath,
} from "../src/main/files"
import { matchesLoosely, shortlist } from "../src/renderer/lib/files/search"
import type { FileIndexEntry } from "../src/shared/api"
import { iconNameFor } from "../src/renderer/lib/files/icon-names"
import {
  defaultViewer,
  isImage,
  noteFileName,
  viewerLabel,
  viewersFor,
} from "../src/renderer/lib/files/viewers"
import {
  isInside,
  movedPath,
  nameOf,
  parentOf,
  stemEnd,
} from "../src/renderer/lib/files/paths"
import { check, finish, section } from "./harness"

/**
 * The Explorer's side of the disk.
 *
 * Two things here are worth a test rather than a read-through. The first is
 * `insideAny`, which is the only thing standing between an absolute path from
 * the renderer and the rest of the machine: it is not a security boundary
 * anybody sees fail, it is one that either holds or quietly does not.
 *
 * The second is what a real directory does, which is why the listing and the
 * reads run against actual files in a temporary directory rather than a mocked
 * `fs` — a mock would agree with whatever this code believes about symlinks,
 * dotfiles and NUL bytes, which is precisely what is in question.
 */

async function main() {
  section("insideAny")

  check(
    "a path inside a folder is allowed",
    insideAny(["/a/project"], "/a/project/src/main.ts")
  )
  check("the folder itself is allowed", insideAny(["/a/project"], "/a/project"))
  check(
    "a sibling sharing a prefix is not inside it",
    !insideAny(["/a/project"], "/a/project-2/secrets.env"),
    "the `+ sep` in the check is what this is about"
  )
  check(
    "`..` cannot walk out of a folder",
    !insideAny(["/a/project"], "/a/project/../../etc/passwd")
  )
  check(
    "a path under any one of several folders is allowed",
    insideAny(["/a/one", "/b/two"], "/b/two/src/index.ts")
  )
  check("nothing is inside an empty workspace", !insideAny([], "/a/project"))

  section("nameError")

  check("a plain name is fine", nameError("index.ts") === null)
  check(
    "a dotfile is a name like any other",
    nameError(".env.example") === null
  )
  check("an empty name is refused", nameError("   ") !== null)
  check("a slash is refused", nameError("../etc/passwd") !== null)
  check("a bare `..` is refused", nameError("..") !== null)
  check("a backslash is refused", nameError("a\\b") !== null)

  section("compareEntries")

  const entry = (name: string, kind: "file" | "directory") => ({
    path: `/x/${name}`,
    name,
    kind,
  })

  check(
    "directories sort before files",
    [entry("zeta", "file"), entry("alpha", "directory")].sort(compareEntries)[0]
      ?.name === "alpha"
  )
  check(
    "numbers sort the way a person reads them",
    [entry("item10.ts", "file"), entry("item2.ts", "file")]
      .sort(compareEntries)
      .map((item) => item.name)
      .join() === "item2.ts,item10.ts"
  )
  check(
    "case does not split the alphabet in two",
    [entry("beta.ts", "file"), entry("Alpha.ts", "file")]
      .sort(compareEntries)
      .map((item) => item.name)
      .join() === "Alpha.ts,beta.ts"
  )

  section("paths, as the renderer splits them")

  check("a name is the last segment", nameOf("/a/b/main.ts") === "main.ts")
  check(
    "a Windows path splits on its own separator",
    nameOf("C:\\project\\src\\main.ts") === "main.ts",
    "the renderer never sees a normalised path — this is what `node:path` gave"
  )
  check(
    "the parent is everything above it",
    parentOf("/a/b/main.ts") === "/a/b"
  )
  check(
    "a Windows parent keeps its backslashes",
    parentOf("C:\\project\\src\\main.ts") === "C:\\project\\src"
  )
  check(
    "a file at the root has the root as its parent",
    parentOf("/a.txt") === "/"
  )

  check(
    "a file under a folder is inside it",
    isInside("/a/project", "/a/project/src/x.ts")
  )
  check(
    "a sibling sharing a prefix is not",
    !isInside("/a/project", "/a/project-2/x.ts"),
    "the same trap as `insideAny`, in the store that closes tabs"
  )
  check(
    "a Windows path under a Windows folder is inside it",
    isInside("C:\\project", "C:\\project\\src\\x.ts")
  )

  check(
    "renaming a directory moves everything under it",
    movedPath("/a/old/src/x.ts", "/a/old", "/a/new") === "/a/new/src/x.ts"
  )
  check(
    "renaming leaves a path that only shares a prefix alone",
    movedPath("/a/older/x.ts", "/a/old", "/a/new") === "/a/older/x.ts"
  )

  // What the rename field opens with selected. Getting this wrong is quiet: the
  // dialog still works, and the extension is either selected along with the name
  // — so the first keystroke drops it — or the last letters of the name are not.
  check("a name stops before its extension", stemEnd("report.txt") === 6)
  check(
    "a dotfile is all name",
    stemEnd(".gitignore") === ".gitignore".length,
    "the leading dot is part of the name, not an extension"
  )
  check("a name with no dot is all name", stemEnd("Makefile") === 8)
  check(
    "a compound suffix keeps everything but the last part",
    stemEnd("archive.tar.gz") === "archive.tar".length,
    "deciding that `.tar.gz` is one extension is a list with no end"
  )
  check("a trailing dot leaves itself behind", stemEnd("draft.") === 5)

  section("viewers")

  check("a picture is a picture", isImage("/w/logo.png"))
  check("case in the extension does not matter", isImage("/w/Logo.PNG"))
  check("a source file is not", !isImage("/w/src/main.ts"))
  check(
    "a dotfile is not an extension",
    !isImage("/w/.png"),
    "the leading dot is part of the name, not a suffix"
  )

  check("an image opens as a picture", defaultViewer("/w/logo.png") === "image")
  check("everything else opens as text", defaultViewer("/w/a.ts") === "text")
  check(
    "an SVG opens as a picture first",
    defaultViewer("/w/icon.svg") === "image"
  )
  check(
    "and has the text editor as its second way",
    viewersFor("/w/icon.svg").join() === "image,text,diff",
    "which is what puts the menu on it — see viewersFor"
  )
  check(
    "a PNG has only the one",
    viewersFor("/w/logo.png").join() === "image",
    "no diff either: two versions of a picture as text is nothing to read"
  )
  check(
    "a text file has the editor and its diff",
    viewersFor("/w/a.ts").join() === "text,diff"
  )

  check(
    "an html file opens as the page, with its source after it",
    viewersFor("/w/index.HTML").join() === "html,text,diff" &&
      viewersFor("/w/a.htm").join() === "html,text,diff",
    "what somebody clicks one to find out is what it looks like"
  )

  check(
    "a markdown file opens as the document",
    defaultViewer("/w/README.md") === "markdown",
    "the Explorer is where files are read; the editor is asked for"
  )
  check(
    "and has the text editor and the block editor after it",
    viewersFor("/w/README.md").join() === "markdown,text,blocks,diff"
  )
  check(
    "`.markdown` is the same file",
    viewersFor("/w/notes.MARKDOWN").join() === "markdown,text,blocks,diff"
  )
  check(
    "an MDX is not offered either",
    viewersFor("/w/page.mdx").join() === "text,diff",
    "a commonmark parser drops its component tags — see MARKDOWN_EXTENSIONS"
  )

  check(
    "a diff is never what a file opens as",
    ["/w/a.ts", "/w/README.md", "/w/spec.note", "/w/icon.svg"].every(
      (file) => defaultViewer(file) !== "diff"
    ),
    "a diff is asked for — see the Viewer comment"
  )

  check(
    "a note opens in the block editor",
    defaultViewer("/w/spec.note") === "blocks",
    "the editor is the point of the file; the JSON under it is not"
  )
  check(
    "and keeps the text editor behind it",
    viewersFor("/w/spec.note").join() === "blocks,text,diff"
  )
  check(
    "the block editor is named for the file it is opening",
    viewerLabel("blocks", "/w/spec.note") === "Note editor" &&
      viewerLabel("blocks", "/w/README.md") === "Markdown editor",
    "one viewer, two honest names — see viewerLabel"
  )
  check(
    "a name typed into New note gets the extension",
    noteFileName("Release plan") === "Release plan.note"
  )
  check(
    "and is not given it twice",
    noteFileName("Release plan.note") === "Release plan.note"
  )

  section("file-type icons")

  check(
    "an extension decides most of them",
    iconNameFor("/w/a.tsx") === "reactts"
  )
  check(
    "several extensions can share one",
    iconNameFor("/w/a.mts") === iconNameFor("/w/a.ts")
  )
  check(
    "a whole name beats the extension it ends with",
    iconNameFor("/w/package.json") === "npm",
    "or every config file in a repository would be a JSON icon"
  )
  check(
    "a family is matched by how it starts",
    iconNameFor("/w/tsconfig.build.json") === "tsconfig"
  )
  check("a dotfile is matched whole", iconNameFor("/w/.gitignore") === "git")
  check(
    "and so is one with something after it",
    iconNameFor("/w/.env.local") === "dotenv"
  )
  check("case does not matter", iconNameFor("/w/Dockerfile") === "docker")
  check(
    "a file with no extension at all is still recognised",
    iconNameFor("/w/Makefile") === "gnu",
    "which is what vscode-icons itself files a makefile under"
  )
  check(
    "as are the others in that family",
    ["/w/Gemfile", "/w/go.mod", "/w/Cargo.lock", "/w/CMakeLists.txt"].every(
      (candidate) => iconNameFor(candidate) !== null
    )
  )
  check(
    "an ignore-file goes with the rc-file beside it",
    iconNameFor("/w/.prettierignore") === "prettier"
  )
  check(
    "an unknown type has no icon rather than a wrong one",
    iconNameFor("/w/notes.xyz") === null,
    "null is what sends the tree back to its own glyphs"
  )

  const root = await mkdtemp(path.join(tmpdir(), "yasuo-files-"))
  try {
    section("listDirectory")

    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "README.md"), "# hi\n")
    await writeFile(path.join(root, ".env.example"), "KEY=\n")
    await symlink(path.join(root, "src"), path.join(root, "link-to-src"))

    const listing = await listDirectory(root)
    check(
      "everything is listed, dotfiles included",
      listing
        .map((item) => item.name)
        .sort()
        .join() ===
        [".env.example", "README.md", "link-to-src", "src"].sort().join(),
      listing.map((item) => item.name)
    )
    check(
      "a symlink to a directory is listed as a directory",
      listing.find((item) => item.name === "link-to-src")?.kind === "directory"
    )
    check(
      "directories come first",
      listing.slice(0, 2).every((item) => item.kind === "directory"),
      listing.map((item) => `${item.kind}:${item.name}`)
    )
    check(
      "each entry carries its own absolute path",
      listing.every((item) => item.path === path.join(root, item.name))
    )

    section("readTextFile")

    // A multi-byte character, because the read is bytes and the answer is a
    // string: a naive slice is where this goes wrong.
    await writeFile(path.join(root, "utf8.txt"), "héllo — wörld\n")
    const text = await readTextFile(path.join(root, "utf8.txt"))
    check(
      "text comes back as text, decoded",
      text.kind === "text" && text.text === "héllo — wörld\n",
      text
    )

    await writeFile(
      path.join(root, "image.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a])
    )
    check(
      "a NUL byte means binary rather than mojibake",
      (await readTextFile(path.join(root, "image.bin"))).kind === "binary"
    )

    await writeFile(path.join(root, "big.log"), "x".repeat(3 * 1024 * 1024))
    const big = await readTextFile(path.join(root, "big.log"))
    check(
      "a file past the limit is refused rather than read",
      big.kind === "too-large" && big.size === 3 * 1024 * 1024,
      big
    )

    section("indexFiles")

    await mkdir(path.join(root, "node_modules", "left-pad"), {
      recursive: true,
    })
    await writeFile(
      path.join(root, "node_modules", "left-pad", "index.js"),
      "module.exports = 1\n"
    )
    await mkdir(path.join(root, "src", "lib"), { recursive: true })
    await writeFile(path.join(root, "src", "lib", "store.ts"), "export {}\n")

    const indexed = await indexFiles(root, "folder-1")
    const relatives = indexed.map((item) => item.relative)
    check(
      "a file nested under a folder nobody expanded is indexed",
      relatives.includes("src/lib/store.ts"),
      relatives
    )
    check(
      "node_modules is walked straight past",
      !relatives.some((relative) => relative.startsWith("node_modules/")),
      relatives
    )
    check(
      "a relative path is written with forward slashes",
      relatives.every((relative) => !relative.includes("\\"))
    )
    check(
      "a symlinked directory is not descended into",
      !relatives.some((relative) => relative.startsWith("link-to-src")),
      "following one is how a walk finds its way back to where it started"
    )
    check(
      "the budget is a hard stop",
      (await indexFiles(root, "folder-1", 2)).length === 2
    )
    check(
      "every entry carries the folder it was found under",
      indexed.every((item) => item.folderId === "folder-1")
    )
    check(
      "a folder is indexed too, for a chat's @ menu",
      indexed.some(
        (item) => item.relative === "src/lib" && item.kind === "directory"
      ),
      relatives
    )
    check(
      "an ignored folder is not itself a row either",
      !relatives.includes("node_modules")
    )
    check(
      "a file carries its size, which is what the @ menu turns into tokens",
      indexed.find((item) => item.relative === "src/lib/store.ts")?.bytes ===
        "export {}\n".length
    )
    check(
      "a folder has no size of its own",
      indexed
        .filter((item) => item.kind === "directory")
        .every((item) => item.bytes === 0)
    )

    section("shortlist")

    const entry = (
      relative: string,
      kind: "file" | "directory" = "file"
    ): FileIndexEntry => ({
      path: `/w/${relative}`,
      relative,
      folderId: "folder-1",
      kind,
      bytes: 100,
    })
    const index = [
      entry("src/store.ts"),
      entry("src/renderer/lib/db/explorer-store.ts"),
      entry("docs/design.md"),
      entry("src/lib/files/store.ts"),
      entry("src/lib/files", "directory"),
    ]

    check(
      "nothing matches until something is typed",
      shortlist(index, "").length === 0
    )
    check(
      "a name match beats a path that merely contains the word",
      shortlist(index, "store")[0]?.relative === "src/store.ts",
      shortlist(index, "store").map((item) => item.relative)
    )
    check(
      "characters in order find a path they are scattered through",
      shortlist(index, "slfs")
        .map((item) => item.relative)
        .includes("src/lib/files/store.ts"),
      "the `slfs` → `src/lib/files/store.ts` shape a file palette has always had"
    )
    check(
      "a typed slash is not something the path has to match literally",
      shortlist(index, "libfiles")
        .map((item) => item.relative)
        .includes("src/lib/files/store.ts")
    )
    check(
      "a query nothing matches gives nothing",
      shortlist(index, "zzz").length === 0
    )
    check("the limit is honoured", shortlist(index, "s", 2).length === 2)
    check(
      "a folder is not a palette row: the palette opens tabs",
      shortlist(index, "libfiles").every((item) => item.kind === "file"),
      shortlist(index, "libfiles").map((item) => item.relative)
    )

    check("an empty query matches anything", matchesLoosely("abc", ""))
    check("characters must appear in order", !matchesLoosely("abc", "cb"))

    section("createFile and renamePath")

    const created = await createFile(root, "notes.md")
    check(
      "a new file lands where it was asked for",
      created === path.join(root, "notes.md")
    )

    let clobbered = false
    await writeFile(path.join(root, "notes.md"), "written by hand\n")
    await createFile(root, "notes.md").then(
      () => {
        clobbered = true
      },
      () => {}
    )
    check(
      "creating over an existing file fails rather than emptying it",
      !clobbered
    )

    const renamed = await renamePath(path.join(root, "notes.md"), "notes.txt")
    check(
      "a rename hands back the new path",
      renamed === path.join(root, "notes.txt")
    )

    let replaced = false
    await renamePath(path.join(root, "notes.txt"), "README.md").then(
      () => {
        replaced = true
      },
      () => {}
    )
    check("a rename refuses to land on something that exists", !replaced)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  finish()
}

await main()

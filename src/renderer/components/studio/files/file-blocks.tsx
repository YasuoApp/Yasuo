import { useCallback, useState } from "react"

import { splitFrontmatter, withFrontmatter } from "@/lib/files/block-doc"
import {
  frontmatterEntriesOf,
  frontmatterTableBlock,
  isFrontmatterBlock,
  parseFrontmatterEntries,
  printFrontmatter,
  type FrontmatterEntry,
} from "@/lib/files/frontmatter"
import { splitRawHtml } from "@/lib/markdown/raw-html"
import type { NoteBlock } from "@/lib/note/blocks"
import { blocksFromMarkdown } from "@/lib/note/from-markdown"
import { BlockEditor, type Editor } from "../note/block-editor"
import { RAW_HTML_BLOCK } from "../note/raw-html-block"

/**
 * A `.md`, in the block editor.
 *
 * **The only thing left that mounts `BlockEditor`.** It came from the Notes
 * panel, which kept a record under `~/.vsclaude` and wrote it as it was typed;
 * that panel is gone (`docs/design.md` § Notes, removed) and what it left is
 * this — a file in one of the workspace's folders, going through the files store
 * like every other tab: typing marks it dirty, ⌘S and the header's Save write
 * it, and closing the tab flushes it. That is the Explorer's bargain, and it is
 * the right one here — the file is in somebody's repository, beside their
 * source, and a rich-text pane that wrote to it on every keystroke would be
 * committing to their working tree while they thought.
 *
 * **The difference is worth knowing before choosing this over the text
 * editor.** A `.md` holds markdown, and BlockNote's markdown export is lossy by
 * its own documentation — children of blocks that are not list items are un-nested,
 * some styles are dropped — and it prints the *whole* file from the document, so
 * the first save reflows every line whether or not it was edited. Nothing is
 * written until there is an edit, and the text editor stays the default for a
 * `.md`, which is what keeps this a choice rather than a surprise.
 *
 * **Two parts of a `.md` do not go through the editor's own schema at all**,
 * because the document has no shape for either and a save would take them out
 * of the file:
 *
 * - Its **frontmatter**, which arrives as the two-column table at the top and
 *   goes back out as YAML. `lib/files/block-doc.ts` takes the block off the
 *   front of the file and `lib/files/frontmatter.ts` decides whether it is flat
 *   enough to be rows — a nested map or a list over several lines is not, and is
 *   carried around the editor untouched the way all of it used to be.
 * - Every run of the file with **HTML** in it, held verbatim in a read-only
 *   block — `note/raw-html-block.tsx` and `lib/markdown/raw-html.ts`.
 *
 * Drawings and dropped pictures are off for a `.md` for a third reason — see
 * `workspaceFiles` on `BlockEditor`.
 */
export function FileBlocks({
  path,
  text,
  onChange,
  visible,
}: {
  path: string
  text: string
  onChange: (text: string) => void
  visible: boolean
}) {
  /*
   * What the editor starts on, read once.
   *
   * State with an initialiser rather than anything derived from `text`, which
   * changes on every keystroke — it is what this editor just wrote. Parsing it
   * per render would be a parse of the whole document per character, and the
   * editor takes its content at construction anyway. The pane keys this
   * component by path, so a different file starts a fresh read.
   *
   * The frontmatter is kept here beside the blocks because it is the half the
   * save has to reason about rather than print: unchanged rows go back out as
   * the bytes they came in as, and a block with shape to it never left.
   */
  const [initial] = useState(() => read(text))

  const write = useCallback(
    (blocks: NoteBlock[], editor: Editor) => {
      const frontmatter = frontmatterOf(blocks, initial)
      const body = printBody(blocks, editor)
      // A file emptied down to its frontmatter is the block and one newline,
      // rather than the block and the blank line that would have separated it
      // from prose that is no longer there.
      if (body === "") {
        onChange(frontmatter === "" ? "" : `${frontmatter}\n`)
        return
      }
      onChange(withFrontmatter(frontmatter, body))
    },
    [onChange, initial]
  )

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Said out loud, because a document is not the file when part of it is
          somewhere else. The strip is the pane's own failure line in shape and
          weight — it is the same kind of thing: something about this file the
          editor is not showing the ordinary way. */}
      {initial.frontmatter !== "" && (
        <p className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
          {initial.entries
            ? "The table at the top is this file's frontmatter. Removing it altogether is done in the text editor."
            : "Frontmatter is kept exactly as it is and not shown here. Open the text editor to change it."}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <BlockEditor
          key={path}
          initial={initial.blocks}
          onChange={write}
          visible={visible}
          workspaceFiles={false}
        />
      </div>
    </div>
  )
}

/** One file's text as blocks, with what the save will need to know about its
 * frontmatter. */
function read(text: string): {
  blocks: NoteBlock[]
  frontmatter: string
  /** The rows the table was built from, or null for a block that could not be
   * one — which is also how the save knows there is no table to read back. */
  entries: FrontmatterEntry[] | null
} {
  const { frontmatter, body } = splitFrontmatter(text)
  const entries =
    frontmatter === "" ? null : parseFrontmatterEntries(frontmatter)
  const blocks = markdownBlocks(body)

  return {
    frontmatter,
    entries,
    blocks: entries
      ? [
          frontmatterTableBlock(entries),
          // A document whose only block is a table has nowhere to put the
          // caret to start writing under it.
          ...(blocks.length > 0 ? blocks : [{ type: "paragraph" }]),
        ]
      : blocks,
  }
}

/**
 * A markdown body as blocks, with the runs that have HTML in them held back.
 *
 * The split is per run rather than per file so that what the parser is given is
 * still markdown — a `<details>` taken out of the middle of a README leaves the
 * prose either side of it parsing exactly as it did.
 */
function markdownBlocks(body: string): NoteBlock[] {
  return splitRawHtml(body).flatMap((segment) =>
    segment.kind === "html"
      ? [{ type: RAW_HTML_BLOCK, props: { source: segment.text } }]
      : // Without the fences: a `.md` is written back as markdown, and a
        // drawing block has none — see `blocksFromMarkdown`.
        blocksFromMarkdown(segment.text, { drawings: false })
  )
}

/**
 * The frontmatter to write, given the document as it now is.
 *
 * Unchanged rows print back as the bytes they arrived as, rather than as what
 * the printer would make of them: quoting in YAML is typed — `"true"` is a
 * string and `true` is not — so a block nobody touched must not be printed at
 * all.
 *
 * **A table that is gone leaves the frontmatter alone**, and does not delete it.
 * The two readings of a deleted table are "take the metadata out of the file"
 * and "get this out of my way", and the cost of being wrong is not symmetrical:
 * a file that quietly lost its frontmatter is a file the site build, the docs
 * pipeline or the skill loader stops finding, where a frontmatter that came back
 * is a surprise and nothing more. The strip above the editor says where to go to
 * remove it.
 */
function frontmatterOf(
  blocks: NoteBlock[],
  initial: { frontmatter: string; entries: FrontmatterEntry[] | null }
): string {
  const table = blocks.find(isFrontmatterBlock)
  if (!table || !initial.entries) return initial.frontmatter

  const entries = frontmatterEntriesOf(table)
  return same(entries, initial.entries)
    ? initial.frontmatter
    : printFrontmatter(entries)
}

function same(a: FrontmatterEntry[], b: FrontmatterEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.key === b[index]!.key && entry.value === b[index]!.value
    )
  )
}

/**
 * The document as markdown: the editor's own printing, with the held runs put
 * back where they were.
 *
 * One `blocksToMarkdownLossy` per stretch of ordinary blocks rather than one for
 * the whole document, because the held runs are the boundaries — a run's source
 * has to be printed as it stands, and asking the exporter for it would give back
 * whatever its schema could make of the tags, which is the loss this whole
 * arrangement exists to avoid.
 */
function printBody(blocks: NoteBlock[], editor: Editor): string {
  const parts: string[] = []
  let run: NoteBlock[] = []

  const flush = () => {
    if (run.length === 0) return
    // Asked of the editor rather than of the blocks: the document is its own
    // schema's, and printing it is the one thing only the editor can do.
    //
    // Cast because `NoteBlock` is deliberately structural (see
    // `lib/note/blocks.ts`), and typing this against the schema's own generics
    // would spread three type parameters across everything that touches a note.
    const markdown = editor
      .blocksToMarkdownLossy(
        run as unknown as Parameters<Editor["blocksToMarkdownLossy"]>[0]
      )
      .trim()
    run = []
    if (markdown !== "") parts.push(markdown)
  }

  for (const block of blocks) {
    // Its own table, printed as YAML by `frontmatterOf` — and printed here as
    // well it would be a markdown table at the top of the file too.
    if (isFrontmatterBlock(block)) continue

    if (block.type === RAW_HTML_BLOCK) {
      flush()
      const source = String(block.props?.source ?? "")
      if (source.trim() !== "") parts.push(source)
      continue
    }
    run.push(block)
  }
  flush()

  if (parts.length === 0) return ""
  // Exactly one trailing newline, like every other file in a repository — the
  // exporter's own output ends wherever the last block did.
  return `${parts.join("\n\n")}\n`
}

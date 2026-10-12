import {
  parseFrontmatterEntries,
  plainValue,
  type FrontmatterEntry,
} from "@/lib/files/frontmatter"
import { splitFrontmatter } from "@/lib/files/block-doc"
import { parentOf } from "@/lib/files/paths"
import { MarkdownView } from "../markdown-view"
import "./file-markdown.css"

/**
 * A `.md` file as the document it is.
 *
 * The same component the chat transcript uses, in a column rather than a
 * bubble: a measure the eye can track back along, and the type scale a heading
 * in a document wants — `markdown-view.css` is deliberately flat, because `##`
 * in a chat message means "next section" rather than "twice as large", and in a
 * README it means exactly that. `rawHtml` is the other difference and the larger
 * one: the markup in a file is part of the file, so it is rendered rather than
 * printed — see the comment on `MarkdownView`.
 *
 * Read-only, and no second copy of the text: this draws `docs[path]`, the same
 * buffer the editor writes into, so switching back to it and typing and
 * switching here again shows what was typed rather than what is on disk.
 *
 * **Laid out like the block editor, because it is the same file.** A `.md` has
 * three views and two of them set the text as a document — this one and the
 * Markdown editor — so switching between them must not move the text. The
 * measure is `--prose-measure`, the token both read (`styles/globals.css`), and
 * the side padding is the proportional-with-a-ceiling one from
 * `note/note-editor.css`: on a wide pane the centring decides the margin and
 * the two are identical, and on a pane 500px across they narrow together
 * instead of one of them keeping a gutter it cannot afford.
 *
 * It used to be `max-w-2xl` with `px-8` inside it, which made the column 38rem
 * against the editor's 60 — a document with half the pane empty on either side,
 * and a visible jump every time the view was switched.
 */
export function FileMarkdown({
  text,
  path,
}: {
  text: string
  /** The file, whose directory the document's own pictures sit next to. */
  path: string
}) {
  const { frontmatter, body } = splitFrontmatter(text)
  const entries =
    frontmatter === "" ? null : parseFrontmatterEntries(frontmatter)

  return (
    // Padding on the scrolling box and the measure inside it, which is the
    // editor's own arrangement: padding on the centred column instead would
    // come out of the measure rather than out of the margin.
    <div className="h-full overflow-auto px-[clamp(2rem,4%,3.5rem)] pt-6 pb-16">
      <div className="mx-auto max-w-[var(--prose-measure)]">
        {frontmatter !== "" &&
          (entries ? (
            <Frontmatter entries={entries} />
          ) : (
            /* A block with shape to it — a nested map, a list over several
               lines — has no second column to sit in, so it is shown as the
               YAML it is rather than flattened into rows that would say
               something else. `lib/files/frontmatter.ts` decides which. */
            <pre className="markdown-frontmatter-source">{frontmatter}</pre>
          ))}

        <MarkdownView
          source={body}
          rawHtml
          baseDir={parentOf(path)}
          className="markdown-document text-[0.9375rem]"
        />
      </div>
    </div>
  )
}

/**
 * The file's metadata as the two-column table GitHub draws for the same bytes.
 *
 * Keys down the left as `<th>` rather than a heading row, because that is the
 * shape of the thing: a heading row would have to be called something, and the
 * two columns have no names beyond "the key" and "the value".
 *
 * The values have their quotes taken off, which the block editor's own copy of
 * this table deliberately does not do — this one is only ever read, so there is
 * no printing it back and nothing for the quoting to have to mean on the way
 * out.
 */
function Frontmatter({ entries }: { entries: FrontmatterEntry[] }) {
  if (entries.length === 0) return null

  return (
    <table className="markdown-frontmatter">
      <tbody>
        {entries.map(({ key, value }, index) => (
          <tr key={`${key}-${index}`}>
            <th scope="row">{key}</th>
            <td>{plainValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

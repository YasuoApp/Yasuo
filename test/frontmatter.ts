import {
  FRONTMATTER_BLOCK_ID,
  frontmatterEntriesOf,
  frontmatterTableBlock,
  isFrontmatterBlock,
  parseFrontmatterEntries,
  plainValue,
  printFrontmatter,
} from "../src/renderer/lib/files/frontmatter"
import { check, finish, section } from "./harness"

/**
 * The frontmatter a markdown file carries, as the rows the block editor shows.
 *
 * `test/block-doc.ts` covers taking the block off the front of the file; this is
 * the next step, and it is the one that can change the bytes. A row misread is a
 * `license: MIT` printed back as something else, and the thing reading that file
 * for its metadata — a site build, a docs pipeline, a skill loader — stops
 * finding what it needs. So the two checks that matter most are here: what is
 * refused rather than flattened, and that a frontmatter nobody edited prints
 * back exactly as it arrived.
 */

section("a flat block is rows")

const flat = parseFrontmatterEntries(
  "---\nname: doc\ndescription: Maintain project documentation\nlicense: MIT\n---"
)

check("every line is a row", flat?.length === 3, flat)
check("in the file's order", flat?.[0]?.key === "name", flat)
check(
  "with the value after the colon",
  flat?.[1]?.value === "Maintain project documentation",
  flat
)
check(
  "an em dash and a backtick are just text",
  parseFrontmatterEntries(
    "---\ndescription: NOT for analysis — use the `spec` skill\n---"
  )?.[0]?.value === "NOT for analysis — use the `spec` skill"
)
check(
  "a value with no value is a row all the same",
  parseFrontmatterEntries("---\nname:\n---")?.[0]?.value === "",
  parseFrontmatterEntries("---\nname:\n---")
)
check(
  "a dotted or slashed key is a key",
  parseFrontmatterEntries("---\nbuild.id: 4\ndocs/path: a\n---")?.length === 2
)
check(
  "a blank line carries nothing and is skipped",
  parseFrontmatterEntries("---\na: 1\n\nb: 2\n---")?.length === 2
)
check(
  "the fences are optional on the way in",
  parseFrontmatterEntries("a: 1")?.[0]?.key === "a"
)

section("a block with shape to it is refused")

// Every one of these would come back as something else if it were flattened
// into two columns and printed again — which is the whole reason for the null.
check(
  "a nested map",
  parseFrontmatterEntries("---\ntool:\n  name: doc\n---") === null
)
check(
  "a list over several lines",
  parseFrontmatterEntries("---\ntags:\n  - a\n  - b\n---") === null
)
check(
  "a flow sequence, which reads back as a string",
  parseFrontmatterEntries("---\ntags: [a, b]\n---") === null
)
check(
  "a block scalar, whose value is on the lines below",
  parseFrontmatterEntries("---\nbody: |\n  hello\n---") === null
)
check(
  "an anchor",
  parseFrontmatterEntries("---\nbase: &ref value\n---") === null
)
check(
  "a comment, which would be printed back as nothing",
  parseFrontmatterEntries("---\n# the tool's name\nname: doc\n---") === null
)
check(
  "a line that is not a pair at all",
  parseFrontmatterEntries("---\njust prose\n---") === null
)
check(
  "an unclosed quote",
  parseFrontmatterEntries('---\nname: "doc\n---') === null
)

section("printing puts it back")

const source =
  "---\nname: doc\ndescription: Maintain project documentation\nlicense: MIT\n---"

check(
  "a block nobody edited prints back byte for byte",
  printFrontmatter(parseFrontmatterEntries(source)!) === source,
  printFrontmatter(parseFrontmatterEntries(source)!)
)
check(
  "an already-quoted value keeps its quotes rather than gaining meaning",
  printFrontmatter([{ key: "a", value: '"true"' }]) === '---\na: "true"\n---'
)
check(
  "an empty value prints as a bare key",
  printFrontmatter([{ key: "a", value: "" }]) === "---\na:\n---"
)
check(
  "no rows left means no fences either",
  printFrontmatter([]) === "" &&
    printFrontmatter([{ key: " ", value: "x" }]) === ""
)

section("a value typed in the table is quoted only when it has to be")

check(
  "plain text stays plain",
  printFrontmatter([{ key: "a", value: "Maintain the docs" }]) ===
    "---\na: Maintain the docs\n---"
)
check(
  // Without the quotes the rest of the line reads as a second key.
  "a colon and a space is quoted",
  printFrontmatter([{ key: "a", value: "hello: world" }]) ===
    '---\na: "hello: world"\n---'
)
check(
  "a trailing colon is quoted",
  printFrontmatter([{ key: "a", value: "note:" }]) === '---\na: "note:"\n---'
)
check(
  // ` #` starts a comment, so the rest of the value would be dropped.
  "a hash after a space is quoted",
  printFrontmatter([{ key: "a", value: "release #4" }]) ===
    '---\na: "release #4"\n---'
)
check(
  "a leading indicator is quoted",
  printFrontmatter([{ key: "a", value: "[not a list]" }]) ===
    '---\na: "[not a list]"\n---'
)
check(
  "a negative number is not",
  printFrontmatter([{ key: "a", value: "-1" }]) === "---\na: -1\n---"
)

section("quotes come off only for something that will not print it again")

check("double quotes", plainValue('"hello: world"') === "hello: world")
check(
  "single quotes, with the doubling undone",
  plainValue("'it''s'") === "it's"
)
check("and plain text is itself", plainValue("MIT") === "MIT")

section("the table it becomes, and back")

const block = frontmatterTableBlock([
  { key: "name", value: "doc" },
  { key: "license", value: "MIT" },
])

check("carries the id the save looks for", isFrontmatterBlock(block), block)
check(
  "and only that id",
  !isFrontmatterBlock({ ...block, id: "something-else" })
)
check(
  "keys are the header column, which is what makes it read down the side",
  (block.content as { headerCols?: number }).headerCols === 1
)
check(
  "written as one row per pair",
  frontmatterEntriesOf(block).length === 2 &&
    frontmatterEntriesOf(block)[1]?.value === "MIT",
  frontmatterEntriesOf(block)
)

// What BlockNote hands back after the table has been in a document: cells as
// its own objects around styled inline content, rather than the strings it was
// given. Both shapes have to read, or a save after an edit loses every row.
const edited = {
  id: FRONTMATTER_BLOCK_ID,
  type: "table",
  content: {
    type: "tableContent",
    headerCols: 1,
    rows: [
      {
        cells: [
          { type: "tableCell", content: [{ type: "text", text: "name" }] },
          {
            type: "tableCell",
            content: [
              { type: "text", text: "doc" },
              { type: "text", text: "s" },
            ],
          },
        ],
      },
      { cells: [{ type: "tableCell", content: [] }] },
    ],
  },
}

check(
  "a cell BlockNote wrote reads back as its text",
  frontmatterEntriesOf(edited)[0]?.value === "docs",
  frontmatterEntriesOf(edited)
)
check(
  "an empty cell, and a row with no second one, are empty rather than a throw",
  frontmatterEntriesOf(edited)[1]?.key === "" &&
    frontmatterEntriesOf(edited)[1]?.value === ""
)

finish()

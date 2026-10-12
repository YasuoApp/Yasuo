import {
  estimateTokens,
  formatTokens,
  insertMention,
  markMentions,
  mentionOf,
  mentionQuery,
  pathMentions,
  rankPlainMentions,
  type IndexedPath,
  type PlainMention,
} from "../src/renderer/lib/worktree-chat/mention-text"
import { check, finish, section } from "./harness"

/**
 * What `@` does in a chat's composer.
 *
 * Nothing is rewritten on the way out — `@` and the path picked are what is sent
 * — so what is worth testing is the things that are silent when they are wrong:
 * which text opens a menu (an email address must not), which paths a filter
 * finds, what a folder claims it would cost, and which runs are tinted. A tint
 * on the wrong run claims a word was meant as a file when it was not.
 */

const file = (relative: string, bytes = 400): IndexedPath => ({
  relative,
  kind: "file",
  bytes,
})
const folder = (relative: string): IndexedPath => ({
  relative,
  kind: "directory",
  bytes: 0,
})

const row = (
  label: string,
  kind: "file" | "directory" = "file"
): PlainMention => pathMentions([{ relative: label, kind, bytes: 400 }])[0]!

section("a query is a word starting with @")

const at = (text: string) => mentionQuery(text, text.length)

check("at the start of the message", at("@sr")?.filter === "sr")
check("mid-sentence", at("why is @src/main")?.filter === "src/main")
check("empty, the moment @ is typed", at("look at @")?.filter === "")
check(
  "slashes, dots and dashes belong to a path",
  at("@src/lib/note-html.ts") !== null
)
check("an email address is not a mention", at("mail me@example.com") === null)
check("nothing typed yet", at("hello") === null)
check(
  "the caret is what is read, not the end of the draft",
  mentionQuery("see @src later", "see @src".length)?.filter === "src"
)
check(
  "the caret past the query closes it",
  mentionQuery("see @src later", "see @src later".length) === null
)

section("picking a row replaces what was typed")

const draft = "why is @ipc slow?"
const caret = "why is @ipc".length
const query = mentionQuery(draft, caret)
const picked = query
  ? insertMention(draft, query, caret, mentionOf("src/main/ipc.ts"))
  : null

check(
  "the filter is replaced and the @ kept",
  picked?.text === "why is @src/main/ipc.ts slow?",
  picked?.text
)
check(
  "the caret lands at the end of the path",
  picked?.caret === "why is @src/main/ipc.ts".length
)

const midSentence = mentionQuery("why is @ipc", "why is @ipc".length)
check(
  "no second space where the draft already had one",
  midSentence
    ? insertMention(
        "why is @ipc slow?",
        midSentence,
        "why is @ipc".length,
        mentionOf("src/main/ipc.ts")
      ).text === "why is @src/main/ipc.ts slow?"
    : false
)

const only = mentionQuery("@", 1)
check(
  "a bare @ becomes the mention",
  only
    ? insertMention("@", only, 1, mentionOf("README.md")).text === "@README.md "
    : false
)

check(
  "a label already carrying its own sigil is inserted as it stands",
  only
    ? insertMention("@", only, 1, "@claude-review").text === "@claude-review "
    : false
)

section("a row says what it would cost")

check("a token is four bytes of source", estimateTokens(4000) === 1000)
check("nothing is nothing", estimateTokens(0) === 0)
check("under a thousand is said outright", formatTokens(820) === "~820 tokens")
check("thousands carry one decimal", formatTokens(1240) === "~1.2k tokens")
check("past ten, none", formatTokens(48_400) === "~48k tokens")
check("and millions", formatTokens(1_300_000) === "~1.3M tokens")

const tree = [
  folder("src"),
  folder("src/main"),
  file("src/main/ipc.ts", 8000),
  file("src/main/git.ts", 4000),
  file("README.md", 2000),
]
const costs = new Map(
  pathMentions(tree).map((mention) => [mention.label, mention.tokens])
)

check("a file's own size", costs.get("README.md") === 500)
check(
  "a folder carries everything indexed under it",
  costs.get("src/main") === 3000,
  costs.get("src/main")
)
check(
  "and so does the folder above it",
  costs.get("src") === 3000,
  costs.get("src")
)
check(
  "a file is not counted as a folder of its own name",
  costs.get("src/main/ipc.ts") === 2000
)
check(
  "the detail is the estimate",
  pathMentions([file("README.md", 2000)])[0]?.detail === "~500 tokens"
)

section("what is tinted is an @path the workspace holds")

const known = [row("src/main/ipc.ts"), row("src/main", "directory")]
const tinted = (text: string) =>
  markMentions(text, known)
    .filter((segment) => segment.kind !== null)
    .map((segment) => segment.text)

const untouched = markMentions("nothing here", known)
check(
  "the whole text is one run when nothing matches",
  untouched.length === 1 && untouched[0]?.kind === null
)
check(
  "a mention in a sentence, sigil and all",
  tinted("is @src/main/ipc.ts big?")[0] === "@src/main/ipc.ts",
  tinted("is @src/main/ipc.ts big?")
)
check(
  "the same path without the @ is just a word",
  tinted("is src/main/ipc.ts big?").length === 0,
  tinted("is src/main/ipc.ts big?")
)
check(
  "so a folder's name used as a word is left alone",
  markMentions("rewrite the main flow", [row("main", "directory")]).length === 1
)
check(
  "a mention at the end of a sentence keeps its full stop out of it",
  tinted("look at @src/main/ipc.ts.")[0] === "@src/main/ipc.ts"
)
check(
  "a mention in brackets is still a mention",
  tinted("(@src/main/ipc.ts)")[0] === "@src/main/ipc.ts"
)
check(
  "a path is not a prefix of a longer one",
  tinted("@src/main/ipc.ts.map").length === 0,
  tinted("@src/main/ipc.ts.map")
)
check(
  "a folder is not the file under it",
  markMentions("@src/main/ipc.ts", known)[0]?.kind === "file"
)
check(
  "the folder tints as a folder",
  markMentions("@src/main", known)[0]?.kind === "directory"
)
check("matching is case-sensitive", tinted("see @SRC/MAIN/IPC.TS").length === 0)
check(
  "twice in one line",
  tinted("@src/main/ipc.ts, then @src/main/ipc.ts").length === 2
)
check(
  "the runs put the text back together",
  markMentions("a @src/main/ipc.ts b", known)
    .map((segment) => segment.text)
    .join("") === "a @src/main/ipc.ts b"
)
check(
  "a one-character path is a mention now that it needs its @",
  markMentions("a @a c", [row("a")]).length === 3,
  markMentions("a @a c", [row("a")])
)
check("an empty draft is one empty run", markMentions("", known).length === 1)

section("rows are ranked the way the chat composer's are")

const rows = pathMentions(tree)
const ranked = rankPlainMentions(rows, "ipc").map((mention) => mention.label)
check("the file whose name starts with it", ranked[0] === "src/main/ipc.ts")
check("and nothing that matches nothing", ranked.length === 1, ranked)

const loose = rankPlainMentions(rows, "srcmaingit").map((row) => row.label)
check("characters in order find a path", loose[0] === "src/main/git.ts", loose)

const wide = rankPlainMentions(rows, "src/main").map((mention) => mention.label)
check(
  "a directory match ranks under a name match",
  wide[0] === "src/main" && wide.includes("src/main/ipc.ts"),
  wide
)

const nothing = rankPlainMentions(rows, "").map((mention) => mention.label)
check(
  "with nothing typed the top of the tree comes first, folders before files",
  nothing[0] === "src" && nothing[1] === "README.md",
  nothing
)
check(
  "and the deepest paths come last",
  nothing[nothing.length - 1]?.startsWith("src/main/") === true,
  nothing
)
check("the cap is honoured", rankPlainMentions(rows, "", 2).length === 2)

finish()

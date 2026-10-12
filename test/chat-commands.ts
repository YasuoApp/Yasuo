import { readCommand } from "../src/main/agent-commands"
import {
  commandQuery,
  insertCommand,
  localCommand,
  parseCommand,
  rankCommands,
  visibleCommands,
} from "../src/renderer/lib/worktree-chat/command-text"
import { check, finish, section } from "./harness"

/**
 * What `/` does in a chat's composer, and what the CLI's answer is narrowed to.
 *
 * The things worth testing here are the ones that are silent when they are
 * wrong. A menu that opens on `src/main` inserts a command into the middle of a
 * sentence. A `/clear` that `localCommand` fails to recognise is sent to the CLI
 * as prose, and the transcript it was meant to empty stays on screen. And a
 * `/clearly not a command` that it recognises *too* eagerly throws away a
 * conversation nobody asked it to.
 */

const command = (
  name: string,
  description = "",
  argumentHint = "",
  aliases: string[] = []
) => ({ name, description, argumentHint, aliases })

section("a query is a slash at the head of the message")

const slash = (text: string) => commandQuery(text, text.length)

check("at the start", slash("/cle")?.filter === "cle")
check("a bare slash offers everything", slash("/")?.filter === "")
check("namespaced", slash("/figma:figma-u")?.filter === "figma:figma-u")
check("after leading whitespace", slash("  /cle")?.filter === "cle")
check("after a leading newline", slash("\n/cle")?.filter === "cle")

// The narrowing that `@` deliberately does not do: a slash is punctuation in
// ordinary prose, and the CLI only reads a command at the head of a message.
check("not mid-sentence", slash("look at /clear") === null)
check("not in a path", slash("src/main") === null)
check("not in a url", slash("https://example.com/foo") === null)
check("not after a word", slash("and/or") === null)
check("nothing before the caret", commandQuery("/clear", 0) === null)

check(
  "the query starts at the slash",
  slash("  /cle")?.from === 2 && slash("/cle")?.from === 0
)

section("picking a row writes the command and a space")

{
  const query = commandQuery("/cle", 4)!
  const next = insertCommand("/cle", query, 4, "clear")
  check("replaces the typed query", next.text === "/clear ")
  check("caret after the space", next.caret === 7)
}

{
  // The `+` menu's way in: a slash typed at the head of what was already
  // written, so there is text after the caret to keep.
  const query = commandQuery("/re fix the tests", 3)!
  const next = insertCommand("/re fix the tests", query, 3, "rename")
  check("keeps what follows", next.text === "/rename  fix the tests")
  check("caret before it", next.caret === 8)
}

{
  const query = commandQuery("  /cle", 6)!
  const next = insertCommand("  /cle", query, 6, "clear")
  check("leaves the leading space alone", next.text === "  /clear ")
}

section("what a draft names")

check("a bare command", parseCommand("/clear")?.name === "clear")
check("its argument", parseCommand("/rename API work")?.argument === "API work")
check(
  "the argument is trimmed",
  parseCommand("/rename   API work  ")?.argument === "API work"
)
check(
  "no argument is empty, not undefined",
  parseCommand("/clear")?.argument === ""
)
check(
  "a namespaced one",
  parseCommand("/figma:figma-use x")?.name === "figma:figma-use"
)

// The argument stops at the line break for the reason the CLI's does: a command
// followed by two paragraphs is a command plus a message meant to go separately.
check(
  "the argument is the first line only",
  parseCommand("/rename API work\nand fix the tests")?.argument === "API work"
)

check("prose is not a command", parseCommand("fix the tests") === null)
check("a path is not a command", parseCommand("src/main/git.ts") === null)
check("a bare slash names nothing", parseCommand("/") === null)

section("only two commands are this app's")

check("clear", localCommand("/clear")?.name === "clear")
check(
  "rename, with its argument",
  localCommand("/rename API")?.argument === "API"
)

// Everything else goes to the CLI verbatim — that is the whole policy, and a
// command wrongly claimed here is one the CLI would never see.
check("compact is the CLI's", localCommand("/compact") === null)
check("a skill is the CLI's", localCommand("/code-review high") === null)
check("context is the CLI's", localCommand("/context") === null)

// The near-misses, which are what a loose match would swallow: both of these
// are messages, and reading either as `/clear` empties a conversation nobody
// asked to empty.
check("a longer word is not clear", localCommand("/clearly") === null)
check("prose starting with the word", localCommand("clear the cache") === null)

section("the menu leaves out what it cannot honour")

{
  const all = [
    command("clear"),
    command("compact"),
    command("model"),
    command("color"),
    command("heapdump"),
    command("__remote-workflow"),
    command("figma:figma-use"),
    command(""),
  ]
  const shown = visibleCommands(all).map((entry) => entry.name)

  check("keeps the CLI's own work commands", shown.includes("compact"))
  check("keeps a plugin's", shown.includes("figma:figma-use"))
  // Local, so it must survive the filter — hiding it would leave `/clear`
  // working when typed in full and absent from the menu that teaches it.
  check("keeps the ones this app answers", shown.includes("clear"))

  check("drops a terminal's own settings", !shown.includes("color"))
  check("drops what the toolbar already is", !shown.includes("model"))
  check("drops a process this app is not", !shown.includes("heapdump"))
  check("drops the CLI's internals", !shown.includes("__remote-workflow"))
  check("drops a row with no name", !shown.includes(""))
}

section("ranking puts what was typed first")

{
  const all = [
    command("code-review", "", "", ["review"]),
    command("clear"),
    command("compact"),
    command("context"),
    command("figma:figma-use"),
    command("document-skills:pdf", "", "", ["pdf"]),
  ]
  const names = (filter: string) =>
    rankCommands(all, filter, 40).map((entry) => entry.name)

  check("an empty filter keeps everything", names("").length === all.length)
  check("a prefix wins", names("cle")[0] === "clear")
  check("shorter breaks a tie", names("c")[0] === "clear")

  // The reason aliases are matched at all: the CLI offers `review`, and
  // somebody who knows the short form should not have to learn the long one.
  check("an alias matches", names("review")[0] === "code-review")
  check(
    "an alias on a namespaced command",
    names("pdf")[0] === "document-skills:pdf"
  )

  // A namespace is a prefix nobody types out, so the bare half is matched too.
  check("past the namespace", names("figma-u")[0] === "figma:figma-use")
  // …and a subsequence, which is what makes a long namespaced name reachable.
  check("a subsequence", names("fgu")[0] === "figma:figma-use")

  check("no match is no rows", names("zzzz").length === 0)
  check("the limit is honoured", rankCommands(all, "", 2).length === 2)
}

section("the CLI's answer is narrowed, not trusted")

{
  // Every field here was written by a process this app does not control, and a
  // third of them originate in a plugin's own frontmatter.
  const read = readCommand({
    name: "code-review",
    description: "  Review the diff  ",
    argumentHint: " [low|high] ",
    aliases: ["review", 7, null],
  })
  check("the name", read.name === "code-review")
  check("the description is trimmed", read.description === "Review the diff")
  check("the hint is trimmed", read.argumentHint === "[low|high]")
  check("non-string aliases are dropped", read.aliases.join() === "review")
}

{
  const read = readCommand({ name: "clear" })
  check("a missing description is empty", read.description === "")
  check("a missing hint is empty", read.argumentHint === "")
  check("missing aliases are a list", read.aliases.length === 0)
}

{
  // A row that is not an object at all, which is what a CLI release could send
  // and no signature here would catch.
  const read = readCommand(null)
  check("nothing becomes an empty name", read.name === "")
  check(
    "…which `visibleCommands` then drops",
    visibleCommands([read]).length === 0
  )
}

finish()

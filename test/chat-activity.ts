import type { AssistantMessage } from "../src/shared/api"
import {
  blockOf,
  blocksOf,
  countsOf,
  dayDividerBetween,
  rowsOf,
  summaryOf,
} from "../src/renderer/lib/worktree-chat/activity"
import {
  changeOf,
  describeCall,
  detailOf,
  resultImages,
  resultLine,
  resultText,
  todosOf,
} from "../src/main/claude-agent"
import { check, finish, section } from "./harness"

/**
 * A turn's working, folded — and the two halves that fill the rows inside it.
 *
 * `blocksOf` is worth a test because every case it has is a shape of transcript
 * rather than anything on screen: a turn still running has no answer to keep out
 * of the fold, a turn that only talked has nothing to fold, and a chat read back
 * off disk is several turns in a row with lines from builds that wrote fewer
 * fields. `describeCall` and `resultLine` are worth one because they read what
 * the CLI sends, which is the other thing this app does not own.
 */

let next = 0
const id = () => `l${(next += 1)}`

const user = (text: string): AssistantMessage => ({
  id: id(),
  role: "user",
  text,
})
const said = (text: string): AssistantMessage => ({
  id: id(),
  role: "assistant",
  text,
})
const thought = (text: string): AssistantMessage => ({
  id: id(),
  role: "thinking",
  text,
})
const tool = (name: string, summary = ""): AssistantMessage => ({
  id: id(),
  role: "tool",
  name,
  summary,
})
const failed = (text: string): AssistantMessage => ({
  id: id(),
  role: "error",
  text,
})
const decided = (text: string): AssistantMessage => ({
  id: id(),
  role: "ask",
  text,
})

section("one turn, folded")

const turn = blocksOf([
  user("where is the composer"),
  thought("I should look at the file"),
  said("Let me read it first."),
  tool("Read", "/a/chat-composer.tsx"),
  tool("Bash", "rg composer"),
  said("It is in `chat-composer.tsx`."),
])

check("the prompt is its own block", turn[0]?.kind === "line", turn[0])

check(
  "everything before the last word is one fold",
  turn[1]?.kind === "activity" && turn[1].lines.length === 4,
  turn[1]
)

// The whole argument for the fold: the answer is what somebody came back for,
// so it is the one thing that is never behind it.
check(
  "the last word is not folded",
  turn[2]?.kind === "line" &&
    turn[2].line.role === "assistant" &&
    turn[2].line.text.includes("chat-composer"),
  turn[2]
)

check("three blocks and no more", turn.length === 3, turn.length)

section("a turn still being answered")

// Nothing has been said last yet, so there is no answer to keep out — a fold
// that closed over the reply the moment it arrived would be the pane hiding
// what it had just written.
const running = blocksOf([
  user("refactor it"),
  thought("starting"),
  tool("Read", "/a/b.ts"),
])
check(
  "everything so far is working",
  running[1]?.kind === "activity" && running[1].lines.length === 2,
  running[1]
)
check("and nothing is drawn as an answer", running.length === 2)

// The shape that made this a bug: the turn narrated and then carried on
// working, so its sentence was not the last word after all. Everything after it
// was landing outside the fold, one row at a time, under a summary that was not
// counting them.
const narrated = blocksOf([
  user("refactor it"),
  thought("starting"),
  said("Now the renderer store:"),
  tool("Edit", "/a/store.ts"),
])
check(
  "a sentence the turn worked on past is folded with the rest",
  narrated.length === 2 &&
    narrated[1]?.kind === "activity" &&
    narrated[1].lines.length === 3,
  narrated
)

section("a turn with nothing to fold")

const chatty = blocksOf([user("hello"), said("Hello.")])
check(
  "no fold is made for a turn that only talked",
  chatty.every((block) => block.kind === "line"),
  chatty
)

section("what is never folded")

const refused = blocksOf([
  user("delete the request"),
  thought("it is refused"),
  decided("Refused Bash: rm -rf /"),
  tool("Read", "/a/b.ts"),
  said("I could not."),
])

check(
  "a refusal stays on screen",
  refused.some((block) => block.kind === "line" && block.line.role === "ask"),
  refused
)
// It breaks the run in two rather than being pulled to one end: where it
// happened is the thing being said.
check(
  "and splits the working around it",
  refused.filter((block) => block.kind === "activity").length === 2,
  refused.filter((block) => block.kind === "activity").length
)

const broke = blocksOf([user("go"), tool("Bash", "false"), failed("Exit 1")])
check(
  "an error stays on screen",
  broke.some((block) => block.kind === "line" && block.line.role === "error"),
  broke
)

section("several turns")

const two = blocksOf([
  user("one"),
  tool("Read", "/a"),
  said("done one"),
  user("two"),
  tool("Read", "/b"),
  said("done two"),
])
check("each turn folds on its own", two.length === 6, two.length)
check(
  "and neither fold reaches into the other",
  two.every((block) => block.kind !== "activity" || block.lines.length === 1)
)

section("finding the block a line ended up in")

/*
 * What `⌘F`'s find bar rings and scrolls to. The case worth the check is the
 * middle one: a message the model wrote mid-turn is *inside* that turn's fold,
 * so the answer has to be the fold rather than nothing — a match counted and
 * then scrolled nowhere is worse than one that was never counted.
 */
{
  const prompt = user("one")
  const mid = said("halfway through")
  const answer = said("done")
  const blocks = blocksOf([prompt, tool("Read", "/a"), mid, answer])

  check(
    "a line drawn as itself is its own block",
    blockOf(blocks, prompt.id) === prompt.id
  )
  check("so is a turn's last word", blockOf(blocks, answer.id) === answer.id)
  check(
    "a line inside the working answers with the fold holding it",
    blockOf(blocks, mid.id)?.startsWith("activity-") === true,
    blockOf(blocks, mid.id)
  )
  check(
    "a line this chat does not have is null",
    blockOf(blocks, "nope") === null
  )
}

section("lines from a build that wrote fewer fields")

// A chat on disk can open with lines that follow no prompt: a turn retried as a
// resume writes its own, and the prompt was written by the attempt before.
const orphaned = blocksOf([tool("Read", "/a"), said("hi")])
check("lines before any prompt still draw", orphaned.length === 2, orphaned)

check("an empty chat is no blocks", blocksOf([]).length === 0)

section("what the folded line says")

check(
  "a subagent is counted as an agent, not a tool call",
  countsOf([tool("Task", "Explore"), tool("Read", "/a")]).subagents === 1 &&
    countsOf([tool("Task", "Explore"), tool("Read", "/a")]).tools === 1
)

/* The CLI renamed the tool, and a transcript on disk holds whichever name was
 * current when it was written — so both are the subagent. Testing only the old
 * one is what let every `Agent` row be counted as an ordinary tool call. */
check(
  "under either of its names",
  countsOf([tool("Agent", "Explore"), tool("Read", "/a")]).subagents === 1 &&
    countsOf([tool("Agent", "Explore"), tool("Read", "/a")]).tools === 1
)

check(
  "thinking and narration are both messages",
  countsOf([thought("a"), said("b")]).messages === 2
)

check(
  "the sentence names what there is",
  summaryOf({ tools: 7, messages: 13, subagents: 1 }) ===
    "7 tool calls, 13 messages, 1 subagent"
)

// A count of zero is dropped rather than drawn: "0 subagents" is a fact nobody
// asked for.
check(
  "a count of zero is left out",
  summaryOf({ tools: 1, messages: 0, subagents: 0 }) === "1 tool call"
)

section("what an open fold draws")

/*
 * The shape the second fold was written for: the narration is what says why any
 * of the calls happened, and flat it is two sentences buried under eleven rows.
 */
const rows = rowsOf([
  tool("Read", "/a.png"),
  said("message 1"),
  tool("Edit", "/b.tsx"),
  tool("Edit", "/c.tsx"),
  said("message 2"),
])

check(
  "a run of calls is one row, the narration is its own",
  rows.map((row) => row.kind).join(" ") === "tools line tools line",
  rows.map((row) => row.kind)
)

check(
  "and each run says how many it has",
  rows[0]?.kind === "tools" &&
    summaryOf(rows[0].counts) === "1 tool call" &&
    rows[2]?.kind === "tools" &&
    summaryOf(rows[2].counts) === "2 tool calls",
  rows
)

// A run of one folds too — a row that is sometimes the call and sometimes a
// line about the call has to be worked out before it can be read.
check(
  "a single call is still a run",
  rowsOf([tool("Read", "/a")])[0]?.kind === "tools"
)

check(
  "thinking breaks a run the way narration does",
  rowsOf([tool("Read", "/a"), thought("hmm"), tool("Read", "/b")]).length === 3
)

check(
  "a fold of nothing but talk has no runs",
  rowsOf([said("hi")]).length === 1
)

check("and an empty fold is no rows", rowsOf([]).length === 0)

section("what a tool call says it is")

check(
  "a file is pulled out for the chip",
  describeCall("Read", { file_path: "/a/b/chat-composer.tsx" }).path ===
    "/a/b/chat-composer.tsx"
)

check(
  "a notebook counts as a file too",
  describeCall("NotebookEdit", { notebook_path: "/a/b.ipynb" }).path ===
    "/a/b.ipynb"
)

check(
  "a command keeps its own description",
  describeCall("Bash", {
    command: "bun test",
    description: "Run the test suite",
  }).title === "Run the test suite"
)

check(
  "and the command is still the argument",
  describeCall("Bash", { command: "bun test", description: "Run it" })
    .summary === "bun test"
)

/*
 * The failure this was written against: `Task` carries a description, a whole
 * prompt and a subagent type, none of which the key list names — so every
 * subagent row was 120 characters of the prompt's JSON.
 */
const agent = describeCall("Task", {
  description: "Find chat attachment code",
  subagent_type: "Explore",
  prompt: "a very long prompt ".repeat(40),
})
check("a subagent says which agent ran", agent.summary === "Explore", agent)
check(
  "and leads with its description",
  agent.title === "Find chat attachment code"
)
check("never the prompt", !JSON.stringify(agent).includes("very long prompt"))

const renamed = describeCall("Agent", {
  description: "Find chat attachment code",
  subagent_type: "Explore",
  prompt: "a very long prompt ".repeat(40),
})
check(
  "the same under the tool's new name",
  renamed.summary === "Explore" &&
    !JSON.stringify(renamed).includes("very long prompt"),
  renamed
)

check(
  "a call with nothing to say has no extras",
  describeCall("Read", {}).path === undefined &&
    describeCall("Read", {}).title === undefined
)

check(
  "a call with no input at all is safe",
  describeCall("Read", null).summary === ""
)

section("what a tool call came back with")

check(
  "one line of output is shown as it stands",
  resultLine("3 files changed") === "3 files changed"
)

// A `Read` returns the file, and a row that showed it would be the file in the
// transcript.
check("more than a line is counted", resultLine("a\nb\nc\nd") === "4 lines")

check(
  "the SDK's block form is read too",
  resultLine([{ type: "text", text: "one\ntwo" }]) === "2 lines"
)

check("nothing said is nothing shown", resultLine("") === "")
check("blank output is nothing shown", resultLine("   \n  ") === "")
check("a shape this does not know is nothing shown", resultLine(42) === "")

check(
  "a long single line is collapsed rather than wrapping the row",
  resultLine("x".repeat(400)).endsWith("…")
)

section("what an edit did")

/*
 * The row this was written against: `Edit` came back "The file
 * /Users/…/review-panel.tsx has been updated. Here's the result of running
 * `cat -n`…", which was the widest thing in the row and said nothing the chip
 * beside it had not. The call's own input has both sides of the change in it.
 */
const edited = describeCall("Edit", {
  file_path: "/w/a.ts",
  old_string: "const a = 1",
  new_string: "const a = 2\nconst b = 3",
})

check("an edit counts both sides", edited.stat === "+2 −1", edited.stat)

check(
  "and keeps them as the lines they were",
  edited.change === "- const a = 1\n+ const a = 2\n+ const b = 3",
  edited.change
)

check(
  "a write has one side, which is honest — it replaced the file",
  (() => {
    const written = changeOf("Write", { content: "one\ntwo\n" })
    return written.stat === "+2" && written.change === "+ one\n+ two"
  })(),
  "a trailing newline ends the last line rather than starting an empty one"
)

check(
  "a multi-edit is the total of its edits",
  (() => {
    const many = changeOf("MultiEdit", {
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c\nd", new_string: "e" },
      ],
    })
    return many.stat === "+2 −3"
  })()
)

check(
  "deleting a block is a change with nothing on the new side",
  (() => {
    const cut = changeOf("Edit", { old_string: "gone", new_string: "" })
    return cut.stat === "−1" && cut.change === "- gone"
  })(),
  "an empty string is a real side, so the split cannot be guarded on falsiness"
)

check(
  "a tool that is not an edit has nothing to say about one",
  changeOf("Read", { file_path: "/w/a.ts" }).stat === undefined
)

check(
  "and a long one is capped with a line saying how much is left",
  (() => {
    const big = changeOf("Write", {
      content: Array.from({ length: 40 }, (_, at) => `line ${at}`).join("\n"),
    })
    return (
      big.stat === "+40" &&
      big.change?.endsWith("… 24 more") === true &&
      big.change.split("\n").length === 17
    )
  })(),
  "this is a tooltip, not a pane"
)

section("the list the turn keeps")

/*
 * The row this was written against: `TodoWrite`'s input matches none of the keys
 * `argumentOf` looks for, so every one of them drew
 * `{"todos":[{"content":"…","status":"pending","activeForm":"…"}` cut at 120
 * characters — the one call in a transcript whose argument *is* the thing worth
 * reading.
 */
const list = describeCall("TodoWrite", {
  todos: [
    { content: "Read the store", status: "completed", activeForm: "Reading" },
    { content: "Wire the IPC", status: "in_progress", activeForm: "Wiring" },
    { content: "Write the test", status: "pending", activeForm: "Writing" },
  ],
})

check("the list is read out of the call", list.todos?.length === 3, list.todos)
check("the row says how far through it is", list.stat === "1/3", list.stat)
check(
  "and leads with the item being worked on",
  list.summary === "Wire the IPC",
  list.summary
)
// Or the panel below would open onto the same JSON the row exists to have
// removed.
check("with no argument left to open", list.input === undefined)

check(
  "activeForm is dropped — it is the same sentence in another tense",
  !JSON.stringify(list.todos).includes("Wiring")
)

check(
  "a list with nothing running says so by having nothing running",
  describeCall("TodoWrite", {
    todos: [{ content: "a", status: "completed" }],
  }).summary === ""
)

check(
  "an unknown status is read as pending rather than dropping the list",
  todosOf("TodoWrite", { todos: [{ content: "a", status: "blocked" }] })?.[0]
    ?.status === "pending"
)

check(
  "an item with no content is dropped",
  todosOf("TodoWrite", {
    todos: [{ content: "a", status: "pending" }, { status: "pending" }],
  })?.length === 1
)

/* A newer CLI that changes the shape lands back on the JSON argument the row
 * drew before any of this existed, rather than on an empty checklist. */
check(
  "a payload of another shape is not a list",
  todosOf("TodoWrite", {}) === null
)
check(
  "and neither is another tool's input",
  todosOf("Read", { todos: [{ content: "a", status: "pending" }] }) === null
)

section("what the folded line says about it")

const kept = (
  todos: { content: string; status: "pending" | "in_progress" | "completed" }[]
): AssistantMessage => ({
  id: id(),
  role: "tool",
  name: "TodoWrite",
  summary: "",
  todos,
})

check(
  "the closed fold carries the list's progress",
  summaryOf(
    countsOf([
      tool("Read", "/a"),
      kept([
        { content: "Read the store", status: "completed" },
        { content: "Wire the IPC", status: "in_progress" },
      ]),
    ])
  ) === "2 tool calls · Wire the IPC (1/2)",
  summaryOf(countsOf([tool("Read", "/a")]))
)

// The same list is written again every time an item starts or finishes, so a
// run holds five copies of it and only the last one is true.
check(
  "the last list wins, not the first",
  countsOf([
    kept([{ content: "a", status: "pending" }]),
    kept([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]),
  ]).todo?.done === 1
)

check(
  "a finished list drops the sentence and keeps the count",
  summaryOf(countsOf([kept([{ content: "a", status: "completed" }])])) ===
    "1 tool call · 1/1 done"
)

check(
  "a run with no list says nothing about one",
  countsOf([tool("Read", "/a")]).todo === undefined
)

section("what a row opens onto")

/*
 * The rule both `input` and `output` follow: a field is written only where the
 * row is not already showing the whole of it. A second copy of a short string on
 * every line grows the chat's file for nothing, and — worse — makes every row
 * openable, so the chevron stops meaning "there is more here".
 */

check(
  "a one-line command has nothing behind it",
  describeCall("Bash", { command: "bun test" }).input === undefined
)

check(
  "a multi-line command does",
  describeCall("Bash", { command: "cat <<EOF\nhello\nEOF" }).input ===
    "cat <<EOF\nhello\nEOF"
)

check(
  "and so does one past the row's 120",
  describeCall("Bash", { command: `echo ${"x".repeat(200)}` }).input?.length ===
    205
)

check(
  "a single path is all of itself",
  describeCall("Read", { file_path: "/a/b.ts" }).input === undefined
)

/* `Task`'s input is a whole prompt, and its row deliberately shows the agent's
 * name instead — opening onto the prompt would put back the 120 characters of
 * JSON that `describeCall` exists to have removed. */
check(
  "a subagent opens onto nothing",
  describeCall("Task", {
    subagent_type: "Explore",
    prompt: "long ".repeat(100),
  }).input === undefined
)

section("the whole of what came back")

check("the text is the text", resultText("one line") === "one line")

check(
  "blocks are joined",
  resultText([{ text: "a" }, { text: "b" }]) === "a\nb"
)

check("nothing is nothing", resultText(null) === "")

section("what is kept of it")

check("short output is untouched", detailOf("a\nb\nc") === "a\nb\nc")

/* Both caps say what they dropped rather than trailing off: a panel that
 * silently showed the first 200 lines of a 4,000-line result is one that will be
 * read as the whole of it. */
const long = detailOf(
  Array.from({ length: 500 }, (_, at) => `line ${at}`).join("\n")
)
check("a long result is cut", long.split("\n").length === 201, long.slice(-40))
check("and says how much it dropped", long.endsWith("… 300 more lines"))

const wide = detailOf("x".repeat(20_000))
check(
  "one enormous line is cut too",
  wide.startsWith("x".repeat(12_000)) &&
    wide.endsWith("… truncated at 12,000 characters")
)

check("empty stays empty", detailOf("") === "" && detailOf("   ") === "")

/**
 * The divider between days, decided per pair of blocks. A fold is dated by its
 * first line, and a block with no stamp on that line never earns one — the
 * case being the transcript that spans the day `at` was added.
 */
section("the divider between days")
{
  const local = (day: number, hour: number) =>
    new Date(2026, 8, day, hour).toISOString()
  const NOW = new Date(2026, 8, 30, 15).getTime()
  const user = (id: string, at?: string): AssistantMessage => ({
    id,
    role: "user",
    text: id,
    ...(at ? { at } : {}),
  })
  const tool = (id: string, at?: string): AssistantMessage => ({
    id,
    role: "tool",
    name: "Read",
    summary: id,
    ...(at ? { at } : {}),
  })
  const line = (of: AssistantMessage) => ({
    kind: "line" as const,
    id: of.id,
    line: of,
  })
  const fold = (...lines: AssistantMessage[]) => ({
    kind: "activity" as const,
    id: `activity-${lines[0]!.id}`,
    lines,
    counts: countsOf(lines),
  })

  check(
    "two lines across midnight are divided, in the day's own words",
    dayDividerBetween(
      line(user("a", local(29, 23))),
      line(user("b", local(30, 1))),
      NOW
    ) === "Today"
  )
  check(
    "and two inside a day are not",
    dayDividerBetween(
      line(user("a", local(30, 1))),
      line(user("b", local(30, 14))),
      NOW
    ) === null
  )
  check(
    "a fold is dated by its first line",
    dayDividerBetween(
      line(user("a", local(28, 23))),
      fold(tool("t1", local(29, 1)), tool("t2", local(30, 1))),
      NOW
    ) === "Yesterday"
  )
  check(
    "a block with no stamp divides nothing",
    dayDividerBetween(line(user("a")), line(user("b", local(30, 1))), NOW) ===
      null &&
      dayDividerBetween(line(user("a", local(29, 1))), fold(tool("t")), NOW) ===
        null
  )
}

section("resultImages")
{
  const shot = [
    { type: "text", text: "Took a screenshot" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    },
  ]
  const images = resultImages(shot)
  check(
    "an image block is a picture",
    images.length === 1 &&
      images[0]?.mediaType === "image/png" &&
      images[0]?.data === "AAAA",
    images
  )
  check(
    "and the text is still the text",
    resultText(shot) === "Took a screenshot"
  )
  check("a string result has none", resultImages("just text").length === 0)
  check(
    "a URL source is not fetched",
    resultImages([
      { type: "image", source: { type: "url", url: "https://example.com" } },
    ]).length === 0
  )
  check(
    "nor is a type the API does not take",
    resultImages([
      {
        type: "image",
        source: { type: "base64", media_type: "image/tiff", data: "AAAA" },
      },
    ]).length === 0
  )
}

finish()

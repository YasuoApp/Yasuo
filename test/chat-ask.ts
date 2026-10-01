import type { WorktreeChatAsk } from "../src/shared/api"
import {
  asked,
  decided,
  isMcpTool,
  said,
  titleFor,
} from "../src/main/worktree-chat"
import { check, finish, section } from "./harness"

/**
 * The three pure halves of a turn stopping to ask.
 *
 * Worth a test each because all three sit between two things that cannot be
 * type-checked against each other: `asked` reads a tool input the CLI wrote,
 * `decided` writes one the SDK reads back, and `said` writes the line somebody
 * reads next week. A change to any of them fails silently — a card with no
 * options, a turn that waits for ever, a transcript that says nothing happened.
 */

section("reading an AskUserQuestion")

const oneQuestion = {
  questions: [
    {
      question: "How should I format the output?",
      header: "Format",
      options: [
        { label: "Summary", description: "Brief overview" },
        { label: "Detailed", description: "Full explanation" },
      ],
      multiSelect: false,
    },
  ],
}

check(
  "a well-formed call reads back whole",
  JSON.stringify(asked(oneQuestion)) ===
    JSON.stringify([
      {
        question: "How should I format the output?",
        header: "Format",
        options: [
          { label: "Summary", description: "Brief overview" },
          { label: "Detailed", description: "Full explanation" },
        ],
        multiSelect: false,
      },
    ])
)

check(
  // Which is how a permission request is told apart from a question: same
  // callback, and only one of the two has questions in it.
  "anything without questions is not one",
  asked({ command: "npm test" }) === null && asked({}) === null
)

check(
  "a question with no options is refused rather than drawn with nothing to click",
  asked({ questions: [{ question: "Which?", options: [] }] }) === null
)

check(
  "a missing header falls back to the question, so a card is never unlabelled",
  asked({
    questions: [{ question: "Which one?", options: [{ label: "A" }] }],
  })?.[0]?.header === "Which one?"
)

check(
  "an option with no description is kept — the label is the answer",
  asked({
    questions: [{ question: "Which one?", options: [{ label: "A" }] }],
  })?.[0]?.options[0]?.description === ""
)

check(
  "multiSelect is only true when it says so",
  asked(oneQuestion)?.[0]?.multiSelect === false &&
    asked({
      questions: [
        { question: "Which?", options: [{ label: "A" }], multiSelect: true },
      ],
    })?.[0]?.multiSelect === true
)

section("answering back to the SDK")

check(
  "an allow carries no input, so the call runs as the model asked",
  JSON.stringify(decided({ kind: "allow" })) ===
    JSON.stringify({ allow: true, remember: false })
)

check(
  "always allow asks for the rule to be remembered",
  decided({ kind: "allow", always: true }).allow === true &&
    (decided({ kind: "allow", always: true }) as { remember?: boolean })
      .remember === true
)

const denial = decided({ kind: "deny" })
check(
  // A bare "no" invites the same attempt again, which costs a turn.
  "a denial carries a message for the model to read",
  denial.allow === false &&
    "message" in denial &&
    denial.message.length > 0 &&
    denial.message.includes("declined")
)

const answered = decided({
  kind: "answers",
  answers: { "How should I format the output?": ["Summary"] },
})
check(
  "answers go back as an allow — the tool 'runs' with what was picked",
  answered.allow === true
)
check(
  "a single pick is one string rather than a one-element list",
  JSON.stringify(
    (answered as { input?: Record<string, unknown> }).input?.answers
  ) === JSON.stringify({ "How should I format the output?": "Summary" })
)
check(
  "several picks are joined, which is what a multi-select means",
  JSON.stringify(
    (
      decided({
        kind: "answers",
        answers: { "Which sections?": ["Introduction", "Conclusion"] },
      }) as { input?: Record<string, unknown> }
    ).input?.answers
  ) === JSON.stringify({ "Which sections?": "Introduction, Conclusion" })
)

section("the line it leaves in the conversation")

const toolAsk: WorktreeChatAsk = {
  id: "a1",
  chatId: "c1",
  kind: "tool",
  title: "Claude wants to run npm test",
  name: "Bash",
  summary: "npm test",
  always: true,
}

check(
  "an allow names what was allowed",
  said(toolAsk, { kind: "allow" }) === "Allowed Bash: npm test"
)

check(
  "always allow says so, since it changed more than this one call",
  said(toolAsk, { kind: "allow", always: true }) ===
    "Allowed Bash: npm test, and will not ask again"
)

check(
  // The flag is a convenience, and claiming it applied where there was no rule
  // to write would be the line lying about what happened.
  "always is not claimed on an ask that had no rule to remember",
  said({ ...toolAsk, always: false }, { kind: "allow", always: true }) ===
    "Allowed Bash: npm test"
)

check(
  "a refusal reads as one",
  said(toolAsk, { kind: "deny" }) === "Refused Bash: npm test"
)

check(
  "a tool with nothing to summarise is still named",
  said({ ...toolAsk, summary: "" }, { kind: "allow" }) === "Allowed Bash"
)

check(
  "a question records the choice under its short header",
  said(
    {
      id: "a2",
      chatId: "c1",
      kind: "questions",
      questions: [
        {
          question: "How should I format the output?",
          header: "Format",
          options: [{ label: "Summary", description: "" }],
          multiSelect: false,
        },
      ],
    },
    {
      kind: "answers",
      answers: { "How should I format the output?": ["Summary"] },
    }
  ) === "Format: Summary"
)

section("what the card says is being asked")

check(
  // The SDK documents a rendered title and does not send one for a plain SDK
  // run, so this is the sentence somebody actually reads.
  "Bash names the command",
  titleFor("Bash", { command: "npm test" }) === "Claude wants to run npm test"
)

check(
  "Write and Edit are different words for different things",
  titleFor("Write", { file_path: "a.ts" }) === "Claude wants to create a.ts" &&
    titleFor("Edit", { file_path: "a.ts" }) === "Claude wants to edit a.ts"
)

check(
  "a call with the argument missing still reads as a sentence",
  titleFor("Bash", {}) === "Claude wants to run a command" &&
    titleFor("Write", {}) === "Claude wants to create a file"
)

check(
  "a tool this app has never heard of is named rather than guessed at",
  titleFor("KillShell", { shell_id: "1" }) === "Claude wants to use KillShell"
)

check(
  // Otherwise the card is a paragraph, and the point of it is to be read at a
  // glance before deciding.
  "a long command is collapsed",
  titleFor("Bash", { command: "x".repeat(400) }).length < 160
)

section("what Edits asks about rather than refusing")

check(
  // Wire names, as the CLI normalises them — a connector's and a plugin's.
  "a connector's or a plugin's tool is an MCP tool",
  isMcpTool("mcp__claude_ai_Figma__get_screenshot") &&
    isMcpTool("mcp__plugin_context7_context7__query-docs")
)

check(
  // Edits leaves these out on purpose; asking about them would undo that.
  "a built-in is not, so Edits still refuses one it never listed",
  !isMcpTool("KillShell") && !isMcpTool("ExitPlanMode")
)

finish()

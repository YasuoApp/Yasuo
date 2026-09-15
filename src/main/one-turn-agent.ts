import { randomUUID } from "node:crypto"

import { proposalsIn, type LearningProposal } from "../shared/learnings"
import { startAgentSession } from "./claude-agent"
import { recentSubjects, stagedDiff } from "./git"

/**
 * The **second** `claude` this app spawns, and the only one that is not a
 * conversation: one read-only turn, opened for a question and closed on the
 * answer.
 *
 * **The rule it is measured against is worth restating.** `ipc.ts` says the old
 * "no second one" rule still refuses a feature that calls the CLI as a helper —
 * an AI filter, an import button — because a helper turn is a turn nobody asked
 * for. Neither turn here is one: each is asked for out loud by a button or a
 * menu item, and each answers in the place it was asked from, as text somebody
 * still has to press Commit on or as proposals somebody saves one by one.
 *
 * What separates these from a chat, and why they are not one:
 *
 * - **One turn, not a conversation.** The session is opened for the question and
 *   closed on the answer, so nothing is resumed, nothing is written down, and
 *   there is no id anybody could send a second message to.
 * - **Read-only**, and by the same means the chat's `Plan` and `Read only` modes
 *   are: a tool list applied in this process, no `Bash`.
 * - **Nothing can stop it to ask.** There is no card and nobody watching, so
 *   `onAsk` is absent and `deciding` refuses an unpermitted call with a sentence
 *   the model can read.
 *
 * Deliberately **not** a method on `WorktreeChats`: everything that class does is
 * about a conversation that persists — the transcript, the resume, the idle
 * reaper, the ask table — and none of it applies.
 *
 * There used to be two more turns here, `reviewReply` and `reviewChanges`: the
 * agent half of the review, deleted with it. What survives is the **comments**
 * somebody writes by hand — see `docs/design.md` § Comments.
 */

export type OneTurnResult =
  | { text: string }
  /** A sentence for the caller to draw in place of an answer. Never a throw:
   * the renderer has one path for "it did not work" rather than two. */
  | { error: string }

/**
 * One read-only turn, opened for a question and closed on the answer./**
 * One read-only turn, opened for a question and closed on the answer.
 *
 * The shape both of this file's turns are: a drafted commit message, and one
 * chat distilled. They differ in what they are told, what they may call and how
 * long they are given — everything else about running a `claude` once is here,
 * once.
 *
 * The assistant's text is collected across replies and joined, because a turn
 * that thinks out loud sends several: `thinking` lines are dropped, which is the
 * one thing that must not reach the answer.
 */
async function oneTurn(request: {
  cwd: string
  prompt: string
  system: string
  tools: string[]
  timeoutMs: number
  model?: string | null
  effort?: string | null
  configDir?: string | null
  disabledTools?: string[]
}): Promise<OneTurnResult> {
  const said: string[] = []

  return new Promise<OneTurnResult>((resolve) => {
    /** Settled once, whichever of the four ways below gets there first: the turn
     * ending, the process dying, the timeout, or a failure to start. */
    let done = false
    let session: { close: () => void } | null = null

    const finish = (result: OneTurnResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // The session is closed on the way out rather than left to the caller:
      // there is nothing to send a second message to, and a `claude` per
      // resident per question is what this whole shape exists to avoid.
      session?.close()
      resolve(result)
    }

    const timer = setTimeout(
      () =>
        finish({
          error: `Claude did not answer within ${Math.round(request.timeoutMs / 1000)}s.`,
        }),
      request.timeoutMs
    )
    // Nothing here is a reason for Electron to stay up at quitting time.
    timer.unref?.()

    void startAgentSession(
      {
        cwd: request.cwd,
        // A fresh id every time, never resumed and never written down: this
        // session has no past and will have no future.
        sessionId: randomUUID(),
        resume: false,
        // Settings › Helper turns' own three, the same aliases a chat's toolbar
        // hands over. Null still means "leave it alone".
        model: request.model ?? null,
        effort: request.effort ?? null,
        configDir: request.configDir ?? null,
        permits: (name) => request.tools.includes(name),
        disallowedTools: request.disabledTools ?? [],
        // The same one every chat uses, which is what keeps this turn inside the
        // same cached prefix rather than paying for a prompt of its own.
        permissionMode: "manual",
        appendSystemPrompt: request.system,
        // No `onAsk` on purpose — see the note at the top of this file.
      },
      {
        onMessage: (message) => {
          if (message.role === "assistant") said.push(message.text)
        },
        // Everything a chat draws and this has nowhere to put. Ignored rather
        // than left off the type, which does not allow it.
        onToolResult: () => {},
        onUsage: () => {},
        onContext: () => {},
        onWindow: () => {},
        onCompacting: () => {},
        onCompacted: () => {},
        onBusy: () => {},
        onAgents: () => {},
        onTurn: (error) => {
          const text = said.join("\n\n").trim()
          if (error) return finish({ error })
          finish(
            text ? { text } : { error: "Claude answered with nothing at all." }
          )
        },
        // Only reached before `onTurn` — a process that died mid-answer, or one
        // that never started. Afterwards `done` is already set and the close
        // this is reporting is the one `finish` asked for.
        onExit: (error) =>
          finish({ error: error ?? "Claude stopped before answering." }),
      },
      request.prompt
    ).then((opened) => {
      if (!opened) return
      // `startAgentSession` resolves on the CLI's first message, by which time
      // the turn may already be over — `finish` has closed nothing in that case,
      // so it is closed here instead.
      if (done) opened.close()
      else session = opened
    })
  })
}

/**
 * How long a drafted commit message is given.
 *
 * Shorter than the distilling turn's, because it is a different amount of work
 * and a different amount of patience: this one has somebody sitting in front of it
 * with the message box open, and a draft that has not arrived in a minute is one
 * they have already typed past.
 */
const DRAFT_TIMEOUT_MS = 60_000

/** How much of the staged patch goes over, because a message is written from
 * the shape of a change rather than from every line of it, and the `--stat`
 * takes over past this. */
const DRAFT_PATCH_LIMIT = 120_000

/** How many previous subjects the draft is shown — enough to read a convention
 * off, few enough that they do not become the bulk of the prompt. */
const DRAFT_LOG = 10

/**
 * What the draft is allowed to call.
 *
 * Reading only, and no web: the answer is in the diff and in the repository
 * around it. `WebSearch` in a turn that owes one line is a minute spent on
 * something nobody asked about.
 */
const DRAFT_TOOLS = ["ToolSearch", "Read", "Glob", "Grep"]

/**
 * What the drafting turn is told.
 *
 * The output shape is again the whole difficulty, and it is stricter here than
 * anywhere else in this file: whatever comes back is put **in a text box the
 * user is about to commit**, so a preamble, a code fence or an offer to revise
 * is not a flaw in the answer, it is text somebody has to delete by hand before
 * they can press the button. So: the message and nothing else.
 *
 * It is told to follow the log it is shown rather than any convention named
 * here. This app has no business teaching somebody's repository how to write its
 * own history, and the ten subjects above the diff say more about a house style
 * than a rule ever does.
 */
const DRAFT_PROMPT = [
  "You write the commit message for a change that is already staged. You are not reviewing it, not improving it and not commenting on it.",
  "Answer with the message itself and nothing else — no preamble, no code fence, no sign-off, no offer to revise. What you return goes straight into the message box.",
  "A subject line under 72 characters, in the style of the recent subjects you are shown. Where the change needs it, a blank line and then a short body saying why; where it does not, the subject alone.",
  "Describe what the change does, not which files moved. If the staged diff is several unrelated things, say the largest one plainly rather than inventing a theme that covers them all.",
  "You may read the files around the change. You cannot edit anything, and there is nobody to ask.",
].join("\n")

export type DraftCommitRequest = {
  /** The checkout being committed — the directory the turn reads in. */
  cwd: string
  model?: string | null
  effort?: string | null
  configDir?: string | null
  disabledTools?: string[]
}

/**
 * A commit message for what is staged, written by the read-only `claude`.
 *
 * **Why this is not the helper turn the "no second CLI" rule refuses**: it is a
 * button, pressed by the person who is about to commit, and its whole output is
 * text handed to them in an editable box. Nothing happens on its way past —
 * a draft nobody presses costs nothing and changes nothing, and a draft that is
 * wrong is a sentence somebody rewrites before pressing Commit. That is the same
 * test `distillLearnings` passes: asked for out loud, answered in the place it
 * was asked from.
 *
 * The patch is gathered here rather than left to the turn to fetch: a read-only
 * tool list has no `git`, and this process already knows how to ask
 * (`main/git.ts`).
 */
export async function draftCommitMessage(
  request: DraftCommitRequest
): Promise<OneTurnResult> {
  const [{ stat, patch }, subjects] = await Promise.all([
    stagedDiff(request.cwd),
    recentSubjects(request.cwd, DRAFT_LOG),
  ])

  if (!stat.trim() && !patch.trim()) {
    return { error: "Nothing is staged to write a message about." }
  }

  const prompt = [
    "Write the commit message for this staged change.",
    "",
    "What it touches:",
    "```",
    stat.trim(),
    "```",
    "",
    // Past the cap the `--stat` above is what the message is written from, said
    // out loud so the turn reads files rather than describing a patch it never
    // saw.
    patch.length > DRAFT_PATCH_LIMIT
      ? "The patch itself is too large to include. Read the files above where you need to."
      : ["```diff", patch.trim(), "```"].join("\n"),
    ...(subjects.length > 0
      ? [
          "",
          "The last few commits here, newest first — follow their style:",
          ...subjects.map((subject) => `- ${subject}`),
        ]
      : []),
  ].join("\n")

  return oneTurn({
    cwd: request.cwd,
    prompt,
    system: DRAFT_PROMPT,
    tools: DRAFT_TOOLS,
    timeoutMs: DRAFT_TIMEOUT_MS,
    model: request.model,
    effort: request.effort,
    configDir: request.configDir,
    disabledTools: request.disabledTools,
  })
}

/**
 * How long a distilling turn is given. Five times the draft's, because it
 * reads a whole conversation and then the repository's existing skills and
 * `CLAUDE.md` to avoid proposing what is already written down.
 */
const DISTILL_TIMEOUT_MS = 300_000

/**
 * How much of the transcript goes over, and it is the **tail** that is kept:
 * a long chat's early turns are the attempts, and the corrections that
 * superseded them — the part worth learning from — come later. Said out loud
 * in the prompt when it happens, so the turn knows it is reading an excerpt.
 */
const DISTILL_TRANSCRIPT_LIMIT = 160_000

/**
 * The draft's list, plus `Glob` and `Grep`: the turn has to find what
 * `.claude/skills/` and `CLAUDE.md` already say before proposing to say it
 * again. No web — the learnings are in the conversation, not on a page.
 */
const DISTILL_TOOLS = ["ToolSearch", "Read", "Glob", "Grep"]

/**
 * What the distilling turn is told.
 *
 * The output shape is again the whole difficulty, and the second difficulty is
 * restraint. A model asked what a conversation taught will find a lesson in
 * every turn of it; what is wanted is the two or three things the *next* chat
 * in this project would otherwise have to rediscover — so the number is said
 * out loud, and so is the test ("had to be found out", not "was mentioned").
 * The split between the two kinds is said in terms of rent: a memory line is
 * read at the top of every turn forever, a skill is read when its description
 * matches, so anything longer than a sentence or two goes to a skill.
 */
const DISTILL_PROMPT = [
  "You are reading one finished conversation between a user and a coding agent, in the project the conversation was about. Your job is to distill what it taught — the facts, conventions and procedures the next conversation in this project would otherwise have to rediscover.",
  "",
  'Answer with a single fenced ```json block and nothing else: an array of proposals, each `{ "kind", "name", "description", "body" }`.',
  "",
  '- `kind` is `"skill"` or `"memory"`. A **memory** is one or two sentences of standing fact — a constraint, a convention, a decision and its reason — that becomes a bullet in this project\'s `CLAUDE.md`, read at the start of every future conversation; keep it short, its cost is paid forever. A **skill** is a procedure — steps that were worked out and would be followed again — and becomes `.claude/skills/<name>/SKILL.md`, loaded only when relevant; this is where anything longer than two sentences belongs.',
  "- `name` is a short kebab-case slug: a skill's directory name, a memory's label.",
  "- `description` is one line saying when the learning applies — for a skill it is what the agent matches against before loading it.",
  "- `body` is the learning itself, markdown. For a memory: the sentence or two, stating the why. For a skill: the procedure, concrete enough to follow without this conversation open.",
  "",
  "Before proposing anything, read what is already written down: this project's `CLAUDE.md`, and the skills under `.claude/skills/` if there are any. Propose nothing that restates them, and nothing derivable from the code itself — a learning is what had to be found out the hard way: a command that only works a certain way, a constraint that cost a debugging session, an approach that was tried and rejected and why.",
  "",
  "Fewer, better. Two or three proposals is a good answer; most conversations teach nothing worth keeping, and for those return an empty array and say nothing else. Never propose a learning about the conversation itself, the user's mood, or the one-off task that was done.",
  "",
  "This turn is read-only on purpose: the editing tools and the shell are unavailable, so do not try them. Nothing you propose is written anywhere — each proposal is shown to the user, who saves or discards it.",
].join("\n")

export type DistillRequest = {
  /** The project the chat belongs to — the directory the turn reads in. */
  cwd: string
  /** The chat's lines as plain text — `transcriptOf` in `shared/learnings.ts`
   * builds it, main hands it over. Gathered here rather than left to the turn
   * for the reason the draft gathers its patch: a chat's file lives under
   * `~/.yasuo`, which is nowhere a turn in the project's directory reads. */
  transcript: string
  model?: string | null
  effort?: string | null
  configDir?: string | null
  disabledTools?: string[]
}

export type DistillResult =
  { proposals: LearningProposal[] } | { error: string }

/**
 * What one conversation taught, proposed — never written.
 *
 * **Why this is not the helper turn the "no second CLI" rule refuses**: it is a
 * menu item on the chat it reads, pressed by the person who had the
 * conversation, and its whole output is a list of proposals in a dialog with a
 * Save button on each. Nothing happens on its way past — a proposal nobody
 * saves costs nothing and changes nothing. That is the same test
 * `draftCommitMessage` passes: asked for out loud, answered in the place it was
 * asked from, acted on by a person.
 */
export async function distillLearnings(
  request: DistillRequest
): Promise<DistillResult> {
  const transcript = request.transcript.trim()
  if (!transcript) {
    return { error: "This chat has nothing in it to learn from." }
  }

  const clipped = transcript.length > DISTILL_TRANSCRIPT_LIMIT
  const shown = clipped
    ? transcript.slice(-DISTILL_TRANSCRIPT_LIMIT)
    : transcript

  const prompt = [
    "Distill what this conversation taught about the project in this directory.",
    "",
    ...(clipped
      ? [
          "The conversation is long, so this is its latter part — read it as an excerpt.",
          "",
        ]
      : []),
    "```",
    shown,
    "```",
  ].join("\n")

  const answer = await oneTurn({
    cwd: request.cwd,
    prompt,
    system: DISTILL_PROMPT,
    tools: DISTILL_TOOLS,
    timeoutMs: DISTILL_TIMEOUT_MS,
    model: request.model,
    effort: request.effort,
    configDir: request.configDir,
    disabledTools: request.disabledTools,
  })
  if ("error" in answer) return answer

  const proposals = proposalsIn(answer.text)
  if (proposals === null) {
    return { error: "Claude answered, but not with proposals this could read." }
  }
  return { proposals }
}

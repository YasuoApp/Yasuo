import { randomUUID } from "node:crypto"

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
 * for. The turn here is not one: it is asked for out loud by a button, and it
 * answers in the place it was asked from, as text somebody still has to press
 * Commit on.
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
 * There used to be three more turns here: `reviewReply` and `reviewChanges`, the
 * agent half of the review (`docs/design.md` § Comments, removed), and
 * `distillLearnings`, which proposed skills and `CLAUDE.md` bullets out of a
 * chat (§ Distilling learnings, removed).
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
 * Split from `draftCommitMessage` so that what is particular to a draft — what
 * it is told, what it may call and how long it is given — is apart from what
 * running a `claude` once takes.
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
 * A minute, because this one has somebody sitting in front of it with the
 * message box open, and a draft that has not arrived in a minute is one
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
 * wrong is a sentence somebody rewrites before pressing Commit: asked for out
 * loud, answered in the place it was asked from.
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

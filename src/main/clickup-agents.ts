import { randomUUID } from "node:crypto"

import type { ClickupProposal, ClickupWatch } from "../shared/api"
import { agentOf, type ClickupAgent } from "../shared/clickup-agents"
import { changes as gitChanges } from "./git"
import { readOnlyTurn } from "./one-turn-agent"
import { addWorktree, branchFor, worktreeDir } from "./worktrees"

/**
 * What pressing `Run` on a proposal actually does.
 *
 * One file for the three agents because they differ in two things only — what
 * they are told and whether the answer is a turn or a conversation — and every
 * other part of the errand is the same: find the project, refuse in a sentence
 * if there is not one, and patch the proposal with what came of it.
 *
 * **Nothing in here is reached by the poll.** `clickup-watch.ts` writes
 * proposals; this runs one, and only `IPC.runClickupProposal` calls it. That
 * separation is the feature's whole safety argument and is worth keeping
 * physically: there is no path from a timer to this file.
 *
 * Free of `electron` — the store's two questions are handed in — so the parts
 * worth testing stay testable and this can be read without the window.
 */

export type RunDeps = {
  /** The absolute path of a workspace folder, or null if it has gone. */
  folderDir: (id: string) => Promise<string | null>
  /** Where this app keeps its own files — the checkouts go under it. */
  workspaceDir: string
  /** Records a checkout as a project, answering with its new folder id. It is
   * an ordinary folder from that moment on: the Explorer lists it, the Changes
   * tab diffs it, a chat runs in it. */
  addFolder: (input: { path: string; name: string }) => Promise<string>
  /** Opens a chat in a project and sends it its first message. The chat is
   * saved rather than held unsaved, since this proposal records its id — the
   * bargain `ChatSeed`'s own doc describes for the board's `startChat`. */
  startChat: (input: {
    folderId: string
    title: string
    prompt: string
  }) => Promise<string>
  /** The switched-off MCP tools, as every turn in this app is handed them. */
  disabledTools: () => Promise<string[]>
}

/**
 * Settings › Helper turns, resolved by the renderer and passed in.
 *
 * Handed down rather than read here, which is what `draftCommitMessage` and
 * `distillLearnings` already do: the three live in the renderer's settings
 * store, and a second reader in main would be a second answer.
 */
export type TurnOptions = {
  model: string | null
  effort: string | null
  configDir: string | null
}

export type RunOutcome =
  { error: string } | { patch: Partial<ClickupProposal>; chatId?: string }

/**
 * Runs one proposal and answers with what to patch onto it.
 *
 * The patch rather than the whole record, because the caller is what owns the
 * file and has to re-read it anyway: a run takes a minute, and `add`, `remove`
 * and a poll are all handlers that can land inside one.
 */
export async function runProposal(
  watch: ClickupWatch,
  proposal: ClickupProposal,
  deps: RunDeps,
  turn: TurnOptions
): Promise<RunOutcome> {
  const agent = agentOf(proposal.agent)
  if (!agent) return { error: "This build does not know that agent." }

  // Every agent needs somewhere to run. Said out loud rather than guessed: the
  // nearest readable directory is precisely the wrong place to run a turn, and
  // for the engineer it is the wrong place to write one.
  if (agent.needsProject && !watch.folderId) {
    return {
      error: `Pick a project for this task first — ${agent.name} has to run somewhere.`,
    }
  }

  const repo = watch.folderId ? await deps.folderDir(watch.folderId) : null
  if (agent.needsProject && !repo) {
    return { error: "That project is no longer in the workspace." }
  }

  return agent.kind === "chat"
    ? engineer(watch, proposal, agent, repo!, deps)
    : oneTurnAgent(watch, proposal, agent, repo!, deps, turn)
}

/**
 * The Software Engineer: a checkout, a branch and a chat holding the brief.
 *
 * It stops at the **first message**, and that is deliberate rather than
 * unfinished. What this produces is a conversation somebody can watch, steer
 * and stop — the app's own chat, in the app's own tab, with the toolbar and the
 * permission mode it always has. An agent that ran to completion behind a
 * progress bar would be the same turn with the one thing that makes it safe
 * taken away.
 */
async function engineer(
  watch: ClickupWatch,
  proposal: ClickupProposal,
  agent: ClickupAgent,
  repo: string,
  deps: RunDeps
): Promise<RunOutcome> {
  const task = watch.seen?.name || watch.id
  const branch = branchFor(watch.id, task)
  const dir = worktreeDir(deps.workspaceDir, watch.folderId!, watch.id)

  const made = await addWorktree({ repo, dir, branch })
  if ("error" in made) return { error: made.error }

  let folderId: string
  try {
    // Named for the task rather than for the directory, because this row is
    // going to sit in the sidebar next to the project it came from and
    // `86eutavc5` says nothing.
    folderId = await deps.addFolder({ path: made.dir, name: `${task} (agent)` })
  } catch (error) {
    // The checkout is left where it is. It is a branch with a directory, which
    // is a thing somebody can open a terminal in — throwing it away because
    // this app could not file it would destroy work to tidy up a record.
    return { error: error instanceof Error ? error.message : String(error) }
  }

  const chatId = await deps.startChat({
    folderId,
    title: task,
    prompt: brief(watch, proposal),
  })

  return {
    chatId,
    patch: {
      status: "running",
      chatId,
      worktreeFolderId: folderId,
      branch,
    },
  }
}

/** What the engineer's chat opens with. The task, what moved, and the two
 * standing instructions that keep the run reviewable: work on this branch, and
 * do not commit — the branch is the deliverable, and a commit nobody read is
 * the thing this whole shape is arranged to avoid. */
function brief(watch: ClickupWatch, proposal: ClickupProposal): string {
  return [
    `You are picking up a ClickUp task in a fresh \`git worktree\` of this project, on the branch \`${branchFor(watch.id, watch.seen?.name || watch.id)}\`.`,
    "",
    `**${watch.seen?.name || watch.id}** — ${watch.url}`,
    ...(watch.seen?.status ? [`Status: ${watch.seen.status}`] : []),
    "",
    "What it asks for:",
    "",
    "```",
    (watch.seen?.description || "(the task has no description)").slice(0, 8000),
    "```",
    "",
    "What just changed, newest first:",
    ...proposal.because.map((line) => `- ${line}`),
    "",
    "Read the repository before changing anything, and work only on this branch.",
    // Said out loud because the checkout is a throwaway directory and the
    // branch is not: a commit here is fine, a push is somebody else's call.
    "Do not push. Leave the work as commits or as a dirty tree — whoever pressed Run is going to read the diff.",
  ].join("\n")
}

/**
 * The Watcher and the Reviewer: one read-only turn, answering into the card.
 *
 * The same shape `draftCommitMessage` and `distillLearnings` are, and reached
 * through the same file, so there is one place in this app that opens a turn
 * which is not a conversation.
 */
async function oneTurnAgent(
  watch: ClickupWatch,
  proposal: ClickupProposal,
  agent: ClickupAgent,
  repo: string,
  deps: RunDeps,
  turn: TurnOptions
): Promise<RunOutcome> {
  const prompt =
    agent.id === "reviewer"
      ? await reviewPrompt(watch, proposal, repo)
      : watchPrompt(watch, proposal)

  const answer = await readOnlyTurn({
    cwd: repo,
    prompt,
    system: SYSTEMS[agent.id] ?? WATCHER_SYSTEM,
    ...turn,
    disabledTools: await deps.disabledTools(),
  })

  if ("error" in answer) {
    return { patch: { status: "failed", error: answer.error } }
  }
  return { patch: { status: "done", result: answer.text } }
}

const WATCHER_SYSTEM = [
  "You are reading a change to a ClickUp task on behalf of somebody who works in this repository.",
  "Answer in at most five sentences: what actually changed, and what it means for this codebase.",
  "Name the files or areas it touches where you can tell. Say plainly when a change means nothing for the code.",
  "Do not restate the task. Do not offer to do the work.",
].join(" ")

const SYSTEMS: Record<string, string> = {
  watcher: WATCHER_SYSTEM,
  reviewer: [
    "You are checking whether the work in progress in this repository still matches what a ClickUp task asks for.",
    "Answer in at most eight sentences, as a short list of where the two disagree.",
    "Read the files the diff touches before judging them. Say plainly when they agree.",
    "Do not write code and do not propose a patch.",
  ].join(" "),
}

function watchPrompt(watch: ClickupWatch, proposal: ClickupProposal): string {
  return [
    `Task: **${watch.seen?.name || watch.id}** — ${watch.url}`,
    "",
    "What just changed, newest first:",
    ...proposal.because.map((line) => `- ${line}`),
    "",
    "What the task says now:",
    "",
    "```",
    (watch.seen?.description || "(no description)").slice(0, 8000),
    "```",
  ].join("\n")
}

/** The reviewer's own prompt, which needs the repository's current diff — the
 * same `changes()` the `Changes` tab is drawn from, so the two are looking at
 * one list rather than two that agree most of the time. */
async function reviewPrompt(
  watch: ClickupWatch,
  proposal: ClickupProposal,
  repo: string
): Promise<string> {
  let touched: string[] = []
  try {
    const status = await gitChanges(repo)
    touched = status.map((entry) => entry.path)
  } catch {
    // A project that is not a repository, or a git that refused. The turn can
    // still read the tree; it simply has no list to start from.
    touched = []
  }

  return [
    `Task: **${watch.seen?.name || watch.id}** — ${watch.url}`,
    "",
    "What the task asks for now:",
    "",
    "```",
    (watch.seen?.description || "(no description)").slice(0, 8000),
    "```",
    "",
    "What just changed about it:",
    ...proposal.because.map((line) => `- ${line}`),
    "",
    ...(touched.length > 0
      ? [
          "Files this project has changed and not committed:",
          ...touched.slice(0, 200).map((path) => `- ${path}`),
        ]
      : [
          "This project has no uncommitted changes; read the code as it stands.",
        ]),
  ].join("\n")
}

/** A proposal id. Minted here so the one import of `node:crypto` in this
 * feature is on the side that writes records rather than in the shared table,
 * which `foldProposals` keeps pure by taking this as an argument. */
export const newProposalId = (): string => randomUUID()

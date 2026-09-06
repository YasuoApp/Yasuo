import type { ClickupChange, ClickupChangeKind, ClickupProposal } from "./api"

/**
 * The agents a watched ClickUp task can be assigned to, and what a change has
 * to be before one of them offers to do something about it.
 *
 * **What this is not.** It is not the app deciding to spend a turn. Every agent
 * here answers a change with a **proposal** — a card in the pane and an OS
 * banner saying "the Software Engineer would take this" — and nothing runs
 * until somebody presses `Run`. That is the whole of how this feature stays on
 * the right side of the rule `one-turn-agent.ts` states: a turn nobody asked
 * for is refused, and pressing Run **is** the asking. A version that ran off
 * the two-minute timer was the obvious design and is the one deliberately not
 * built; `docs/design.md` § Agents on a task has the argument.
 *
 * Shared rather than main's, because both sides need the same table: main reads
 * `triggers` while folding a poll, and the renderer draws `name` and `blurb` in
 * the picker. A registry rather than a union of `if`s so that adding a fourth
 * agent is an entry here and a case in `main/clickup-agents.ts`.
 */

export type ClickupAgentId = "engineer" | "watcher" | "reviewer"

export type ClickupAgent = {
  id: ClickupAgentId
  name: string
  /** One line in the picker: what assigning it will get you. */
  blurb: string
  /**
   * What running it costs.
   *
   * `one-turn` is the read-only shape `one-turn-agent.ts` already has — opened
   * for a question, closed on the answer, no transcript and nothing to send a
   * second message to. `chat` is a real conversation, in a tab, that writes
   * files; only the engineer is one, and it is the only agent that gets a
   * checkout of its own.
   */
  kind: "chat" | "one-turn"
  /** Whether it needs a project to run in. All three do today — a turn has to
   * have a directory — and the field is here so the pane can say *why* a task
   * with no project cannot run one. */
  needsProject: boolean
  /** Whether a run gets its own `git worktree`. Only the agent that writes. */
  worktree: boolean
  /**
   * Which kinds of change make it offer.
   *
   * A change with no `kind` — a history written before the field existed —
   * triggers nothing, which is the honest answer rather than a guess: nothing
   * on that record says what moved.
   */
  triggers: ClickupChangeKind[]
}

/** What somebody writing requirements actually changes: the description, and
 * the comment where they say what they meant. A status moving is somebody
 * moving a card, not a new instruction. */
const REQUIREMENT: ClickupChangeKind[] = [
  "description",
  "comment",
  "comment-edited",
]

export const CLICKUP_AGENTS: ClickupAgent[] = [
  {
    id: "engineer",
    name: "Software Engineer",
    blurb:
      "Offers to build the change: a git worktree of its own, a branch for the task, and a chat already holding the brief.",
    kind: "chat",
    needsProject: true,
    // The one agent that writes, and so the one that gets a checkout of its
    // own — see `main/worktrees.ts` for why that is worth reviving.
    worktree: true,
    triggers: REQUIREMENT,
  },
  {
    id: "watcher",
    name: "Watcher",
    blurb:
      "Reads what moved and answers with what it actually means for this repository. Read-only, one turn, written into the history.",
    kind: "one-turn",
    needsProject: true,
    worktree: false,
    // Everything, including a status move: "it went back to In review" is
    // exactly the kind of thing worth a sentence about what it implies.
    triggers: [
      "status",
      "name",
      "assignees",
      "priority",
      "due",
      "description",
      "comment",
      "comment-edited",
    ],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    blurb:
      "Reads the project's current diff against what the task now asks for, and answers with where the two disagree. Read-only.",
    kind: "one-turn",
    needsProject: true,
    worktree: false,
    // Only a moved requirement: reviewing the same diff against the same
    // description every time somebody changes an assignee is a turn spent on
    // nothing.
    triggers: REQUIREMENT,
  },
]

export function agentOf(id: string): ClickupAgent | null {
  return CLICKUP_AGENTS.find((agent) => agent.id === id) ?? null
}

/** The ids a record holds that this build still knows about — a watch assigned
 * to an agent a newer version added reads as not assigned to it, rather than as
 * a crash. */
export function agentsIn(watch: { agents?: string[] }): ClickupAgentId[] {
  return (watch.agents ?? [])
    .map((id) => agentOf(id)?.id)
    .filter((id): id is ClickupAgentId => id !== undefined)
}

/** Every proposal on a record, defaulted — the field postdates the file. */
export function proposalsIn(watch: {
  proposals?: ClickupProposal[]
}): ClickupProposal[] {
  return watch.proposals ?? []
}

/** The ones still waiting on somebody: what the pane's card list draws and what
 * the tab's count counts. */
export function waitingIn(watch: { proposals?: ClickupProposal[] }): number {
  return proposalsIn(watch).filter((one) => one.status === "pending").length
}

/**
 * How many proposals one task keeps.
 *
 * Small on purpose, and much smaller than `CLICKUP_HISTORY`: a proposal is a
 * thing to act on rather than a log to read back, and one that has been sitting
 * unanswered for twenty changes is one nobody was ever going to press.
 */
export const CLICKUP_PROPOSALS = 20

/**
 * One poll's changes folded into a task's proposals.
 *
 * Pure, and tested in `test/clickup-agents.ts`, because every way it can be
 * wrong is expensive in the same two directions. Offer too eagerly and the pane
 * fills with cards nobody presses, which is how somebody learns to ignore all
 * of them; offer too rarely and the feature does nothing at all.
 *
 * **A pending proposal is merged into, not duplicated.** Three edits to a
 * description in an afternoon is one offer carrying three reasons, not three
 * offers — otherwise a task somebody is actively rewriting would bury the pane
 * in identical cards. A proposal that has already been **run** is finished, and
 * the next change makes a new one: that is a second piece of work, not the same
 * one again.
 */
export function foldProposals(input: {
  /** What the task already has. */
  proposals: ClickupProposal[]
  /** Who it is assigned to. */
  agents: ClickupAgentId[]
  /** What this poll found. */
  changes: ClickupChange[]
  now: string
  /** Ids from the caller, so this stays pure. */
  id: () => string
}): { proposals: ClickupProposal[]; opened: ClickupProposal[] } {
  const { proposals, agents, changes, now, id } = input
  if (agents.length === 0 || changes.length === 0) {
    return { proposals, opened: [] }
  }

  let next = proposals
  const opened: ClickupProposal[] = []

  for (const agentId of agents) {
    const agent = agentOf(agentId)
    if (!agent) continue

    // A change with no `kind` says nothing about what moved, so it triggers
    // nothing rather than everything.
    const because = changes
      .filter((change) => change.kind && agent.triggers.includes(change.kind))
      .map((change) => change.text)
    if (because.length === 0) continue

    const waiting = next.find(
      (one) => one.agent === agentId && one.status === "pending"
    )
    if (waiting) {
      next = next.map((one) =>
        one === waiting
          ? { ...one, at: now, because: [...because, ...one.because] }
          : one
      )
      continue
    }

    const proposal: ClickupProposal = {
      id: id(),
      agent: agentId,
      at: now,
      because,
      status: "pending",
    }
    opened.push(proposal)
    next = [proposal, ...next]
  }

  return { proposals: next.slice(0, CLICKUP_PROPOSALS), opened }
}

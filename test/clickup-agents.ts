import type { ClickupChange, ClickupProposal } from "../src/shared/api"
import {
  agentOf,
  agentsIn,
  CLICKUP_AGENTS,
  CLICKUP_PROPOSALS,
  foldProposals,
  waitingIn,
} from "../src/shared/clickup-agents"
import { branchFor, worktreeSlug } from "../src/main/worktrees"
import { check, finish, section } from "./harness"

/**
 * Agents assigned to a watched ClickUp task: what makes one offer, and what a
 * run is named.
 *
 * The two failures worth guarding are opposite and both quiet. Offer too
 * eagerly and the pane fills with cards nobody presses, which is how somebody
 * learns to ignore every one of them; offer too rarely and a feature somebody
 * assigned three agents to does nothing at all and says nothing about why.
 *
 * `foldProposals` is pure for that reason and takes its ids as an argument, so
 * this runs under plain `bun` with no Electron, no clock and no randomness.
 */

const NOW = "2026-09-05T10:00:00.000Z"

function change(over: Partial<ClickupChange> = {}): ClickupChange {
  return { text: "Status → done", at: NOW, kind: "status", ...over }
}

/** Ids that are readable in a failure rather than uuids. */
function counter(): () => string {
  let at = 0
  return () => `p${(at += 1)}`
}

section("who offers, and when")

// The whole point of the shape: assigned to nobody, nothing is ever offered,
// however much moves.
check(
  "a task with no agents never offers",
  foldProposals({
    proposals: [],
    agents: [],
    changes: [change(), change({ kind: "description" })],
    now: NOW,
    id: counter(),
  }).opened.length === 0
)

check(
  "a poll that found nothing offers nothing",
  foldProposals({
    proposals: [],
    agents: ["engineer", "watcher", "reviewer"],
    changes: [],
    now: NOW,
    id: counter(),
  }).opened.length === 0
)

{
  // A status moving is somebody moving a card, not a new instruction — so the
  // two agents that read requirements stay quiet and the one that reads
  // everything speaks.
  const { opened } = foldProposals({
    proposals: [],
    agents: ["engineer", "watcher", "reviewer"],
    changes: [change({ kind: "status" })],
    now: NOW,
    id: counter(),
  })
  check("a status move is the watcher's alone", opened.length === 1)
  check("and it is the watcher", opened[0]?.agent === "watcher")
}

{
  // The case the feature was asked for: the requirement moved.
  const { opened } = foldProposals({
    proposals: [],
    agents: ["engineer", "watcher", "reviewer"],
    changes: [change({ kind: "description", text: "Description edited" })],
    now: NOW,
    id: counter(),
  })
  check("a moved requirement wakes all three", opened.length === 3)
  check(
    "the engineer among them",
    opened.some((one) => one.agent === "engineer")
  )
  check(
    "and each starts pending",
    opened.every((one) => one.status === "pending")
  )
  check("carrying why", opened[0]?.because.join() === "Description edited")
}

// A change written before `kind` existed says nothing about what moved, so it
// must trigger nothing rather than everything.
check(
  "a change with no kind wakes nobody",
  foldProposals({
    proposals: [],
    agents: ["engineer", "watcher", "reviewer"],
    changes: [{ text: "Something happened", at: NOW }],
    now: NOW,
    id: counter(),
  }).opened.length === 0
)

// An id this build does not know — a record written by a newer version — is
// dropped rather than crashing the fold.
check(
  "an agent this build never heard of is skipped",
  foldProposals({
    proposals: [],
    agents: ["designer" as never],
    changes: [change({ kind: "description" })],
    now: NOW,
    id: counter(),
  }).opened.length === 0
)

section("one offer per agent, however much moves")

{
  // Somebody rewriting a description all afternoon is one offer with three
  // reasons on it, not three identical cards.
  const first = foldProposals({
    proposals: [],
    agents: ["engineer"],
    changes: [change({ kind: "description", text: "Description edited" })],
    now: NOW,
    id: counter(),
  })
  const second = foldProposals({
    proposals: first.proposals,
    agents: ["engineer"],
    changes: [change({ kind: "comment", text: "Tanaka: and the mobile one" })],
    now: "2026-09-05T10:30:00.000Z",
    id: counter(),
  })

  check("the second change opens nothing new", second.opened.length === 0)
  check("there is still one card", second.proposals.length === 1)
  check("carrying both reasons", second.proposals[0]?.because.length === 2)
  check(
    "newest first",
    second.proposals[0]?.because[0] === "Tanaka: and the mobile one"
  )
  // Moved, so a card that keeps collecting reasons reads as recent rather than
  // as something from this morning.
  check(
    "and stamped again",
    second.proposals[0]?.at === "2026-09-05T10:30:00.000Z"
  )
}

{
  // A card that has been **run** is finished work. The next change is a second
  // piece of work, not the same one again — which is the difference between
  // this and the merge above.
  const done: ClickupProposal = {
    id: "p0",
    agent: "engineer",
    at: NOW,
    because: ["Description edited"],
    status: "done",
  }
  const { opened } = foldProposals({
    proposals: [done],
    agents: ["engineer"],
    changes: [change({ kind: "description" })],
    now: NOW,
    id: counter(),
  })
  check("a change after a finished run is a new offer", opened.length === 1)
}

{
  // Dismissed means "not this one" and must not come back as a fresh card on
  // the next poll of the same conversation.
  const dismissed: ClickupProposal = {
    id: "p0",
    agent: "reviewer",
    at: NOW,
    because: ["Description edited"],
    status: "dismissed",
  }
  const { opened } = foldProposals({
    proposals: [dismissed],
    agents: ["reviewer"],
    changes: [change({ kind: "description" })],
    now: NOW,
    id: counter(),
  })
  // It *is* a new offer: dismissing said no to the change that had happened by
  // then, not to every change after it. Kept as a check because the opposite
  // reading is the tempting one and would mean an agent silently stopping.
  check("dismissing does not switch the agent off", opened.length === 1)
}

{
  const many: ClickupProposal[] = Array.from(
    { length: CLICKUP_PROPOSALS + 5 },
    (_unused, at) => ({
      id: `old${at}`,
      agent: "watcher" as const,
      at: NOW,
      because: ["old"],
      status: "done" as const,
    })
  )
  const { proposals } = foldProposals({
    proposals: many,
    agents: ["watcher"],
    changes: [change()],
    now: NOW,
    id: counter(),
  })
  check("the pile is capped", proposals.length === CLICKUP_PROPOSALS)
  check("keeping the newest", proposals[0]?.id === "p1")
}

section("what is waiting on somebody")

check(
  "waiting counts the pending only",
  waitingIn({
    proposals: [
      { id: "a", agent: "watcher", at: NOW, because: [], status: "pending" },
      { id: "b", agent: "engineer", at: NOW, because: [], status: "running" },
      { id: "c", agent: "reviewer", at: NOW, because: [], status: "done" },
    ],
  }) === 1
)
// The field postdates the record, so every reader defaults it — the failure
// `fold` was pulled out of.
check("a record with no proposals is not a crash", waitingIn({}) === 0)
check("nor is one with no agents", agentsIn({}).length === 0)

section("what a run is called")

// The id leads because it is the only part that is unique and stable: two
// tasks called "Fix login" are one branch name and one collision.
check(
  "a branch is the task and its name",
  branchFor("86eutavc5", "Add SSO login") === "clickup/86eutavc5-add-sso-login"
)
check(
  "punctuation git would refuse is gone",
  branchFor("86e", "Fix: login/logout (v2)") ===
    "clickup/86e-fix-login-logout-v2"
)
// A task named entirely in Japanese slugs to nothing, which is exactly why the
// id is in front rather than beside.
check(
  "a name with no ASCII still names a branch",
  branchFor("86e", "ログイン画面の修正") === "clickup/86e"
)
check("so does an empty name", branchFor("86e", "") === "clickup/86e")
check(
  "and a task with neither still has one",
  branchFor("", "") === "clickup/task"
)
// Long names are cut rather than refused: git has a path limit and a branch
// list is read by people.
check(
  "a long name is cut",
  branchFor("86e", "a".repeat(80)).length <= "clickup/86e-".length + 32
)
// No trailing dash after the cut, which git refuses outright in a ref
// component and which reads as a typo everywhere else.
check(
  "and never ends on a dash",
  worktreeSlug("abcdefghij klmnopqrst uvwxyz abc def", 24).endsWith("-") ===
    false
)

section("the registry itself")

check("three agents", CLICKUP_AGENTS.length === 3)
// The one that writes is the one that gets a checkout, and it is the only one.
check(
  "only the engineer writes",
  CLICKUP_AGENTS.filter((agent) => agent.kind === "chat")
    .map((agent) => agent.id)
    .join() === "engineer"
)
check(
  "and only the engineer gets a worktree",
  CLICKUP_AGENTS.filter((agent) => agent.worktree)
    .map((agent) => agent.id)
    .join() === "engineer"
)
// Every agent needs a directory, and the pane says so before Run rather than
// after — a check here because a `false` would be a turn in a directory nobody
// chose.
check(
  "every agent needs a project",
  CLICKUP_AGENTS.every((agent) => agent.needsProject)
)
check("ids are their own lookups", agentOf("engineer")?.id === "engineer")
check("and an unknown one is null", agentOf("designer") === null)

finish()

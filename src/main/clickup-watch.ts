import {
  CLICKUP_HISTORY,
  type ClickupChange,
  type ClickupProposal,
  type ClickupSnapshot,
  type ClickupWatch,
  type ClickupWatchAnswer,
} from "../shared/api"
import {
  agentOf,
  agentsIn,
  foldProposals,
  proposalsIn,
  type ClickupAgentId,
} from "../shared/clickup-agents"
import { describeChanges, fetchTask, taskRefIn } from "./clickup"

/**
 * The tasks this workspace is watching, and the timer that reads them.
 *
 * **The poll lives in main**, which is the whole reason this class exists
 * rather than a hook in the renderer. The point of watching a task is to be
 * told while looking at something else — another chat, another app, no window
 * at all — and a timer in a React tree is a timer that stops when that tree is
 * not the one on screen. It is the same division `WorktreeChats` makes: the
 * renderer draws a list main owns.
 *
 * Free of `electron`. The key and the writes are handed in, and so is
 * `onChange` — `ipc.ts` is what turns a change into an OS notification and a
 * push to the window, because that is where the window is. `test/clickup-watch.ts`
 * runs the parts worth testing without any of it.
 */

/**
 * How often every watched task is read.
 *
 * Two minutes rather than thirty seconds: what is being watched is a person
 * changing a status or writing a comment, which happens on a human's clock, and
 * a notification two minutes late has cost nobody anything. Against ClickUp's
 * 100 requests a minute for a personal token, ten tasks at two requests each is
 * a tenth of the budget with the tick to spare.
 */
const TICK_MS = 2 * 60 * 1000

/**
 * How long after launch the first poll runs.
 *
 * Not immediately: the window is still being built, and a notification fired
 * into a workspace somebody has not looked at yet is a notification about a
 * change they have not had the chance to miss. Long enough to be reading
 * something, short enough that a comment left overnight is there before the
 * first coffee.
 */
const FIRST_MS = 10 * 1000

export class ClickupWatcher {
  private timer: NodeJS.Timeout | null = null
  /** Guards against a tick starting while the last one is still in flight — a
   * slow network and a short tick would otherwise stack polls until the key is
   * rate-limited. */
  private polling = false

  constructor(
    private readonly deps: {
      /** The saved key, or empty. Read per poll rather than captured, so
       * saving one in Settings does not need this restarted. */
      token: () => Promise<string>
      read: () => Promise<ClickupWatch[]>
      write: (watches: ClickupWatch[]) => Promise<void>
      /** Called with the whole list after every poll that wrote anything, and
       * with the changes worth announcing — which is often none, since a poll
       * that only moved `polledAt` still has a list to push. */
      onChange: (
        watches: ClickupWatch[],
        announced: { watch: ClickupWatch; text: string }[]
      ) => void
      /** Ids for the proposals a poll opens. Handed in so `fold` stays pure and
       * so this class keeps its one job — reading ClickUp — without minting
       * anything of its own. */
      newId: () => string
    }
  ) {}

  start() {
    if (this.timer) return
    // `unref` so a pending tick is never what keeps Electron alive at quitting
    // time — the same bargain `one-turn-agent.ts` makes with its timeout.
    const first = setTimeout(() => this.tick(), FIRST_MS)
    first.unref?.()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  /**
   * One tick, with its failure logged rather than dropped.
   *
   * `void this.poll()` was what the timers called, and a rejection from it —
   * an unreadable manifest, a bug in the diff — became an unhandled rejection
   * nobody would ever see: the tick simply stopped happening, silently, which
   * is the worst way for a watcher to fail. `poll` itself already turns every
   * *network* failure into a row's `error`, so anything reaching here is this
   * app's own fault and belongs in a log.
   */
  private tick(): void {
    void this.poll().catch((error: unknown) => {
      console.error("ClickUp poll failed", error)
    })
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  list(): Promise<ClickupWatch[]> {
    return this.deps.read()
  }

  /**
   * Watches the task a URL names, reading it once so the row is not blank.
   *
   * The first read's snapshot is stored **without** any changes: see
   * `describeChanges` for why adding a task must not announce everything about
   * it. A task already watched answers with the row that exists — the record's
   * id is the task's, so there is nothing a second row could mean.
   */
  async add(url: string): Promise<ClickupWatchAnswer> {
    const ref = taskRefIn(url)
    if (!ref) return { error: "That is not a ClickUp task URL." }

    const watches = await this.deps.read()
    const already = watches.find((watch) => watch.id === ref.id)
    if (already) return { watch: already }

    const answer = await fetchTask(await this.deps.token(), ref)
    if ("error" in answer) return answer

    const now = new Date().toISOString()
    const watch: ClickupWatch = {
      id: ref.id,
      teamId: ref.teamId,
      url: url.trim(),
      seen: answer.snapshot,
      history: [],
      // Read at the moment it was added: a task watched a second ago has
      // nothing anybody has missed, and starting it unread would put a dot on
      // every row the instant it appeared.
      readAt: now,
      addedAt: now,
      polledAt: now,
      error: null,
    }
    await this.deps.write([...watches, watch])
    return { watch }
  }

  async remove(id: string): Promise<void> {
    const watches = await this.deps.read()
    await this.deps.write(watches.filter((watch) => watch.id !== id))
  }

  /**
   * Moves one task's `readAt` to now — what opening its row means.
   *
   * The history is **kept**: this is the difference between a mark and a log,
   * and the log is what the expanded row draws. See `ClickupWatch.history`.
   */
  async markRead(id: string): Promise<void> {
    const watches = await this.deps.read()
    const found = watches.find((watch) => watch.id === id)
    if (!found) return
    const now = new Date().toISOString()
    if (found.readAt === now) return
    await this.deps.write(
      watches.map((watch) =>
        watch.id === id ? { ...watch, readAt: now } : watch
      )
    )
  }

  /** Who a task is assigned to. The whole list, since a set of checkboxes has
   * no meaningful per-item call. Unknown ids are dropped on the way in rather
   * than stored and ignored forever. */
  async assign(id: string, agents: ClickupAgentId[]): Promise<void> {
    await this.patch(id, () => ({ agents: agentsIn({ agents }) }))
  }

  /** Which project this task's agents run in. Null is a real answer — it is
   * what every task starts as — and `runProposal` refuses in a sentence rather
   * than guessing a directory. */
  async setProject(id: string, folderId: string | null): Promise<void> {
    await this.patch(id, () => ({ folderId }))
  }

  /** One proposal, patched with what came of running it. */
  async patchProposal(
    id: string,
    proposalId: string,
    patch: Partial<ClickupProposal>
  ): Promise<void> {
    await this.patch(id, (watch) => ({
      proposals: proposalsIn(watch).map((one) =>
        one.id === proposalId ? { ...one, ...patch } : one
      ),
    }))
  }

  /**
   * One task changed on disk and pushed at the window.
   *
   * Every write past `add` goes through here for the reason `poll` re-reads its
   * own list: these are all handlers, a poll takes seconds and a run takes
   * minutes, so a write built on a list read before either would quietly undo
   * whatever landed in between.
   */
  private async patch(
    id: string,
    change: (watch: ClickupWatch) => Partial<ClickupWatch>
  ): Promise<void> {
    const watches = await this.deps.read()
    const found = watches.find((watch) => watch.id === id)
    if (!found) return
    const after = watches.map((watch) =>
      watch.id === id ? { ...watch, ...change(watch) } : watch
    )
    await this.deps.write(after)
    this.deps.onChange(after, [])
  }

  /**
   * Reads every watched task once.
   *
   * Tasks are read **in parallel** — ten tasks on a slow connection is one wait
   * rather than ten — and each one's failure is written to its own row rather
   * than thrown: one task deleted in ClickUp must not stop the other nine being
   * watched, which is the whole reason `error` is a field.
   *
   * The write happens once, at the end, with the whole list. Anything added or
   * removed **while** the poll was in flight would otherwise be overwritten by
   * a list read before it existed, so the answers are folded into a list read
   * again at the end rather than into the one the poll started from.
   *
   * **`polledAt` moves on every success, including a poll that found nothing**,
   * and the two words `wrote` and `announced` are kept apart for exactly that
   * reason. An earlier version set one flag for both, so a quiet poll wrote
   * nothing at all — which meant the row could never say when it had last
   * looked, and "is this thing running?" had no answer anywhere in the app.
   */
  async poll(): Promise<ClickupWatch[]> {
    if (this.polling) return this.deps.read()
    this.polling = true
    try {
      const token = await this.deps.token()
      const before = await this.deps.read()
      if (before.length === 0) return before

      const polled = await Promise.all(
        before.map(async (watch) => ({
          id: watch.id,
          answer: await fetchTask(token, {
            id: watch.id,
            teamId: watch.teamId,
          }),
        }))
      )
      const byId = new Map(polled.map((entry) => [entry.id, entry.answer]))

      const now = new Date().toISOString()
      const announced: { watch: ClickupWatch; text: string }[] = []
      /** Whether the list is worth writing. Not the same question as whether it
       * is worth a banner — see the note above. */
      let wrote = false

      // Read again: `add` and `remove` are handlers and can have landed while
      // the requests above were open.
      const current = await this.deps.read()
      const after = current.map((watch) => {
        const answer = byId.get(watch.id)
        // Added while this poll was in flight: it already has the snapshot its
        // own `add` read, and nothing here has anything to say about it.
        if (!answer) return watch

        if ("error" in answer) {
          if (watch.error === answer.error) return watch
          wrote = true
          return { ...watch, error: answer.error }
        }

        wrote = true
        const {
          watch: next,
          changes,
          opened,
        } = fold(watch, answer.snapshot, now, this.deps.newId)
        for (const change of changes) {
          announced.push({ watch: next, text: change.text })
        }
        // An offer is worth its own line: what somebody assigned an agent for
        // is being told there is something to press, and "Tanaka commented" is
        // not that sentence.
        for (const proposal of opened) {
          announced.push({
            watch: next,
            text: `${agentOf(proposal.agent)?.name ?? proposal.agent} has something to offer.`,
          })
        }
        return next
      })

      if (!wrote) return current

      await this.deps.write(after)
      this.deps.onChange(after, announced)
      return after
    } finally {
      this.polling = false
    }
  }
}

/**
 * One watched task with one poll's answer folded into it.
 *
 * Pulled out of `poll` because it is the part with an answer that can be wrong,
 * and because of the way it *was* wrong: it spread `watch.history` directly,
 * and a record written before that field existed has none — so the spread threw
 * `TypeError`, `poll` rejected, and **every poll died on the first task**
 * without writing anything. Nothing on screen said so; the file simply stopped
 * changing, which looks exactly like a watcher that is running and finding
 * nothing. `test/clickup-watch.ts` has that record by name.
 *
 * So every optional field is read through a default here, the way the renderer
 * already reads them (`unreadIn`). Main is the side that writes the file and is
 * therefore the side that must not assume its own latest shape.
 *
 * The snapshot is written back even with nothing to announce: it carries the
 * timestamps and the newest comment's id that the *next* poll is diffed
 * against, and a stale one would re-announce a change already reported once.
 */
export function fold(
  watch: ClickupWatch,
  snapshot: ClickupSnapshot,
  now: string,
  newId: () => string = () => now
): {
  watch: ClickupWatch
  changes: ClickupChange[]
  /** The proposals this poll **opened**, for the banner. A card merged into an
   * existing one is not here: the offer was already made and ringing again
   * every two minutes for the same one is how somebody learns to ignore it. */
  opened: ClickupProposal[]
} {
  const changes = describeChanges(watch.seen, snapshot, now)
  const history = watch.history ?? []
  // What the task's agents would offer to do about those changes — **offer**,
  // and nothing more: `foldProposals` writes cards, and the only thing that
  // runs one is `IPC.runClickupProposal`. There is deliberately no path from
  // this timer to `main/clickup-agents.ts`.
  const { proposals, opened } = foldProposals({
    proposals: proposalsIn(watch),
    agents: agentsIn(watch),
    changes,
    now,
    id: newId,
  })
  return {
    watch: {
      ...watch,
      seen: snapshot,
      history: [...changes, ...history].slice(0, CLICKUP_HISTORY),
      proposals,
      // A record from before this field is one nobody has opened since, so the
      // changes this poll found are unread — which is what a null already means
      // to `unreadIn`.
      readAt: watch.readAt ?? null,
      polledAt: now,
      error: null,
    },
    changes,
    opened,
  }
}

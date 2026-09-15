/**
 * The contract between the Electron main process and the renderer.
 *
 * Types only — no runtime code — so the main process and the frontend can both
 * import it without either one pulling the other's build into scope. The
 * frontend reaches it through the `@shared` alias.
 */

// Type-only, so the circle with `learnings.ts` (which takes `AssistantMessage`
// from here) never exists at runtime.
import type { LearningProposal } from "./learnings"

/**
 * One folder the workspace has been pointed at — a repository on this machine,
 * edited and run where it already is.
 *
 * Timestamps cross IPC as ISO strings: structured clone can carry a `Date`, but
 * keeping the wire format explicit means the renderer is never guessing whether
 * it holds a string or a `Date`.
 */
export type WorkspaceFolder = {
  id: string
  /** What the UI calls it. Defaults to the directory's own name. */
  name: string
  /** The absolute host path. Nothing is ever copied out of it: the studio adds
   * a record and reads the files where they are. */
  path: string
  addedAt: string
}

/**
 * The one workspace everything in the studio belongs to.
 *
 * There is deliberately no second one and no switching between them: two
 * folders open at once is what a person working across a frontend and its API
 * actually has, and a switch would take one of them — and every tab, session
 * and connection opened against it — off the screen. Sign-in will bring more
 * than one workspace, and until then the studio always holds this one.
 */
export type WorkspaceRecord = {
  id: string
  name: string
  folders: WorkspaceFolder[]
}

/**
 * One entry in a directory the Explorer is showing.
 *
 * Addressed by its absolute path rather than by an id, unlike everything else
 * that crosses this contract: a request or a card is a record this app created
 * and can name however it likes, while these are the user's own files, already
 * on disk, and the path is the only name they have. It is also what the tab
 * strip uses, so a file has one identity from the tree through to the pane.
 *
 * No size and no modified time: the listing is one `readdir`, and filling
 * either in would mean a `stat` per entry — a real cost on the `node_modules`
 * somebody eventually expands, to show two columns this tree does not have.
 */
export type FileEntry = {
  path: string
  name: string
  /** A symlink is reported as whatever it points at, so a linked directory
   * expands like one. */
  kind: "file" | "directory"
}

/**
 * One path in the index of the workspace — what the search palette searches and
 * what a chat's `@` menu offers.
 *
 * Separate from `FileEntry` because it answers a different question: that one
 * is a row in a directory somebody opened, this one is a path somewhere in the
 * workspace that nothing has necessarily looked at. `relative` is what is shown
 * and searched — `src/main/files.ts`, always with forward slashes so the string
 * reads the same on every platform — while `path` is the absolute one the tab
 * is opened by.
 */
export type FileIndexEntry = {
  path: string
  relative: string
  /** Which workspace folder it was found under, for the hint beside it: two
   * repositories in one workspace both have a `src/index.ts`. */
  folderId: string
  /**
   * Directories are indexed as well as files, because a chat's `@` menu offers
   * a folder — "read everything under `src/main`" is a thing somebody means.
   * The palette opens tabs and asks for `kind === "file"`.
   */
  kind: "file" | "directory"
  /**
   * A file's size on disk, and 0 for a directory.
   *
   * Here for the one thing that reads it: the `@` menu's approximate token
   * count, which is what stops a folder being mentioned without any idea of
   * what it would cost the turn. A size rather than a count of tokens because
   * the walk must not read what it indexes.
   */
  bytes: number
}

/**
 * What git says about one path.
 *
 * The index and the working tree are collapsed into one state on purpose:
 * nothing in the studio stages anything, so "changed and not committed" is the
 * whole of what a row can usefully say. `conflicted` is kept apart because it
 * is the one state where the file on disk is not something anybody wrote.
 */
export type GitFileState =
  "added" | "modified" | "deleted" | "untracked" | "conflicted" | "ignored"

/**
 * One path git has something to say about.
 *
 * `directory` means the entry stands for everything under it: git reports a
 * wholly untracked or ignored directory as itself rather than as its contents,
 * which is what keeps one `node_modules` from being a hundred thousand entries.
 */
export type GitStatusEntry = {
  path: string
  state: GitFileState
  directory: boolean
}

/**
 * One changed file in a checkout — a row of the Explorer's Changes list.
 *
 * `GitStatusEntry` answers "what is this file to git" for a row that already
 * exists in the tree; this answers "what has changed here", which is a
 * different question with a different shape: it is a **list** rather than a
 * lookup, it leaves out the ignored (a repository's ignored files are not
 * anybody's changes), and it carries the line counts, which cost a second git
 * call and are wanted for a handful of paths rather than for all of them.
 */
export type GitChange = {
  path: string
  state: GitFileState
  /**
   * Which side of the index this row is: the staged change, or the unstaged
   * one.
   *
   * `GitStatusEntry` has no such field, and that difference is the point. The
   * tree collapses porcelain's two columns because a row there can only say
   * "changed and not committed"; the Changes list is where staging is done, so
   * it has to keep them apart — and **one path can be two rows**, since a file
   * can be staged and then edited again. `state` is that side's own state, and
   * the counts are that side's own counts.
   */
  staged: boolean
  /**
   * Whether this row stands for a whole directory rather than for a file —
   * `GitStatusEntry.directory`, carried through because the list has to say so.
   *
   * A wholly untracked directory is one entry (`?? public/images/building/`),
   * and drawn like every other row it reads as a file with no line counts:
   * nothing on it says the twenty files under it are what is new. The list
   * marks it instead, and a click on it goes to the tree rather than to a diff
   * — there is no diff of a directory to open.
   */
  directory: boolean
  /**
   * Lines added and removed against `HEAD`, or null when there is no honest
   * number: a binary file, a wholly new directory, a file too large to count,
   * or a repository with no commit to compare against.
   *
   * Null rather than zero, because `+0 -0` is a real answer — a file whose only
   * change is a mode or a line ending — and a row that cannot tell the two
   * apart is a row that lies about one of them.
   */
  added: number | null
  removed: number | null
}

/**
 * Everything the diff pane needs about one file, read in a single round trip.
 *
 * The two travel together because the pane cannot draw either alone and mounts
 * nothing until both are in hand — two calls would be two waits for one paint.
 *
 * `head` is the file as `HEAD` has it, null when `HEAD` does not have it: a
 * file somebody has just written, a directory that is not a repository, or a
 * repository with no commits, all of which are the same nothing to a diff.
 *
 * `patch` is `git diff HEAD --unified=0` for that path, and it is git's own
 * answer to what changed rather than a second opinion computed in the renderer.
 * Null when git could not be asked. **It is a hint, not a promise**: the
 * renderer checks it against the two texts it is actually drawing and falls
 * back to computing the difference itself if it does not describe them — which
 * is what happens for a buffer with unsaved edits, since git reads the file on
 * disk. See `lib/files/git-diff.ts`.
 */
export type FileDiff = {
  head: string | null
  patch: string | null
}

/**
 * A directory the Explorer is watching whose contents changed.
 *
 * The directory rather than what happened in it: `fs.watch` reports a rename as
 * one event or two depending on the platform, and often names only one half of
 * it, while the tree re-reads the whole listing regardless. See `main/watch.ts`.
 */
export type DirectoryChange = { dir: string }

/**
 * What hovering a symbol in the editor says.
 *
 * The pieces tsserver hands back, kept apart rather than pre-rendered into one
 * string: the signature is code and is shown as code, the documentation is
 * markdown, and the tags are the `@param`/`@returns` lines, which the tooltip
 * lays out as a list. Composing them here would be the main process deciding
 * what a tooltip looks like.
 */
export type TsHover = {
  /** `(alias) function defineConfig(config: Config): Config` — the line at the
   * top of the tooltip, highlighted as TypeScript. */
  signature: string
  /** The doc comment, as markdown. Empty when the symbol has none. */
  documentation: string
  tags: { name: string; text: string }[]
}

/** Where a symbol is declared — a file this app can open as a tab, and a
 * 1-based position in it. */
export type TsDefinition = {
  path: string
  line: number
  column: number
}

/**
 * What opening a file gave back.
 *
 * The two refusals are results rather than errors: "this is a PNG" and "this is
 * 40 MB" are things the pane can say plainly, and rejecting would file them
 * beside "the disk went away".
 */
export type FileContent =
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "too-large"; size: number }

/** Which stream a line of process output came from. */
export type ProcessStream = "stdout" | "stderr"

export type ProcessOutput = {
  processId: string
  stream: ProcessStream
  line: string
}

export type ProcessExit = {
  processId: string
  /** `null` when the process was killed by a signal rather than exiting. */
  code: number | null
  signal: string | null
}

/**
 * One line of a chat, as it is drawn and as it is kept on disk.
 *
 * Here rather than in the renderer because both sides hold it: the pane draws
 * it, and the main process — which sees every event — is what writes the chat
 * down, so a chat reopened next week is the one that was had.
 *
 * `Assistant` names the *role*, not a panel: the workspace assistant that once
 * shared these types is gone, and a project's chat is the conversation left.
 */
/**
 * One item of the list a turn keeps with `TodoWrite`.
 *
 * The CLI sends a third field, `activeForm` — the same task in the present
 * participle, for the line it draws while that one is running. It is not kept:
 * it is the same sentence twice on a record that is rewritten to disk on every
 * appended line, and the checklist already says which item is running by
 * drawing it as running.
 */
export type ChatTodo = {
  content: string
  status: "pending" | "in_progress" | "completed"
}

export type AssistantMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string }
  /**
   * The model's own reasoning, drawn as one folded line.
   *
   * Kept apart from `assistant` rather than run in with it: it is what the model
   * thought on the way to the answer, not the answer, and a chat that ran the
   * two together would be a reply nobody can find the end of. There was a
   * `showThinking` setting for this; the fold made it pointless and it is gone,
   * so these are always drawn.
   */
  | { id: string; role: "thinking"; text: string }
  /**
   * A tool call, drawn as one line: what it was, what it was about, and what
   * came back.
   *
   * **The one line in a chat that is not append-only.** A call is written when
   * it goes out, because that is when there is something to draw, and its
   * result arrives afterwards — so `result` is filled in on the line that is
   * already on screen, found by `toolId`. The alternative was holding the row
   * back until the result came, which is a chat that shows nothing while the
   * thing worth watching is happening.
   *
   * Every field after `summary` is optional because a chat is read back from
   * disk: a line written before any of them existed has none, and it still has
   * to draw.
   */
  | {
      id: string
      role: "tool"
      name: string
      /** The argument that says which thing it was about — a path, a command, a
       * statement. */
      summary: string
      /** The CLI's own id for the call, which is what its result finds it by. */
      toolId?: string
      /** What the tool call said it was for, in the model's words: the
       * `description` a `Bash` or a `Task` carries. */
      title?: string
      /** The file it was about, absolute, when it was about one — so a row can
       * draw the name with its file-type icon rather than a path that is forty
       * characters of checkout before it says anything. */
      path?: string
      /** One line about what came back: `631 lines`, or the output itself when
       * it was one line. Absent while the call is still running. */
      result?: string
      /**
       * The whole argument the call was made with, for the row that opens.
       *
       * Present **only where `summary` is not already all of it** — a `Read` of
       * one path has nothing more to show, and storing a second copy of a short
       * string on every line would grow the chat's file for nothing. So this is
       * the multi-line command and the 300-character query, and its absence is
       * how a row knows it has no argument worth opening.
       */
      input?: string
      /**
       * The whole of what came back, capped, for the same row.
       *
       * Present only where `result` is a *count* rather than the output itself,
       * which is the same rule `input` follows. It is capped in main
       * (`detailOf`) because a chat is rewritten to disk on every appended line
       * and one `Bash` that printed a build log would otherwise be carried
       * through every write for the life of the conversation.
       */
      output?: string
      /**
       * How much an edit moved — `+3 −1` — read off the call's own input rather
       * than its result.
       *
       * The row draws this **instead of** `result` for a call that has one,
       * because what the CLI sends back for an edit is a sentence naming the
       * absolute path the chip beside it is already showing. `result` is still
       * kept and still drawn when the call *failed*, which is the one time that
       * sentence is the thing worth reading.
       */
      stat?: string
      /** The change itself, as `-`/`+` lines, capped: what the row shows on
       * hover. Not a computed diff — these are the two sides the call was made
       * of. */
      change?: string
      /**
       * The list a `TodoWrite` wrote, read out of its own input.
       *
       * Read rather than left as the argument JSON for the reason `change` is:
       * the row was drawing `{"todos":[{"content":"…","status":"pending"…` cut
       * at 120 characters, which is the one call in a transcript whose argument
       * *is* the thing worth reading. Absent for every other tool, and absent
       * for a `TodoWrite` whose payload does not have the shape below — a newer
       * CLI lands back on the JSON rather than on an empty checklist.
       */
      todos?: ChatTodo[]
      /** Set when the tool call came back an error. */
      failed?: boolean
    }
  | { id: string; role: "error"; text: string }
  /**
   * Something the turn stopped to ask, and what was said back.
   *
   * Written once it has been answered rather than while it is pending: a
   * question on disk is one nobody can answer, because the process that asked
   * it is gone. What is kept is the decision, which is the part worth reading
   * next week — a turn that could edit because somebody allowed it, or a plan
   * that went one way because somebody picked an option.
   */
  | { id: string; role: "ask"; text: string }
  /**
   * What the turn cost, written down as the last line of it.
   *
   * A line of the conversation rather than a field on the record, for the
   * reason every other line is one: a chat holds several turns and each of them
   * cost its own amount, and a total on the record could not say which turn ran
   * on Opus and which on Haiku. Summing the lines is how a chat's total is got
   * (`lib/worktree-chat/usage.ts`), which also means a chat written before this
   * existed reads back as a chat with nothing to say about its cost rather than
   * as one that cost nothing.
   */
  | { id: string; role: "usage"; usage: TurnUsage }
  /**
   * The conversation was compacted, written down where it happened.
   *
   * A line rather than a state, because it is a thing that happened *at a point
   * in the chat*: everything above it the model now knows only as a summary, and
   * a reader scrolling back is owed the boundary. The CLI draws the same
   * divider, and for the same reason.
   *
   * `trigger` is worth keeping apart: an `auto` compaction is the window filling
   * up on its own, a `manual` one is somebody having typed `/compact`, and the
   * first of the two is the one that explains why an answer above the line reads
   * as though it forgot something.
   */
  | {
      id: string
      role: "compact"
      trigger: "manual" | "auto"
      /** What the window held before. */
      preTokens: number
      /** And after — absent on a CLI that reports only the one side. */
      postTokens?: number
      durationMs?: number
    }

/**
 * What one turn spent, in the numbers that explain the spending.
 *
 * **Why the cache halves are separate.** A turn's prompt is the same size
 * either way — this app's own system prompt, the tool list and every line of
 * the conversation so far — and the whole of the difference between a cheap turn
 * and an expensive one is which side of the cache it landed on: a prompt read
 * from the cache is billed at a tenth, and one written to it at a quarter more
 * than full price. So `cacheRead` and `cacheWrite` are the pair worth reading,
 * and one `input` total would have hidden it. A turn showing 40k written and
 * nothing read is this app having asked for a prefix nobody had asked for yet —
 * a different system prompt, a different tool list, or an hour since the last
 * turn that shared one.
 *
 * Taken from the SDK's `modelUsage` rather than its `usage`, which is
 * documented as the main loop alone: a turn that spawned a subagent spent what
 * the subagent spent, and a `Task` is on the pre-approved list.
 */
export type TurnUsage = {
  /** The model the turn actually ran on, which the toolbar's own `null` does
   * not say — that leaves the user's `claude` to decide, and this is what it
   * decided. Null when the SDK reported no per-model usage at all. */
  model: string | null
  /** Prompt tokens neither cache held. */
  input: number
  /** Prompt tokens written to the cache, at 1.25x. */
  cacheWrite: number
  /** Prompt tokens read from the cache, at 0.1x. */
  cacheRead: number
  output: number
  /** Of `output`, what went on reasoning. The SDK reports this for the main
   * loop only, so it is a floor rather than a total. */
  thinking: number
  /** The SDK's own estimate for the turn, in USD, or null where it reported
   * none — a crashed turn carries zeroes it would be wrong to draw as free. */
  costUsd: number | null
  /**
   * How much of the context window the conversation stood at when the turn
   * ended: the last main-loop request's prompt plus what came back.
   *
   * Not a spend and not derivable from the fields above, which is why it is its
   * own number. Those are sums over everything the turn did — every model call,
   * every subagent — and a chat's context is none of that: it is the size of
   * the *one* prompt the next turn will be built on, so a turn that made eight
   * calls has a prompt eight times its own context, and a turn that ran three
   * subagents counted three conversations this one never sees. Read off the
   * turn's last assistant message rather than its result line for that reason.
   *
   * Null for a turn that reported none — a crash before the first reply, and
   * every line written before this field existed.
   */
  context: number | null
  /**
   * How long the turn took on the clock, in milliseconds.
   *
   * Measured in main rather than read off the SDK's `duration_ms`, for the
   * reason every other figure here is subtracted: the numbers on a result line
   * are the streaming session's, and a wall time taken from it would grow with
   * the chat. It is the same quantity the spinner counts up — from the prompt
   * going in to the result coming back, tool calls and all — so a finished turn
   * reads as what somebody watched it take.
   *
   * Null for a line written before this existed, which is what stops a chat
   * from last week claiming its turns were instant.
   */
  durationMs: number | null
}

/**
 * One thing that happened while a turn was being answered.
 *
 * A turn is one `query()` of `@anthropic-ai/claude-agent-sdk`, so what arrives
 * is the SDK's own message stream, narrowed to the three things a pane draws: a
 * message, a tool it called, and the end of the turn. Anything else in that
 * stream — the init line, the status and progress events — is read by
 * `main/claude-agent.ts` and not passed on. A tool's result and the turn's
 * token counts are passed on, as the two events below that are not a line of
 * the answer.
 */
export type AssistantEvent =
  /** One assistant message, as markdown. A turn can produce several. */
  | { type: "text"; text: string }
  /** The model's reasoning on the way to one of those. */
  | { type: "thinking"; text: string }
  /** A tool the assistant called, drawn as a line rather than in full: the
   * arguments are usually a SQL statement or a request name. */
  | {
      type: "tool"
      name: string
      summary: string
      toolId?: string
      title?: string
      path?: string
      /** The whole argument, where the row is not already showing it — see the
       * same field on the line it becomes. Carried on the event and not only
       * written to the record, or a row would not open until the chat was read
       * back off disk. */
      input?: string
      /** `+3 −1` for an edit — see the same field on the line it becomes. */
      stat?: string
      change?: string
    }
  /**
   * What a tool call came back with, for the line already drawn for it.
   *
   * Its own event rather than a second `tool`, because it changes a row instead
   * of adding one — the only event here that does. A `toolId` nothing is waiting
   * on is ignored, which is what happens to the result of a call whose line was
   * written by a build that had no ids.
   */
  | {
      type: "tool-result"
      toolId: string
      result: string
      /** The whole of it, where `result` is only a count — see `output` on the
       * tool line. */
      output?: string
      failed: boolean
    }
  /**
   * The turn has stopped and is waiting to be answered.
   *
   * The turn is *paused* here, not ended: the CLI is holding the tool call, and
   * it stays held until `answerWorktreeChatAsk` names this ask. Nothing else
   * arrives for this chat in the meantime.
   */
  | { type: "ask"; ask: WorktreeChatAsk }
  /**
   * An ask has been answered, and this is the line recording it.
   *
   * The text comes from the main process rather than being rebuilt by whoever
   * answered: main is what writes the conversation down, and a renderer
   * composing its own version of the same sentence is two spellings of one line
   * waiting to drift apart. Arriving here also means the card can come down.
   */
  | { type: "decision"; text: string }
  /**
   * Why the turn failed, as a line of the conversation.
   *
   * Its own event rather than something read off `done`'s `error`, because the
   * two are not the same thing arriving twice: this is a line `append` writes to
   * the chat's file, `done` is the turn ending. Drawing the line from `done` as
   * well meant one failure appearing twice — see `finish` in
   * `main/worktree-chat.ts`.
   */
  | { type: "error"; text: string }
  /** The turn is over, one way or the other. `error` is set when it failed —
   * including when `claude` itself could not be started; the line saying so
   * arrives as the `error` event above. Any ask still pending is gone with it:
   * the process that would have taken the answer has ended.
   *
   * **Not** the chat going quiet: a message sent while that turn was running is
   * queued, and the turn after it starts without anybody sending anything. What
   * says whether a chat is working is `busy`. */
  | { type: "done"; error: string | null }
  /**
   * Whether the chat is working on something.
   *
   * Its own event because a renderer can no longer work it out. It used to be
   * "sent, and no `done` yet", which was the whole truth while a turn was a
   * process and a chat refused a second message until the first had finished.
   * A chat now takes a message mid-turn and runs it afterwards, so the end of a
   * turn and the end of being busy are different moments and only the main
   * process knows both — see `onBusy` in `main/claude-agent.ts`.
   *
   * A state rather than an edge: the same value can arrive twice, and a receiver
   * is expected to set rather than to count.
   */
  | { type: "busy"; busy: boolean }
  /**
   * What the turn cost, once it is over.
   *
   * Its own event arriving just before `done` rather than a field on it,
   * because it is a line of the conversation and `done` is not: the same
   * `append` writes it to the chat's file, and a `done` carrying it would have
   * been the one event that both ends a turn and adds to it.
   */
  | { type: "usage"; usage: TurnUsage }
  /**
   * The conversation was compacted — the line, on its way to the pane.
   *
   * Paired with the `compact` role the same way `usage` is with its own: main
   * writes the line to the chat's file and announces it here, so a pane that is
   * already open gets the divider without re-reading the file.
   */
  | {
      type: "compact"
      trigger: "manual" | "auto"
      preTokens: number
      postTokens?: number
      durationMs?: number
    }
  /**
   * How full the context window is, as of the reply that just arrived.
   *
   * Its own event, and the only one here that is neither a line nor the state
   * of the turn, because it is the one number somebody watches *while* a turn
   * runs: a chat's context is what decides when the CLI compacts, and reading
   * it off the `usage` line means being told after the fact, once per turn. A
   * long turn that reads twenty files moves this a long way before it ends.
   *
   * Not written down. The chat's own usage lines are the record — see `context`
   * on `TurnUsage` — and this is the same quantity arriving sooner, so a
   * reloaded window falls back to the last line rather than to nothing.
   */
  | { type: "context"; tokens: number }
  /**
   * The window as the **CLI** accounts for it, asked for once a turn ends.
   *
   * The difference from `context` above is the denominator, and it is the whole
   * reason this exists. `context` is a count read off the last reply's own
   * usage: it says `19.3k` and cannot say whether that is nothing or nearly
   * full, because a reply does not carry the size of the window it was answered
   * in. This is `getContextUsage()` — a control request, no tokens — which
   * carries `maxTokens`, the auto-compact threshold, and the split by category.
   *
   * It is also a **better numerator**: the CLI counts the deferred tool schemas,
   * the memory files and the skill frontmatter that a reply's usage rolls into
   * one prompt figure, which is what makes a breakdown worth drawing at all.
   *
   * Once a turn rather than while one runs, deliberately: a control request per
   * reply would be a round trip per content block for a number nobody can act on
   * mid-answer. `context` is still what moves during a turn.
   *
   * Not written down, like `context`: it is the state of a live session, and a
   * chat read back off disk has no session to ask.
   */
  | { type: "window"; window: ChatWindow }
  /**
   * The CLI is compacting, or has stopped.
   *
   * A state rather than a progress figure, because that is all there is:
   * compaction is one summarisation call, so the SDK reports `compacting` and
   * then not, with a `compact_result`. There is no percentage to report and a
   * determinate bar drawn here would be an animation pretending to measure
   * something. What *is* measurable is the window either side of it, which
   * arrives as the `compact` line.
   *
   * `error` is set only when it failed, and is the CLI's own sentence.
   */
  | { type: "compacting"; compacting: boolean; error: string | null }
  /**
   * The chat is called something better than the sentence it was opened with.
   *
   * The only event here that changes the **listing** rather than the pane. The
   * name is not the turn's to produce: the CLI writes one into its own
   * transcript, off the first message, and nothing on the message stream
   * carries it — see `retitle` in `main/worktree-chat.ts`, which reads it out.
   *
   * It arrives just ahead of `done`, whose re-read of the listing carries the
   * same name, so this is not usually what draws it. It is what draws it on a
   * turn that **failed**, where there is no re-read — a chat's first turn can
   * end in an error and still have been named.
   *
   * At most once per chat, and never for one the user has named.
   */
  | { type: "title"; title: string }
  /**
   * The subagents this chat has running, as a whole list.
   *
   * A **level**, not a pair of edges, for the reason the SDK gives its own
   * `background_tasks_changed` the same shape: a start and a finish that have to
   * be matched up leave a spinner running for ever the day one of them is
   * missed. A receiver replaces its list with this one.
   *
   * Not written down and not a line of the conversation: what a subagent did
   * arrives as the tool rows it produced, and this is only what is happening
   * *now*. A chat read back off disk has none.
   */
  | { type: "agents"; agents: ChatAgent[] }

/**
 * One subagent running under a turn.
 *
 * Read off the CLI's `task_started` / `task_progress` heartbeat, which is the
 * only account of a subagent that is *still working*: its tool calls arrive on
 * the same stream and its answer arrives at the end, but between the two — a
 * minute, five minutes — the transcript says nothing and the pane had nothing to
 * draw. That gap is the whole reason this exists.
 */
export type ChatAgent = {
  /** The CLI's own task id, which is what the heartbeat is keyed by. */
  id: string
  /** What the turn asked for, in the model's own words. */
  description: string
  /** Which agent it is — `Explore`, `general-purpose` — where the CLI says. */
  subagentType?: string
  /** The last tool it called, so a long-running agent shows movement rather
   * than only a name. */
  lastTool?: string
}

/** One of the choices in a question the model asked. */
export type ChatAskOption = {
  label: string
  description: string
}

/** One question, out of the one to four an `AskUserQuestion` carries. */
export type ChatAskQuestion = {
  /** The full text, which is also the key an answer is filed under. */
  question: string
  /** A short label for it — twelve characters or so, the model's own. */
  header: string
  options: ChatAskOption[]
  multiSelect: boolean
}

/**
 * A turn waiting on the user: the thing print mode could not have.
 *
 * Two shapes, because the CLI asks two different things and they are answered
 * differently. A **tool** request is "may I do this", which is yes or no; a
 * **questions** request is `AskUserQuestion`, where the model wrote the options
 * and wants one picked. Both arrive through the SDK's `canUseTool`, which is
 * why they are one type with one answer call rather than two of each.
 *
 * Held in memory in the main process only, and lost if the window reloads —
 * like `sending` in the renderer's own store, and for the same reason: what is
 * on the other end is a process, not a record.
 */
export type WorktreeChatAsk = {
  /**
   * Unique per request.
   *
   * An answer names it, so a card left on screen from a question that has since
   * been withdrawn cannot answer the one that replaced it.
   */
  id: string
  chatId: string
} & (
  | {
      kind: "tool"
      /**
       * The sentence to show — "Claude wants to read foo.txt".
       *
       * The SDK renders it, and it is used rather than rebuilt from the tool
       * name and its input: the CLI knows which argument of a Bash call is the
       * interesting one, and this app would be guessing.
       */
      title: string
      /** The tool, for the line that records the decision afterwards. */
      name: string
      /** What it was about — the same one-liner a tool row carries. */
      summary: string
      /**
       * Whether "don't ask again" is on offer.
       *
       * Only sometimes: the SDK hands back a rule to remember for the calls it
       * can describe as a rule, and there is nothing to offer for the ones it
       * cannot. An `always` answer to an ask without it is treated as a plain
       * allow rather than refused, since the difference is a convenience.
       */
      always: boolean
    }
  | { kind: "questions"; questions: ChatAskQuestion[] }
)

/**
 * What the user said back.
 *
 * `always` writes a permission rule where the SDK suggested one, which is the
 * CLI's own "don't ask again" — it lands in the checkout's
 * `.claude/settings.local.json`, so it is remembered for that branch and goes
 * when the branch does.
 *
 * Answers are arrays even for a question that takes one, so the shape does not
 * depend on `multiSelect` — one place to join them instead of two to get wrong.
 */
export type WorktreeChatAnswer =
  | { kind: "allow"; always?: boolean }
  | { kind: "deny" }
  | { kind: "answers"; answers: Record<string, string[]> }

/**
 * How far along one MCP server's connection is, as the CLI reports it.
 *
 * The CLI's own five, plus `unknown` for a sixth it grows later: the value
 * crosses into the renderer typed as this, and a word this app has no row style
 * for is better drawn as "unknown" than trusted into a `switch` that has no arm
 * for it. `pending` is the one worth knowing about — MCP startup is not blocking
 * for the CLI, so a listing asked the moment a process comes up can legitimately
 * be all pending, which is why the listing is asked more than once (see
 * `main/mcp-servers.ts`).
 */
export type McpServerState =
  "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "unknown"

/**
 * Which MCP tools a chat here may not call, as wire names.
 *
 * A workspace setting of this app's rather than anything written into the user's
 * own `claude` config: turning a tool off here must not change what their
 * terminal can do. The entries are the names a turn's tool call actually carries
 * (`mcp__figma__get_metadata`), or a server prefix (`mcp__figma`) standing for
 * everything on it, which is the form the CLI's own `disallowedTools` already
 * understands — so this setting is handed straight over rather than expanded
 * here. A **wire** name, note, not the configured one: the CLI normalises a
 * server's name into it (`claude.ai ClickUp` → `claude_ai_ClickUp`), which is
 * `wireServer` in `lib/worktree-chat/mcp-servers.ts`.
 *
 * Stored as a JSON array under one key rather than a key per tool: a connector
 * has fifty of them, and the list is read whole on every turn anyway.
 */
export const MCP_DISABLED_TOOLS_KEY = "mcp.disabledTools"

/**
 * Whether a chat that finishes, fails or stops to ask rings an OS notification
 * while the window is unfocused. `"off"` switches it off; **anything else,
 * including unset, is on**.
 *
 * That default is deliberate and is the one place in Settings where an unset
 * key does not mean "no". Several chats answering at once is what this app is
 * for, and the only thing that makes walking away from them workable is being
 * called back — a user who has to find the switch first has already lost the
 * turn they walked away from.
 */
export const CHAT_NOTIFICATIONS_KEY = "chats.notifications"

/**
 * Whether the menu bar carries an icon counting the chats that are working and
 * the ones stopped on a question. `"off"` takes it out of the strip;
 * **anything else, including unset, is on**.
 *
 * The same default and the same argument as `CHAT_NOTIFICATIONS_KEY`, which it
 * sits beside: a notification is a moment and this is the standing version of
 * it, for the far commoner case of glancing at the machine rather than being
 * interrupted by it. Read by main, which owns the icon — the renderer only
 * draws the switch.
 */
export const CHAT_TRAY_KEY = "chats.tray"

/** One tool a server offers, as a row of the Settings listing draws it. */
export type McpToolInfo = {
  /** The tool's own name, without the `mcp__<server>__` the CLI prefixes it
   * with when a turn calls it. */
  name: string
  description: string | null
}

/**
 * One MCP server the user's own `claude` has, the way `/mcp` lists them.
 *
 * Read from the CLI rather than from the config files this app could parse
 * itself, because the interesting half is not in any of them: whether the
 * server actually connected, what it failed with, and which tools it turned out
 * to offer. A listing assembled from `~/.claude.json` and a repository's
 * `.mcp.json` would say a server exists and nothing about whether it works.
 */
export type McpServerInfo = {
  /** As configured — the same name a tool call carries (`mcp__linear__…`). */
  name: string
  state: McpServerState
  /** Where it is configured (`user`, `project`, `local`, `claudeai`,
   * `managed`, …), or null for a CLI that did not say. */
  scope: string | null
  /** How it is reached — `stdio`, `http`, `sse`, `sdk` — for a row that says
   * more than a name. */
  transport: string | null
  /** The command or URL behind it, when there is one worth showing. */
  address: string | null
  /** Why it failed, when `state` is `failed`. */
  error: string | null
  /** Empty until it connects: the CLI only knows a server's tools once it has
   * asked it. */
  tools: McpToolInfo[]
}

/**
 * The answer to one ask, and why there is nothing in it when there is nothing.
 *
 * `error` rather than an empty list standing in for both: a workspace with no
 * servers configured and a `claude` that could not be run are the same array and
 * very different things to be told, and the second one is the one somebody needs
 * to act on.
 */
export type McpListing = {
  /** The directory the CLI was asked in — an MCP config is per directory (a
   * repository's own `.mcp.json`), so the listing is only true of one. */
  cwd: string
  servers: McpServerInfo[]
  error: string | null
}

export type TerminalOutput = {
  terminalId: string
  /** Raw bytes from the shell, ANSI escapes included. */
  chunk: string
}

export type TerminalExit = {
  terminalId: string
  exitCode: number
  /** Set when the shell was killed by a signal rather than exiting. */
  signal: number | null
}

/**
 * One chat in a project: a conversation the app hosts, not a pty it reads.
 *
 * The app hosts it rather than reading one the CLI wrote: one agent turn at a
 * time in the project's own directory, with the app holding the messages. There
 * used to be a session panel that did the opposite — the interactive CLI in a
 * pty, with a chat view tailing its transcript — and this is what replaced it.
 * See `main/worktree-chat.ts`.
 *
 * `id` is also the CLI session id, so the record and the conversation the CLI
 * resumes name the same thing.
 */
/**
 * `--effort`, weakest first.
 *
 * The CLI's own levels rather than a scale of this app's making, so what the
 * picker says and what the turn is given are the same word.
 */
export const CHAT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

export type ChatEffort = (typeof CHAT_EFFORTS)[number]

/**
 * The level a chat runs at when nobody has picked one.
 *
 * **A level and not null**, which is the change worth explaining. `null` meant
 * "pass no `--effort` and let the CLI decide", and the picker drew it as a row
 * called `Default` sitting above the five real ones — so the tick was on a word
 * rather than on a level, and there was nothing on screen, anywhere, saying how
 * hard a chat was actually thinking. Nothing could say: the CLI's answer to
 * `supportedModels()` lists the levels a model accepts and does not name the one
 * it would fall back to, so the honest choices were a menu that admits it does
 * not know or a level this app names out loud. This is the second.
 *
 * `medium` because it is the middle of the five and because it is what an
 * unconfigured install lands on; somebody who wants their own
 * `~/.claude/settings.json` to decide is describing `Inherit`, which is a
 * different control.
 *
 * A record can still hold `null` — every chat written before this does, and a
 * model that takes no levels at all is picked with one — so `chatOptions` reads
 * a null as this, and the CLI ignores an effort a model has no use for the same
 * way it ignores a global `effortLevel` in settings.
 */
export const DEFAULT_CHAT_EFFORT: ChatEffort = "medium"

/**
 * One model the user's own `claude` will answer on.
 *
 * **Asked of the CLI rather than written down here.** This was a list of four
 * aliases in this file, and the trouble with it is not that it went stale — it
 * is that it was never right for anybody in particular: which models an install
 * offers is a property of that account and that CLI version, so one machine's
 * list has `Opus (1M context)` and a Fable that needs credits while another's
 * has neither, and a hand-written `fable` was an alias no row on this machine's
 * list actually names. `agentModels` asks, and `CHAT_MODEL_FALLBACK` is what a
 * picker draws when the asking failed.
 *
 * `value` is what goes to `--model` and `label`/`description` are the CLI's own
 * words for it, so the picker cannot describe a model differently from the tool
 * that runs it. `efforts` is per model and not a constant: Haiku 4.5 supports
 * no effort levels at all, and an effort picker offering `max` over it is a
 * control that does nothing.
 */
export type AgentModel = {
  /** What `--model` is given. An alias (`opus`), a full id, or the CLI's own
   * `default` row. */
  value: string
  /**
   * The wire id this row's `value` resolves to — `claude-sonnet-5` for both
   * `sonnet` and, on an account recommending Sonnet, `default`.
   *
   * Kept for one job: saying what `Default (recommended)` actually is. That row
   * is the CLI's own and its label names no model, so a picker drawing it alone
   * ticks a word rather than a model. Two rows sharing a `resolvedModel` are the
   * same model under two names, which is how the alias behind `default` gets a
   * label worth showing. Optional — a CLI that predates the field sends none,
   * and the row then reads as it did before.
   */
  resolvedModel?: string
  /** `Opus (1M context)` — the CLI's `displayName`. */
  label: string
  /** `Opus 5 with 1M context · Best for everyday, complex tasks`. */
  description: string
  /**
   * The levels this model accepts, weakest first.
   *
   * Three states rather than two, and the third is the point: a list is what
   * the CLI said, `[]` is the CLI saying this model takes no effort at all
   * (Haiku 4.5 does), and **null is nobody having been able to ask** — a
   * fallback row, or a build that read this off something older. Only the
   * second of the three takes the effort picker away; see `chatEfforts`.
   */
  efforts: ChatEffort[] | null
  /** Flag to render a `NEW` badge in the model picker. */
  isNew?: boolean
  /** Flag to render a star icon for recommended/favorite model. */
  isFavorite?: boolean
  /** Explicit sort order for the model picker. */
  order?: number
}

/**
 * What one slice of the context window is, in this app's own vocabulary.
 *
 * **Translated rather than passed through.** The CLI names a colour per
 * category — `promptBorder`, `inactive`, `claude`, `warning`,
 * `purple_FOR_SUBAGENTS_ONLY` — and those are its *terminal theme's* names, not
 * anything a stylesheet here can use. They are also not stable: a category
 * renamed or recoloured in a CLI release would silently become an uncoloured
 * bar. So the category's **name** is matched to one of these in
 * `main/claude-agent.ts` and an unrecognised one becomes `other`, which draws
 * in a neutral tone rather than not at all.
 */
export type ChatWindowTone =
  "system" | "tools" | "memory" | "skills" | "messages" | "free" | "other"

/** One row of the breakdown — a category, what it holds, and how it draws. */
export type ChatWindowSlice = {
  /** The CLI's own words: `System tools (deferred)`, `Memory files`. */
  name: string
  tokens: number
  tone: ChatWindowTone
  /**
   * An out-of-window tool schema, listed for awareness and **excluded from the
   * usage arithmetic** — the SDK is explicit about this. Kept as a flag rather
   * than dropped, because "13.7k of tool definitions you are not paying for" is
   * worth seeing next to the ones you are.
   */
  deferred: boolean
}

/**
 * How full a chat's context window is, as the CLI itself accounts for it.
 *
 * The structured twin of what `/context` prints, asked for over the SDK's
 * control channel at the end of a turn (`getContextUsage()`): a control request,
 * so it costs a round trip and no tokens.
 *
 * **Only ever about a live session.** The numbers describe the process the chat
 * is talking to, so a chat whose session has been closed for idleness has none
 * until its next turn — which is why this is an event and not a field on the
 * record. See the `window` event.
 */
export type ChatWindow = {
  /** Estimated tokens in use. May exceed `maxTokens`: the SDK sends it
   * unclamped, and a window over its limit is the one case worth drawing
   * honestly rather than pinning to 100. */
  tokens: number
  maxTokens: number
  /** The CLI's own rounding of the two above, 0–100 and occasionally past it. */
  percentage: number
  /**
   * Where auto-compaction kicks in, in tokens, or null when it is switched off.
   *
   * The number somebody actually watches for: `2%` means nothing without it, and
   * a bar with a mark on it answers "how long have I got" in one glance.
   */
  autoCompactAt: number | null
  /** The main-loop model the figures were computed for — a window is per model,
   * so a chat switched from Haiku to Opus is measured against a different one. */
  model: string
  slices: ChatWindowSlice[]
}

/**
 * One slash command the user's own `claude` would run — a built-in, a project's
 * `.claude/commands/` file, a skill, or a plugin's.
 *
 * Asked of the CLI for the reason `AgentModel` is: this app installs none of
 * them, so the only list it could write down would be a guess at what the CLI
 * finds for itself in that directory. `supportedCommands()` is the same control
 * channel `agentModels` uses — a `claude` process, no tokens, no turn.
 *
 * `name` is without the leading slash, and may be namespaced
 * (`figma:figma-use`). `aliases` are the CLI's own short forms — `review` for
 * `code-review` — and are matched by the composer's menu but never shown as
 * rows of their own, since a row per alias is one command listed twice.
 */
export type AgentCommand = {
  name: string
  description: string
  /** `[low|medium|high] [--fix]` where the command declares one, empty string
   * otherwise. Drawn beside the name so the menu says a command takes an
   * argument before somebody sends it without one. */
  argumentHint: string
  aliases: string[]
}

/**
 * The commands found in one directory, or why they could not be asked for.
 *
 * Shaped like `McpListing` and for the same reason: an empty list and a `claude`
 * that would not start are the same thing to a menu, and only one of the two is
 * something the user can act on.
 */
export type AgentCommandListing = {
  /** Where they were asked for — a command set is per directory, since a
   * project's own `.claude/commands/` is only there. */
  cwd: string
  commands: AgentCommand[]
  error: string | null
}

/**
 * What the picker draws when the CLI could not be asked, and until it answers.
 *
 * **Aliases the CLI resolves, and nothing else.** This list grew a set of
 * invented rows once — `Sonnet 5 1M`, `Opus 4.8 1M` and four more, with
 * hand-written labels, descriptions and effort levels — and every one of them
 * was a turn that failed on its argument list, because `--model sonnet-5-1m`
 * names no model on any account. What an install offers is a property of that
 * account and that CLI version, so the only thing safe to write down here is
 * the handful of aliases the CLI has always resolved for itself; anything
 * richer is `agentModels` asking. See `AgentModel`.
 *
 * `efforts` is null on every row for the same reason: nobody asked, so nobody
 * knows, and `chatEfforts` reads that as "offer them all" rather than as a
 * claim about the model.
 */
export const CHAT_MODEL_FALLBACK: AgentModel[] = [
  {
    value: "default",
    label: "Default (recommended)",
    description: "Whatever your claude is configured to use",
    efforts: null,
    isFavorite: true,
    order: 1,
  },
  {
    value: "opus",
    label: "Opus",
    description: "Frontier intelligence and deep reasoning",
    efforts: null,
    order: 2,
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Balanced speed and intelligence for daily tasks",
    efforts: null,
    order: 3,
  },
  {
    value: "haiku",
    label: "Haiku",
    description: "Fastest response time for lightweight tasks",
    efforts: null,
    order: 4,
  },
]

/**
 * The effort levels to offer over one model.
 *
 * Both sides of the same ignorance: a model this app has no row for — a chat
 * carrying a `--model` from a newer build, or a fallback row whose levels nobody
 * could ask about — gets all of them, because refusing a level the CLI would
 * have taken is worse than offering one it will not. Only a model the CLI
 * actually said takes none gets none, and that is what takes the picker away.
 */
export function chatEfforts(
  models: AgentModel[],
  model: string | null
): ChatEffort[] {
  const found = models.find((entry) => entry.value === model)
  return found?.efforts ?? [...CHAT_EFFORTS]
}

/**
 * How much a turn in this chat may do.
 *
 * `plan` and `read` are read-only, `edits` is what a chat opens on, `full` asks
 * nothing at all, and `ask` is the one that stops and puts the question on
 * screen. See `PERMISSIONS` in `main/worktree-chat.ts` for what each one
 * actually runs as.
 *
 * `ask` was impossible until the turn moved to the agent SDK: a `claude -p`
 * had nobody to answer a prompt, so a mode that ended by asking was a turn
 * that stalled. It is the reason the rest of this list is shaped the way it
 * is — four ways to decide up front, because deciding later could not be done.
 *
 * Ordered from least to most, which is the order the menu draws them in; `ask`
 * sits between the read-only pair and `edits`, since a turn that has to ask is
 * doing less on its own than one that does not.
 */
export const CHAT_PERMISSIONS = [
  "plan",
  "read",
  "ask",
  "edits",
  "full",
] as const

export type ChatPermission = (typeof CHAT_PERMISSIONS)[number]

/**
 * A named `CLAUDE_CONFIG_DIR` — a separate login, settings and conversation
 * history for the user's own `claude`, the way pointing that variable at a
 * different directory already lets somebody run several identities from one
 * install (`~/.claude-group/<name>`, say, instead of the default `~/.claude`).
 *
 * Kept as a workspace-wide list rather than a single setting because the point
 * is *choosing between* identities per chat — see `WorktreeChatOptions.profileId`
 * — the same reason `HttpEnvironment` is a list and not one active host.
 */
export type ClaudeProfile = {
  id: string
  name: string
  /**
   * The absolute path handed to `claude` as `CLAUDE_CONFIG_DIR`.
   *
   * **Chosen by main, not by whoever added the profile** — a directory under
   * this app's own data directory, named after the profile
   * (`main/claude-profiles.ts`), created by the login that first needs it. It
   * used to be a text field, and what that cost is in `docs/design.md`.
   *
   * So a profile arrives from the renderer with this **empty** and comes back
   * from `saveClaudeProfiles` with it filled in. Empty here is never the
   * default login — that is `profileId: null` on a chat, and the empty string
   * only means "no `CLAUDE_CONFIG_DIR`" where `claudeAccount` and `claudeLogin`
   * take one directly.
   *
   * A path already stored is left alone whatever shape it is in, including the
   * `~/…` ones the field used to accept: main expands a leading `~` the way
   * `addFolder` does, since the SDK spawns `claude` with no shell in between to
   * do it.
   */
  configDir: string
}

/**
 * Whether a profile's directory is actually signed in, and as whom — what
 * Settings › Claude draws beside each row, and the one thing a list of paths
 * cannot say for itself.
 *
 * A directory is a weak thing to name an identity with: it can be a typo, it
 * can be one somebody logged out of, and on macOS it can name an account whose
 * token lives in a keychain that no longer has it. So this is asked of `claude`
 * itself (`main/claude-auth.ts`) rather than parsed out of the CLI's own files.
 */
export type ClaudeAccount = {
  /** The directory asked about, `~` expanded — empty for the default login. */
  configDir: string
  /**
   * `missing` is the directory not existing, kept apart from `signedOut`
   * because it is the typo case and its fix is different; `error` is this app
   * failing to ask at all, and carries the CLI's own sentence.
   */
  state: "signedIn" | "signedOut" | "missing" | "error"
  email: string | null
  organization: string | null
  /** `claude.ai`, `apiKey`, … — the CLI's own word for how it authenticates. */
  method: string | null
  /** The subscription, when there is one: `team`, `max`, `pro`. */
  plan: string | null
  error: string | null
}

/**
 * What a chat's own toolbar decides, held per chat.
 *
 * Per chat rather than per workspace because that is the unit somebody thinks
 * in: the checkout being refactored wants Opus at `max`, and the chat asking
 * where a function is called wants Haiku at `low`. The composer writes them
 * straight to the record, so a chat reopened after a restart is on the footing
 * it was left on.
 *
 * Whole rather than a patch, everywhere it is passed: three fields written at
 * once cannot half-arrive, and a `null` here means "whatever the user's own
 * `claude` does" rather than "unchanged".
 */
export type WorktreeChatOptions = {
  /** `--model`, or null for whichever model that `claude` is configured on. */
  model: string | null
  /** `--effort`, or null for the CLI's own default. */
  effort: ChatEffort | null
  /**
   * How much this chat's turns may do without being asked.
   *
   * One control rather than two: a plan toggle beside a permission picker is
   * two answers to one question, and "plan, with full access" is a state
   * neither of them meant. Read through `chatOptions` rather than off the
   * record, which is where the toggle this replaced is migrated.
   */
  permission: ChatPermission
  /**
   * Which `ClaudeProfile` this chat's turns run under, by id — or null for the
   * account the user's own `claude` is already signed into.
   *
   * A profile named here that no longer exists (deleted in Settings since the
   * chat last ran) reads the same as null: `worktree-chat.ts` looks it up by
   * id at send time and falls back rather than failing a turn over a picker
   * choice that outlived the thing it pointed at.
   */
  profileId?: string | null
  /**
   * The plan toggle this replaced, on records written before the picker.
   *
   * Kept only to be read: `chatOptions` turns a `true` here into
   * `permission: "plan"` and drops the field, so a chat left in plan mode
   * before an update comes back in it. Never written.
   */
  plan?: boolean
}

/**
 * What a new chat opens on.
 *
 * **`default` rather than null**, which is the one of these three that changed
 * and the reason it did: null passes no `--model` at all, so the turn runs on
 * whatever `~/.claude/settings.json` says — and somebody who set `"model":
 * "opus"` for their terminal had every chat in this app on Opus with nothing on
 * screen saying so. `default` is the CLI's own first row, which is the model it
 * recommends for the account; a chat that genuinely wants the global setting
 * can still pick `Inherit` and get null back.
 *
 * `effort` is `DEFAULT_CHAT_EFFORT` rather than null, and that is the one of
 * these that changed most recently — see the constant.
 */
export const DEFAULT_CHAT_OPTIONS: WorktreeChatOptions = {
  model: "default",
  effort: DEFAULT_CHAT_EFFORT,
  permission: "edits",
  profileId: null,
}

/**
 * A record's options as the app uses them — defaults filled in, `plan`
 * migrated, and never the legacy field.
 *
 * One function on both sides of the contract rather than a `??` per caller:
 * main builds an argument list out of these and the composer draws them, and a
 * chat whose toolbar says one thing while its turn runs as another is the one
 * failure worth writing a function to make impossible.
 */
export function chatOptions(
  options?: WorktreeChatOptions | null
): WorktreeChatOptions {
  if (!options) return DEFAULT_CHAT_OPTIONS
  return {
    model: options.model ?? null,
    // A null is a chat written before the picker named its levels, or one
    // parked on a model that takes none — both read as the default rather than
    // as "no answer", so the toolbar always has a level to tick. See
    // `DEFAULT_CHAT_EFFORT`. Not for `Inherit`, which is the one row that means
    // "whatever your own `claude` is set to": naming a level under it would
    // override the setting it exists to defer to.
    effort:
      options.effort ?? (options.model == null ? null : DEFAULT_CHAT_EFFORT),
    permission: readPermission(options),
    profileId: options.profileId ?? null,
  }
}

/**
 * The mode a record is on, as one of the four this build knows.
 *
 * Checked against the list rather than trusted, because these come off disk:
 * a chat written by a newer build names a mode nothing here has heard of, and
 * both sides would then draw a blank label over a turn assembled from
 * `undefined`. Falling back to the default is the one answer that is safe in
 * both directions — it is the least a chat can be on that is still useful.
 */
function readPermission(options: WorktreeChatOptions): ChatPermission {
  if (options.permission && CHAT_PERMISSIONS.includes(options.permission)) {
    return options.permission
  }
  // The toggle this replaced, on a record older than the picker.
  if (options.plan) return "plan"
  return DEFAULT_CHAT_OPTIONS.permission
}

/**
 * Where a chat runs: a project's own working tree.
 *
 * A record rather than a bare id because it is the shape everything about a
 * *place* is passed as — the dock's shells, `FileRoot`, a chat's own record —
 * and it was a pair while `git worktree` checkouts existed beside the project.
 * That whole layer is gone, and what is left is the project itself.
 */
export type ChatPlace = {
  folderId: string
}

/**
 * A chat that has been on screen for a while, being written down for the first
 * time — see `createWorktreeChat`.
 *
 * Everything here is something that can have happened to a tab before its first
 * message: the toolbar moved, `/rename` was typed. Without them, writing the
 * chat down at the first message would be the moment it quietly forgot what it
 * had been set to.
 */
export type ChatSeed = {
  /** The id the tab has been using, which is also the CLI's session id. */
  id: string
  /** `"Untitled"` unless the tab was named before anything was said in it. */
  title?: string
  options?: WorktreeChatOptions
}

/**
 * The place a record names, as the id everything keyed by place uses.
 *
 * Read through this rather than off the field, the way `chatOptions` is: a chat
 * written while chats lived in `git worktree` checkouts has a `worktreeId` and
 * may have no `folderId` at all, and there is nowhere left for it to run. Null
 * is what that reads as, and the listing drops it.
 */
export function chatRootId(chat: { folderId?: string }): string | null {
  return chat.folderId ?? null
}

export type WorktreeChat = {
  id: string
  /**
   * The project it belongs to, and the directory its turns run in.
   *
   * Optional because it was added after the record was, like `started`: a chat
   * written while chats lived in a `git worktree` checkout has only the
   * checkout's id, which names nothing now. Read it through `chatRootId`, which
   * is null for exactly those.
   */
  folderId?: string
  /** The first thing asked, shortened — `"Untitled"` until there is one. */
  title: string
  /**
   * Whether the CLI has been started on this id yet.
   *
   * On the record rather than in memory, because the CLI's own session outlives
   * this app's run: `id` is the session id, so a chat sent to before a restart
   * has to come back as `--resume`. Held in a `Set` at first, which was empty
   * again on every launch — the next message re-offered `--session-id` and the
   * CLI refused it as already in use, which is a chat that can never be
   * continued.
   *
   * Optional because it was added after the record was: a chat written before
   * this has no field, and `undefined` reads as "not started" — the wrong way
   * round for one that was, but only for one turn, and `--session-id` on a used
   * id fails loudly where `--resume` on an unused one fails just as loudly.
   */
  started?: boolean
  /**
   * The `CLAUDE_CONFIG_DIR`s the CLI has this session in, `""` for the default.
   *
   * `started` alone is the wrong question, because a session is a file under
   * *one* account's config directory: a chat started on one profile and
   * continued on another was resumed against a directory that has never heard of
   * the id, and the CLI answered `No conversation found with session ID`. Which
   * profile a chat is on is the toolbar's to change mid-conversation, so this
   * has to be a list rather than the one directory it started in.
   *
   * Optional like `started`, and read together with it: a chat written before
   * this field has no list, and `started === true` is then all there is to go
   * on — resume, the way it always did, and let `isSessionMissing` in
   * `worktree-chat.ts` catch the profile that never had it.
   */
  startedIn?: string[]
  /**
   * The model, effort and permission this chat is on.
   *
   * Optional for the same reason `started` is: a chat written before the
   * toolbar existed has no field, and a missing one reads as
   * `DEFAULT_CHAT_OPTIONS` — which is exactly how those turns already ran.
   * Read it through `chatOptions`, never directly.
   */
  options?: WorktreeChatOptions
  createdAt: string
  updatedAt: string
}

/** One of those events, tagged with the chat it belongs to: several chats can
 * be answering at once, so a listener has to know which one this is. */
export type WorktreeChatEvent = AssistantEvent & { chatId: string }

/**
 * What one chat did, folded out of its lines — the two questions asked *about* a
 * conversation rather than inside it.
 *
 * One shape for both because they are one read. The lines are the expensive part
 * — a chat's transcript is a file, and there is one per chat — so a call that
 * answered "which files did this touch" and a second that answered "what did it
 * cost" would read the same files twice on the same tick.
 *
 * Computed in main and never written down: it is a fold of what is already on
 * disk, and a stored copy would be a second account of the transcript able to
 * disagree with it. `main/chat-digest.ts` is the fold, and says what it can and
 * cannot see.
 */
export type ChatDigest = {
  chatId: string
  /** The project it belongs to, or null for a chat whose folder is gone —
   * `chatRootId` on the record. Carried so a caller can group by project
   * without reading the listing a second time. */
  folderId: string | null
  /**
   * The files its edits named, absolute, in the order they were first written
   * to.
   *
   * **What an edit tool said it was about**, which is not the same as what the
   * turn changed: a file rewritten by a `Bash` line (`sed -i`, `mv`, a
   * formatter, a build) is not here, because nothing in the transcript says it
   * was. So this narrows a list of changed files to the ones a chat can be
   * shown to have touched; it never claims the rest were somebody else's.
   */
  paths: string[]
  /** What its turns were billed, in USD, summed over the lines that carry a
   * figure. Turns that reported none contribute nothing rather than zero — see
   * `unpriced`. */
  costUsd: number
  /** How many turns are in it, and how many of those had no cost on them: a
   * chat read back from before that field existed is a chat with nothing to say
   * about what it cost, not one that was free. */
  turns: number
  unpriced: number
}

/*
 * Searching what was *said* in a chat is not in this contract, and that is the
 * shape of the feature rather than an omission: it is asked of the conversation
 * on screen, whose lines the renderer already holds — see
 * `lib/worktree-chat/search.ts`. A search of every chat would have been a walk
 * of every transcript on disk per keystroke, and a channel to carry it.
 */

/**
 * What one read-only turn came back with — see `draftCommitMessage` and
 * `main/one-turn-agent.ts`.
 *
 * A union rather than a nullable string, because the failure has to be shown:
 * the button is pressed and something has to appear, and "nothing happened" is
 * the one answer nobody can act on. The error is whatever the CLI said, drawn
 * where the answer would have gone rather than written anywhere.
 */
export type AgentTurnAnswer = { text: string } | { error: string }

/** What `distillLearnings` came back with. An empty list is a real answer —
 * the chat taught nothing worth keeping — and the dialog says it as one. The
 * proposal type itself lives in `shared/learnings.ts` with the parsing and the
 * file shapes, which is also where the argument for the feature is. */
export type DistillAnswer =
  { proposals: LearningProposal[] } | { error: string }

/** What `saveLearning` came back with: the path written, relative to the
 * project, for the dialog to show — or the refusal, which is an answer too
 * (`A skill named … already exists.`). */
export type SaveLearningAnswer = { path: string } | { error: string }

/**
 * Which file a thread's line numbers are in.
 *
 * `new` is the working file — the diff's right-hand side, and every kept or
 * added line. `old` is the commit, which is where a deleted line still exists:
 * in the unified diff those rows are the merge extension's block widgets, and in
 * the split one they are the left-hand editor.
 */
export type ReviewSide = "new" | "old"

/** A run of one file's lines, inclusive of both ends. A single line is
 * `fromLine === toLine`. */
export type LineRange = { fromLine: number; toLine: number }

/**
 * What one comment is about, in one or both files.
 *
 * At least one of the two is set — an anchor naming nothing is not a comment.
 * Both being set is a remark about a hunk: these lines went, those replaced
 * them, and the opinion is about the swap rather than about either half.
 *
 * Two ranges rather than a list of rows, which is what a truly faithful record of
 * a selection would be. A diff's rows are contiguous per side within any
 * selection somebody can make by dragging, so the extremes are the whole of it,
 * and two pairs of numbers is what a heading and a `Read` call can both use.
 */
export type ReviewAnchor = {
  /** Lines of the committed file — what the change removed. */
  old: LineRange | null
  /** Lines of the working file — kept, or added. */
  new: LineRange | null
}

/**
 * The lines an anchor quoted, per side, as they read when the thread was opened.
 *
 * Kept apart rather than run together, because the two are lines of different
 * files and a reader — human or model — that could not tell which was which
 * would be reading a diff with the signs rubbed off.
 */
export type ReviewSnippet = {
  old: string | null
  new: string | null
}

/** One thing said in a thread. */
export type ReviewNote = {
  id: string
  body: string
}

/**
 * A range of a diff's lines, and the conversation about it.
 *
 * **Written to disk**, in `REVIEW_FILE` — which is why these types are in the
 * contract rather than in the renderer that draws them. A review used to be a
 * sitting: nothing was kept, on the argument that what a review was *for* was
 * the chat at the end of it. There is no chat at the end any more, so there was
 * nothing keeping it. `docs/design.md` § Changes has the reversal.
 */
export type ReviewThread = {
  id: string
  /** `FileRoot.id`: the checkout this review is of. */
  rootId: string
  /** Absolute, as every path in the Explorer is. */
  path: string
  /** Which lines of which of the two files — see `ReviewAnchor`. */
  anchor: ReviewAnchor
  /**
   * The lines as they read when the thread was opened.
   *
   * Kept rather than resolved when it is read back, and that is deliberate
   * twice over. It is what an agent is told the reviewer was looking at — lines
   * move, and a snippet read later would quote something the remark was never
   * about. And now that a thread outlives the app, it is the thread's **real**
   * address: `settle` in `lib/files/review.ts` finds these lines again in the
   * file and puts the comment back on them, or says the code has gone.
   *
   * Capped, so a comment on a 400-line block is still a prompt.
   */
  snippet: ReviewSnippet
  /** At least one, oldest first: a thread is opened by something being said. */
  notes: ReviewNote[]
  /**
   * Whether the lines this was written about are still findable in the file.
   *
   * Absent on a thread that has not been checked, and on every thread written
   * before there was anything to check — a review kept across a restart is read
   * back against a file that has moved on, and `settle` sets this when the
   * snippet is nowhere to be found. Drawn as *outdated* rather than deleted: a
   * remark whose code has gone is still something somebody said, and quietly
   * dropping it would be this app deciding a review was finished.
   */
  stale?: boolean
  /**
   * Whether this conversation has been settled — a forge's *Resolve
   * conversation*, and the same bargain.
   *
   * **Absent is open**, so every thread written before there was such a thing
   * reads as one, and nothing on disk needs migrating. Resolving neither deletes
   * the thread nor moves it: it is drawn collapsed on its own lines, still
   * openable, still repliable — a remark somebody dealt with is the record of
   * how it was dealt with, which is the whole reason a forge keeps it. What it
   * *does* buy is the count: the bar and the Changes list count the threads
   * still asking for something, so a diff worked through reads as done.
   */
  resolved?: boolean
}

/**
 * The hues a board column can be marked with.
 *
 * Ids and not classes: what a record on disk holds is which of a fixed set was
 * picked, and the two class strings that draws as belong to the renderer
 * (`lib/board/tones.ts`) — the same split `GitFileState` has from `GIT_TONES`. A
 * fixed set rather than a colour picker, so that every board in the app is drawn
 * from one palette that has been checked in both themes.
 */
export type BoardTone =
  "slate" | "blue" | "violet" | "amber" | "emerald" | "rose"

/** Them in the order the picker offers them. */
export const BOARD_TONE_IDS: BoardTone[] = [
  "slate",
  "blue",
  "violet",
  "amber",
  "emerald",
  "rose",
]

/**
 * How urgent a card is, or nothing.
 *
 * Three and not five, because the only thing a priority on a personal board is
 * read for is which card to pick up next, and a scale nobody can rank
 * consistently is a field that stops being maintained. **Absent is the
 * default** rather than `medium`: a board where every card claims a priority is
 * a board where the field says nothing, so it is set on the few that need it.
 */
export type BoardPriority = "low" | "medium" | "high"

/** Them in the order the picker offers them — loudest first, which is the order
 * they are worth scanning in. */
export const BOARD_PRIORITY_IDS: BoardPriority[] = ["high", "medium", "low"]

/**
 * One column of one project's board.
 *
 * **A record rather than a union**, which is what it was: `Todo` / `Doing` /
 * `Done` were fixed and not the user's to name, on the argument that a board
 * answers one question and every added column asks a second. That was wrong for
 * the way people actually keep a board — `Blocked` and `Review` are the two
 * every real one grows — so columns are the project's own to add, rename,
 * recolour and reorder. `docs/design.md` § Board carries the reversal.
 *
 * Per project, like the cards: two projects have nothing to say to each other
 * about what their stages are called.
 *
 * Order is **order in the list**, the way a card's is — one write for a
 * reordering, and no `order` field to keep dense.
 */
export type BoardColumn = {
  id: string
  folderId: string
  name: string
  tone: BoardTone
  createdAt: string
  updatedAt: string
}

/**
 * What a project's board starts as, seeded the first time one is opened.
 *
 * The **ids are the words**, and that is load-bearing rather than tidy: a card
 * written while the columns were a union holds `"todo"`, `"doing"` or `"done"`
 * in its `column`, and seeding these ids means such a card points at a real
 * column without a migration pass over the file.
 */
export const DEFAULT_BOARD_COLUMNS: {
  id: string
  name: string
  tone: BoardTone
}[] = [
  { id: "todo", name: "Todo", tone: "slate" },
  { id: "doing", name: "Doing", tone: "blue" },
  { id: "done", name: "Done", tone: "emerald" },
]

/**
 * One card on a project's board.
 *
 * A **project's**, like a chat and unlike a request: the thing a card is about is
 * work in one repository, and a card whose chat ran in a different one is a
 * link across two working trees that nothing in this app could draw honestly.
 * `folderId` is what makes it per project, and it is the same id a chat's
 * `folderId`, a `FileRoot.id` and the dock's shell key all are.
 *
 * Deliberately **not** the task this app used to have (see `docs/design.md`
 * § Tasks, removed): that was a container of members drawn from every panel,
 * with a crumb across the title bar and a dashboard of its own. This holds a
 * title, a line, a column, its own marks and at most one chat, and nothing
 * outside the board and that chat's own header knows it exists. What the marks
 * are and what was refused beside them — an assignee, comments, attachments —
 * is `docs/design.md` § Board.
 *
 * The whole collection is one file and one save — a card is small and bounded,
 * so there is no body to keep out of the list, and **order within the list is order within the column**, which is
 * what makes a drag one write.
 */
export type BoardCard = {
  id: string
  /** The project it belongs to. */
  folderId: string
  /**
   * Which column it is in — a `BoardColumn.id`, and a plain string here.
   *
   * Not narrowed to the ids that exist, because they are the user's now: a card
   * can name a column that has been deleted from under it (nothing rewrites
   * cards on a delete), and `cardsOf` in `lib/board/cards.ts` files such a card
   * into the first column rather than losing it. Cards written while the columns
   * were a fixed union hold `"todo"`, `"doing"` or `"done"`, which are exactly
   * the ids `DEFAULT_BOARD_COLUMNS` seeds.
   */
  column: string
  title: string
  /** One line about it, or empty. */
  body: string
  /**
   * The chat this card's work is happening in, or null.
   *
   * Never trusted to still name one: a chat can be deleted from under it, and
   * the card is not the place that owns the conversation. Read it through
   * `linkedChat` in `lib/board/cards.ts`, which is null for a chat that has
   * gone — the `chatRootId` idiom, and for the same reason.
   */
  chatId: string | null
  /**
   * Free labels, in the order they were typed.
   *
   * **Text and not records**, unlike the columns: a tag is written by typing it
   * and there is nothing else about one to keep — no rename, no palette, no
   * listing to maintain — so a tag store would be a second file to keep in
   * agreement with the cards for no answer either could give alone. The hue is
   * derived from the text (`tagTone` in `lib/board/tones.ts`), which is what
   * makes the same word the same colour on every card without anything
   * remembering that it is.
   *
   * Optional, because every card written before this field existed is on
   * somebody's disk without it — read through `tagsOf`, never directly.
   */
  tags?: string[]
  /** How urgent, or absent for the ordinary case. Read through `priorityOf`. */
  priority?: BoardPriority | null
  /**
   * The day it is due as `YYYY-MM-DD`, or absent.
   *
   * A **day** and not an instant, which is why this is not the ISO timestamp
   * every other date in this app is: a due date rendered from an instant is a
   * day earlier or later depending on the reader's offset, and a board that
   * says a card is overdue because the machine woke up in another timezone is
   * a board that cannot be trusted. Read through `dueOf`.
   */
  due?: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The language a fenced block carries when it holds a drawing.
 *
 * A drawing is a scene of shapes and images, which markdown has no syntax for,
 * so the document keeps only the id and the scene lives in its own file. A
 * fence is what that id travels in: it round-trips through any markdown parser
 * untouched, and a plain reader sees a short code block rather than a wall of
 * JSON. Shared because the renderer writes these and the store keeps the files
 * behind them.
 */
export const DRAWING_LANGUAGE = "drawing"

/**
 * One block of a block document — BlockNote's own model, as it is on disk.
 *
 * Deliberately structural rather than BlockNote's `Block`: everything that
 * walks a document does so without caring what is in it, and `Block` carries
 * the schema's three type parameters through every signature it touches.
 *
 * Here rather than beside the renderer's walk over it because the main process
 * read the same file while the note preview server existed. It does not cross a
 * channel; it is the shape of a file on disk, and `.note` files in the
 * workspace's folders are still written in it.
 */
export type NoteBlock = {
  id?: string
  type?: string
  props?: Record<string, unknown>
  content?: unknown
  children?: NoteBlock[]
}

/**
 * The machine's headroom, and this app's share of it, over the interval since
 * the previous reading.
 *
 * Memory is bytes and CPU is a percentage of the whole machine — every core
 * counted, so a single pinned core on a ten-core machine is 10%. Both of the
 * app's own figures are the sum over every process Electron runs, not just the
 * main one; neither counts the agent and shell sessions, which are children of
 * the pty daemon rather than of this app.
 */
export type SystemUsage = {
  /** How busy the machine's cores were, 0–100. */
  cpuPercent: number
  cores: number
  /** Physical memory, in bytes. */
  memoryTotal: number
  /**
   * What the kernel would hand out on demand — free pages plus the cache it
   * would evict for the asking, not free pages alone. See
   * `electron/system-usage.ts` for why the difference matters on macOS.
   */
  memoryAvailable: number
  /** This app's CPU, on the same all-cores scale as `cpuPercent`. */
  appCpuPercent: number
  /** The same figure as a percentage of one core, which is what Activity
   * Monitor and `top` show — it exceeds 100 for a busy multi-threaded app. */
  appCoreCpuPercent: number
  /** Resident memory across every process the app runs, in bytes. */
  appMemory: number
  appProcesses: number
}

/**
 * What `window.desktop` exposes. Every *method* is asynchronous because each
 * one crosses the IPC boundary; the handful of plain values are constants
 * captured in the preload.
 */
export type DesktopApi = {
  /** The host platform, for the few places the shell has to differ — the
   * window's title bar being one. */
  platform: "darwin" | "win32" | "linux"

  /** The workspace and the folders in it. Always resolves: a first run gets
   * an empty default workspace rather than nothing. */
  getWorkspace: () => Promise<WorkspaceRecord>
  /**
   * Points the workspace at an existing folder, worked on where it already is.
   *
   * Nothing is copied and nothing is written into it. Resolves with the whole
   * workspace rather than the new folder alone, so the renderer never has to
   * splice a list the main process just rewrote.
   */
  addFolder: (input: { path: string; name: string }) => Promise<WorkspaceRecord>
  renameFolder: (id: string, name: string) => Promise<WorkspaceRecord>
  /**
   * Drops a folder from the workspace. The directory itself is untouched —
   * what goes is the studio's record of it, which is all the studio ever had.
   */
  removeFolder: (id: string) => Promise<WorkspaceRecord>

  /** Opens a folder picker and resolves with the chosen path, or null. */
  pickDirectory: () => Promise<string | null>

  /** Opens a file picker scoped to images and resolves with the chosen
   * paths — empty when the user cancels. For the agent chat composer's
   * attach button. */
  pickImages: () => Promise<string[]>
  /**
   * Files, chosen in the OS picker and handed back as absolute paths.
   *
   * `directory` only says where the dialog opens — the paths come back from the
   * user's own click, so this is not a read and nothing is gated on it. Reading
   * one is still an ordinary `files:*` call and still inside `insideAny`.
   */
  pickFiles: (directory?: string) => Promise<string[]>
  /**
   * The real path behind a dropped/selected `File`, for the same composer's
   * drag-and-drop — a sandboxed, context-isolated renderer never gets one on
   * the `File` object itself. Unlike everything else here, this never
   * crosses into the main process: it runs entirely in the preload script,
   * which is where Electron's `webUtils.getPathForFile` must be called from.
   */
  getPathForFile: (file: File) => string
  /**
   * An image's bytes as a data URL, for the same composer's thumbnails.
   * The renderer's own origin (`app://studio`, or the dev server) is not
   * `file://`, and Chromium refuses to load a `file://` subresource from any
   * other origin — so the only way to preview a dropped/picked image is to
   * read it here and hand back bytes the `<img>` tag can use directly.
   */
  readImageDataUrl: (path: string) => Promise<string>
  /**
   * The image on the system clipboard, written to a temp file, as a path —
   * or null when the clipboard holds no image.
   *
   * For pasting a screenshot into a terminal, where the pty is a byte stream
   * in another process and a path is the only thing an image can be said in.
   * A file copied in Finder needs none of this: it has a path already, and
   * `getPathForFile` hands it over without a copy. This is the other case,
   * where the bytes exist nowhere but the clipboard.
   */
  clipboardImagePath: () => Promise<string | null>

  /** Subscribes to the File menu. Returns an unsubscribe function. */
  onMenuCommand: (listener: (command: MenuCommand) => void) => () => void

  /** The branch checked out in a folder, or null when it is not a git
   * repository. */
  gitBranch: (folderId: string) => Promise<string | null>
  /**
   * What git says about the files in a folder — for the colours Explorer draws
   * its rows in, and the `deleted` on a tab whose file has gone.
   *
   * Empty for a folder that is not a repository, which is an answer and not a
   * failure. Capped at `MAX_STATUS_ENTRIES`; see `main/git.ts` for why a
   * wholly untracked or ignored directory arrives as one entry rather than as
   * its contents.
   */
  gitStatus: (folderId: string) => Promise<GitStatusEntry[]>

  /**
   * What has changed in one folder, as a list.
   *
   * Ignored paths are left out — see `GitChange`.
   */
  gitChanges: (folderId: string) => Promise<GitChange[]>

  /**
   * The three writes the Changes list makes — `git add`, its undo, and
   * throwing the work away.
   *
   * Paths are absolute, one call takes many, and every one of them is checked
   * against the workspace's folders on the way in, like every `files:*` call:
   * these write to somebody's repository, and the case worth defending against
   * is the one where the renderer is wrong.
   *
   * `gitCommit` is the fourth now, and the reversal is recorded on `commit` in
   * `main/git.ts` and in `docs/design.md` § Committing. What is still refused is
   * everything past it: no amend, no log, no branch, no push.
   */
  gitStage: (folderId: string, paths: string[]) => Promise<void>
  gitUnstage: (folderId: string, paths: string[]) => Promise<void>
  /**
   * Back to `HEAD`, index and working tree both — see `discard` in
   * `main/git.ts` for why it is not "the working tree back to the index".
   *
   * A file `HEAD` does not have is moved to the trash rather than unlinked, the
   * same way the Explorer's Delete works: the studio has no undo of its own.
   */
  gitDiscard: (folderId: string, paths: string[]) => Promise<void>
  /** The same, for everything the folder has changed. */
  gitDiscardAll: (folderId: string) => Promise<void>
  /**
   * Commits what is staged, and answers with the commit that was written.
   *
   * **Rejects** rather than answering with an error, unlike the drafted
   * message: git's own message is what a refusal has to say — nothing staged, no
   * identity configured, a `pre-commit` hook that said no — and the pane draws
   * it as it came.
   */
  gitCommit: (
    folderId: string,
    message: string
  ) => Promise<{ sha: string; subject: string }>
  /**
   * A commit message for what is staged, drafted by the read-only `claude`.
   *
   * The same shape as `distillLearnings` and for the same reasons — the same
   * three settings, and an answer either way rather than a rejection: a draft
   * that did not arrive leaves the box as it was. What comes back goes into an
   * editable field, never straight into a commit.
   */
  draftCommitMessage: (
    folderId: string,
    model: string | null,
    effort: ChatEffort | null,
    profileId: string | null
  ) => Promise<AgentTurnAnswer>

  /**
   * The committed side of a diff and git's own patch for it — see `FileDiff`.
   *
   * Takes the path rather than a root and a relative path, like every other read
   * of a file in the workspace, and is gated the same way.
   */
  fileDiff: (filePath: string) => Promise<FileDiff>

  getSetting: (key: string) => Promise<string | null>
  setSetting: (key: string, value: string) => Promise<void>

  /**
   * The Explorer's reads and writes, over the workspace's own folders.
   *
   * Every one of these takes an absolute path and is refused unless that path
   * is inside a folder the workspace has been added — see `insideAny` in
   * `main/files.ts`. That check is the reason these are a set of narrow calls
   * rather than a "run this fs operation" pair: the main process has to be able
   * to say what each one is allowed to touch.
   */
  listDirectory: (dirPath: string) => Promise<FileEntry[]>
  /** A file's text, or why there is none to show. */
  readTextFile: (filePath: string) => Promise<FileContent>
  writeTextFile: (filePath: string, text: string) => Promise<void>
  /** Both resolve to the new thing's absolute path, which is what the tree
   * selects and the strip opens. */
  createFile: (dirPath: string, name: string) => Promise<string>
  createDirectory: (dirPath: string, name: string) => Promise<string>
  /** Renames in place — a name, not a path, so this can never be a move out of
   * the workspace. Resolves to the new path. */
  renamePath: (target: string, name: string) => Promise<string>
  /** To the system trash, not `unlink`: this is somebody's source file, and the
   * OS already has the undo for it. */
  trashPath: (target: string) => Promise<void>
  /** Shows it in Finder/Explorer/the desktop's file manager. */
  revealPath: (target: string) => Promise<void>
  /**
   * An image in the workspace, as a `data:` URL the pane can draw.
   *
   * Bytes rather than a path because the renderer is not on a `file://` origin
   * and Chromium will not load a `file://` subresource from any other one —
   * the same reason the chat composer's attachments are read this way. This is
   * the checked twin of `readImageDataUrl`: that one takes a path from a
   * system picker, this one takes a path from the tree and so is held to the
   * workspace's folders like every other `files:*` call.
   */
  readImageFile: (filePath: string) => Promise<string>
  /**
   * A picture next to a document, as a `data:` URL.
   *
   * The markdown preview's `./logo.png` — a relative URL a browser has no base
   * to resolve against. `dir` is the directory of the document that named it;
   * main joins the two, since the renderer never builds a path, and the join
   * is held to the workspace's folders like the path in `readImageFile`.
   */
  readImageRelative: (dir: string, relative: string) => Promise<string>
  /**
   * The TypeScript server's answers, for the editor's tooltips and its
   * go-to-definition.
   *
   * A real `tsserver` in the main process — the folder's own copy where it has
   * one — because nothing in the renderer can see past the file in front of it
   * and can therefore say nothing about an import. See `main/tsserver.ts`.
   *
   * The three sync calls are how it learns what is in the editor rather than
   * what is on disk: without them a hover would answer for the last saved
   * version, at positions that no longer line up with what is on screen.
   */
  tsOpen: (filePath: string, text: string) => Promise<void>
  tsChange: (filePath: string, text: string) => Promise<void>
  tsClose: (filePath: string) => Promise<void>
  /** Both take 1-based line and column, which is what tsserver counts in — the
   * editor converts (`placeOf` in `lib/files/typescript.ts`), since CodeMirror
   * addresses a document by offset. Null and empty rather than an error for
   * "nothing here". */
  tsHover: (
    filePath: string,
    line: number,
    column: number
  ) => Promise<TsHover | null>
  tsDefinition: (
    filePath: string,
    line: number,
    column: number
  ) => Promise<TsDefinition[]>

  /**
   * Every file in the workspace, for the search palette.
   *
   * A walk, not a read, and the only call here that is: `⌘P` has to answer for
   * files nothing has opened a directory of yet. Build directories are skipped
   * (`IGNORED_DIRECTORIES`) and the result is capped (`MAX_INDEXED_FILES`) —
   * the tree remains the way to anything past either line. Nothing caches it in
   * the main process; the renderer asks once and holds it for the run.
   */
  listWorkspaceFiles: () => Promise<FileIndexEntry[]>

  /**
   * The directories the tree wants told about — every folder it has open, as
   * one set that replaces whatever was being watched before.
   *
   * The whole set rather than a watch/unwatch pair because the renderer already
   * holds it: `expanded` is what is on screen, and a call that says "these" can
   * never leave the main process watching a folder that was collapsed while a
   * message was in flight. Anything outside the workspace's folders is dropped
   * on arrival, like every other `files:*` call, and each folder's own `.git`
   * is added to whatever is sent — a commit changes every colour in the tree
   * and no directory the tree has open.
   */
  watchDirectories: (dirs: string[]) => Promise<void>
  /** Subscribes to those directories changing. Returns an unsubscribe
   * function. */
  onDirectoryChanged: (listener: (event: DirectoryChange) => void) => () => void

  /**
   * The models the user's own `claude` offers, for the composer's picker.
   *
   * Asked of the CLI over the agent SDK's control channel rather than being a
   * list in the contract — see `AgentModel`. It costs a `claude` process and no
   * tokens, and main holds the answer for the run, so a renderer may call it as
   * often as a picker opens. Empty where the CLI could not be asked, which is
   * the picker's cue to draw `CHAT_MODEL_FALLBACK`.
   */
  agentModels: () => Promise<AgentModel[]>
  /**
   * The slash commands that same `claude` has in a project's directory, for the
   * composer's `/` menu — what pressing `/` in the CLI lists.
   *
   * `folderId` because a command set is per directory: a repository's own
   * `.claude/commands/` and its skills are only there. Null, or a project that
   * has left the workspace, asks in the user's home directory, which is the
   * user-scope half and nothing repository-specific.
   *
   * **Held per directory for the run**, unlike `installedMcpServers`: a menu
   * opening is not a reason to spawn a process, and `/reload-skills` exists
   * precisely because the CLI's own list does not move under a live session
   * either. A failure is not cached, so a CLI that was missing at launch is
   * found once it is installed.
   */
  agentCommands: (folderId: string | null) => Promise<AgentCommandListing>
  /**
   * The MCP servers the user's own `claude` has in a project's directory, for
   * the MCP section of Settings — what `/mcp` in the CLI lists.
   *
   * Asked of the CLI over the same control channel as `agentModels`, and for the
   * same reason: this app configures none of these and so has no list of its own
   * to draw. `folderId` is the project whose directory to ask in, because an MCP
   * config is per directory — a repository's own `.mcp.json` is only there. Null,
   * or a project that has left the workspace, asks in the user's home directory,
   * which is the user-scope half of the answer and nothing repository-specific.
   *
   * **Not held for the run**, unlike `agentModels`: somebody looking at this
   * listing is often looking at it because they have just run `claude mcp add`,
   * and a cached answer would be the one thing they opened it to see change. Two
   * asks for the same directory at once share the one process.
   */
  installedMcpServers: (folderId: string | null) => Promise<McpListing>
  /**
   * Removes one of those servers from the user's own `claude` config — the
   * **Remove** button on a row in Settings › MCP.
   *
   * Run as `claude mcp remove`, the CLI's own command, rather than by editing
   * `~/.claude.json` or a repository's `.mcp.json` from here: the config is the
   * CLI's, its shape moves between releases, and a hand-written edit is how two
   * writers of one file corrupt it. `scope` is passed when the listing knew one
   * (`local` / `user` / `project`) and omitted otherwise, which tells the CLI to
   * remove it from wherever it is. `folderId` is the project whose directory to
   * run in, since a `project`-scope server lives in that repository's own file.
   *
   * **There is no undo.** The caller confirms first; this does it.
   */
  removeMcpServer: (input: {
    name: string
    scope: string | null
    folderId: string | null
  }) => Promise<void>
  /**
   * The workspace's `CLAUDE_CONFIG_DIR` profiles, for the composer's picker
   * and the Claude section of Settings — see `ClaudeProfile`.
   */
  listClaudeProfiles: () => Promise<ClaudeProfile[]>
  /**
   * Replaces the whole collection: the renderer owns the list, the same way it
   * owns `HttpEnvironment`'s.
   *
   * **Answers with what was stored**, which is the one thing this list does not
   * own — a profile with no `configDir` is given one on the way in (see that
   * field), and a row cannot draw an account for a directory it does not know
   * the name of.
   */
  saveClaudeProfiles: (profiles: ClaudeProfile[]) => Promise<ClaudeProfile[]>
  /**
   * Whether one of those directories is signed in, and as whom — `claude auth
   * status` run with that `CLAUDE_CONFIG_DIR`, and with none at all for the
   * empty string, which is the account a chat with no profile picked uses.
   *
   * Asked per directory rather than for the whole list, so a row rechecked
   * after a `claude login` in a terminal costs one process and not one per
   * profile. Nothing caches it: a login is exactly the thing that changes
   * while somebody is looking at this section.
   */
  claudeAccount: (configDir: string) => Promise<ClaudeAccount>
  /**
   * Signs one of those directories in: `claude auth login` in a pty of its own,
   * with that directory as `CLAUDE_CONFIG_DIR`. Resolves with the id its output
   * is tagged with — `onTerminalData`, `terminalWrite`, `terminalResize`,
   * `terminalKill` and `onTerminalExit` carry it from there, the same as a
   * shell's.
   *
   * **A pty rather than something quieter, because the login is a
   * conversation**: the CLI prints a URL, opens a browser, asks which account,
   * and can stop for an SSO prompt. Anything that hid that would be this app
   * guessing at a flow the CLI is free to change, so what the user gets is the
   * CLI's own screen — the difference from running it in a terminal is only
   * that they did not have to know which variable to export.
   *
   * The directory is **created** if it is not there, unlike `claudeAccount`,
   * which refuses to: that one probes a path somebody may still be typing, and
   * this is a login they asked for by name. The empty string is the default
   * login, and creates nothing.
   */
  claudeLogin: (
    configDir: string,
    cols: number,
    rows: number
  ) => Promise<string>
  /** Every chat in every project — the listing; the lines are read one chat
   * at a time. */
  listWorktreeChats: () => Promise<WorktreeChat[]>
  /**
   * A chat in a project's own working tree, written down.
   *
   * **Called on the first thing said in a chat, not on the `+` that opened it.**
   * The tab still appears at once — the renderer makes the chat there and holds
   * it (`unsaved` in `lib/worktree-chat/store.ts`) — but a `+` somebody thought
   * better of used to leave an `Untitled` row in the project's list and a file
   * on disk for ever, and there is nothing in an unused chat worth keeping.
   *
   * `seed` is what that tab already knows, and is absent only for a chat this
   * call is the origin of. Its `id` is not a suggestion: a chat's id **is** the
   * CLI's session id, and one minted here instead would be a different chat to
   * the one on screen.
   */
  createWorktreeChat: (
    place: ChatPlace,
    seed?: ChatSeed
  ) => Promise<WorktreeChat>
  readWorktreeChat: (id: string) => Promise<AssistantMessage[]>
  /**
   * Every chat folded to what it did — see `ChatDigest`.
   *
   * All of them in one call rather than one chat at a time, because both callers
   * want the set: the `Changes` list asks which chat touched which file in *this*
   * project, and the system bar sums what the workspace has spent. Main holds the
   * lines of any chat that has been read or is running this run, so the usual
   * answer costs no disk at all.
   */
  chatDigests: () => Promise<ChatDigest[]>
  deleteWorktreeChat: (id: string) => Promise<void>
  /**
   * Empties a chat and closes the CLI behind it — the composer's `/clear`.
   *
   * **Not `delete` plus `create`.** The chat keeps its id, its tab, its title
   * and its options: what `/clear` means in the terminal is a new context in the
   * conversation you are in, not a different conversation. A chat's id *is* the
   * CLI's session id, so the session has to go with the lines — otherwise the
   * next message would `resume` into the very context this call was asked to
   * throw away. `started` is dropped with it, which is what makes that message
   * open a session rather than resume one.
   *
   * A turn in flight is ended by the close, the way `delete` ends one.
   */
  clearWorktreeChat: (id: string) => Promise<void>
  /** What a chat is called. Its title is the first thing asked in it until
   * somebody names it, and a name is what it is found by later. An empty one is
   * ignored rather than blanking the row. */
  renameWorktreeChat: (id: string, title: string) => Promise<void>
  /**
   * The model, effort and permission for one chat.
   *
   * Its own call rather than an argument to `sendWorktreeChat`, because the
   * toolbar is used before anything is sent: somebody picks Haiku and then
   * types, and a choice that only landed with a message would be a control that
   * looks set and is not.
   */
  setWorktreeChatOptions: (
    id: string,
    options: WorktreeChatOptions
  ) => Promise<void>
  /**
   * Answers what a turn stopped to ask — see `WorktreeChatAsk`.
   *
   * Named by ask id rather than by chat, even though a chat has at most one
   * pending at a time: the card is on screen while the turn is paused, and an
   * answer that arrived for the question before it would otherwise be applied
   * to this one. An id nothing is waiting on is ignored.
   */
  answerWorktreeChatAsk: (
    askId: string,
    answer: WorktreeChatAnswer
  ) => Promise<void>
  /** Runs one turn. Rejects when that chat is still answering. */
  sendWorktreeChat: (id: string, prompt: string) => Promise<void>
  /** Kills the turn in flight. There is nothing gentler in print mode. */
  stopWorktreeChat: (id: string) => Promise<void>
  /** Every chat's events, tagged with the chat. Returns an
   * unsubscribe. */
  onWorktreeChatEvent: (
    listener: (event: WorktreeChatEvent) => void
  ) => () => void
  /**
   * A chat somebody asked to be taken to, by clicking its notification.
   *
   * The one push event on this channel that main sends on a *user's* gesture
   * rather than off the CLI's stream, and it carries no state — the renderer
   * already has the chat; what it does not have is the click, which happened in
   * the OS rather than in the window. Returns an unsubscribe.
   */
  onRevealWorktreeChat: (listener: (chatId: string) => void) => () => void

  /**
   * Every board card in every project.
   *
   * One call for the whole workspace rather than per project, the way the chat
   * listing is: the boards together are a few hundred short records, and the
   * strip has to know a project has cards before its board has ever been
   * opened.
   */
  listBoardCards: () => Promise<BoardCard[]>
  /** Replaces the whole collection — the renderer owns the list and its
   * order, the same way it owns the requests'. */
  saveBoardCards: (cards: BoardCard[]) => Promise<void>
  /**
   * What one chat taught about its project, proposed by the read-only
   * `claude` — never written. Asked for from the chat's own row, and each
   * proposal in the answer is saved or discarded by hand (`saveLearning`).
   *
   * The chat id says which transcript, the folder id says which project the
   * turn reads in — resolved on the main side, the same as a chat's own cwd.
   * `model`, `effort` and `profileId` are the draft's three, for the draft's
   * reason: it is the same second CLI.
   */
  distillLearnings: (
    chatId: string,
    folderId: string,
    model: string | null,
    effort: ChatEffort | null,
    profileId: string | null
  ) => Promise<DistillAnswer>
  /**
   * One approved proposal, written where the user's own `claude` will find it:
   * a skill under `.claude/skills/`, a memory as a bullet in `CLAUDE.md`. The
   * one write this feature makes, and only ever per press of Save — see
   * `main/learnings.ts`.
   */
  saveLearning: (
    folderId: string,
    proposal: LearningProposal
  ) => Promise<SaveLearningAnswer>

  /**
   * Every review thread in the workspace.
   *
   * One call for the lot rather than per project, the way the board's cards are:
   * the pane has to know a review exists in a file nobody has opened, and the
   * whole collection is a few dozen short records.
   */
  listReviewThreads: () => Promise<ReviewThread[]>
  /** Replaces the whole collection — the renderer owns the list and its order,
   * the same bargain the board's cards make. */
  saveReviewThreads: (threads: ReviewThread[]) => Promise<void>

  /** Every project's columns. Their own file rather than a field on a card:
   * they are renamed, recoloured and reordered without any card changing. */
  listBoardColumns: () => Promise<BoardColumn[]>
  saveBoardColumns: (columns: BoardColumn[]) => Promise<void>

  /**
   * One drawing's scene, as the text of its `.excalidraw` file — Excalidraw's
   * own format, so a scene can be opened at excalidraw.com or in the editor's
   * desktop app without this studio.
   *
   * Text rather than a parsed object: the main process only stores it, and a
   * type here would be this app's second opinion about a schema Excalidraw
   * owns. Empty for a drawing that has never been saved.
   */
  readDrawing: (id: string) => Promise<string>
  writeDrawing: (id: string, scene: string) => Promise<void>
  /**
   * The drawing as a picture, written beside its scene whenever the scene is
   * saved.
   *
   * Written by the side that has the editor loaded, since turning a scene into
   * an image needs a canvas and a font stack. Always the light rendering. It
   * was the note preview server that read these; nothing does today, and it is
   * kept because the picture beside the scene is what any future reader of a
   * drawing outside the editor would ask for.
   */
  writeDrawingSvg: (id: string, svg: string) => Promise<void>

  /**
   * A file dropped into a block document — a picture, in practice — kept in the
   * workspace so the document still has it once the file it came from has moved.
   *
   * The name is the renderer's, `<uuid>.<ext>`, and is checked before it becomes
   * a filename. The bytes cross as a
   * `Uint8Array` rather than base64: this is the one call in the contract that
   * carries a file's contents, and structured clone already moves bytes without
   * a third of them being spent on the encoding.
   *
   * See `shared/note-files.ts` for the URL the note writes down, and why these
   * are files rather than data URLs in the document.
   */
  writeNoteFile: (fileName: string, bytes: Uint8Array) => Promise<void>

  /** Runs a command in one of the folders; resolves with its process id. */
  startProcess: (
    folderId: string,
    command: string,
    args: string[]
  ) => Promise<string>
  stopProcess: (processId: string) => Promise<void>

  /** Subscribes to process output. Returns an unsubscribe function. */
  onProcessOutput: (listener: (event: ProcessOutput) => void) => () => void
  /** Subscribes to process exits. Returns an unsubscribe function. */
  onProcessExit: (listener: (event: ProcessExit) => void) => () => void

  /**
   * Opens a shell in one of the folders and resolves with the id its events are
   * tagged with.
   *
   * The user's own login shell, and the only thing this starts: the agent CLIs
   * used to be kinds of session here, and what runs one now is a project's chat
   * (`main/worktree-chat.ts`) rather than a pty the renderer asked for.
   *
   * The folder is named by **id** rather than by path, so main resolves the
   * directory from its own record: a path handed over by the renderer would be
   * a cwd this process had to validate, and the rule here is that the renderer
   * never names a directory main has not already written down (`insideAny` in
   * `files.ts` is the same rule for reads).
   */
  terminalCreate: (
    folderId: string,
    cols: number,
    rows: number
  ) => Promise<string>
  /** Sends keystrokes to a shell. */
  terminalWrite: (terminalId: string, data: string) => Promise<void>
  /** Tells a shell its new size. */
  terminalResize: (
    terminalId: string,
    cols: number,
    rows: number
  ) => Promise<void>
  terminalKill: (terminalId: string) => Promise<void>

  /** Subscribes to shell output. Returns an unsubscribe function. */
  onTerminalData: (listener: (event: TerminalOutput) => void) => () => void
  /** Subscribes to shells exiting. Returns an unsubscribe function. */
  onTerminalExit: (listener: (event: TerminalExit) => void) => () => void

  /**
   * The machine's CPU and memory headroom, and this app's share of it,
   * measured since the previous call — see `electron/system-usage.ts`.
   *
   * Polled, deliberately, rather than pushed: a reading only exists because
   * something asked for it, and the interval between two asks is the interval
   * the percentages are averaged over.
   */
  systemUsage: () => Promise<SystemUsage>

  /**
   * Whether a newer release exists — asked of the GitHub releases API and
   * answered against this build's own version.
   *
   * Polled from the renderer rather than pushed, like `systemUsage`: nothing in
   * the main process knows when a release is cut, so the only event there could
   * be is a timer, and a timer belongs beside the thing it draws.
   */
  checkForUpdate: () => Promise<UpdateCheck>

  /**
   * Installs a release and reopens the app, by running the same `install.sh`
   * the README hands people.
   *
   * Resolves with nothing only when the installer could not be *started*, and
   * throws when it could not be started at all — success is not something this
   * call can report, because the script's second act is quitting the app that
   * made it. macOS only, which is what `installable` on `UpdateCheck` says.
   *
   * The release's `.dmg` is fetched by main before the script runs, so this call
   * spans the download too and reports it through `onUpdateProgress`. A throw is
   * therefore also how a failed download arrives — the one part of an install
   * whose failure there is still a window to show.
   */
  installUpdate: (version: string) => Promise<void>

  /** Subscribes to how far `installUpdate` has got. Returns an unsubscribe
   * function. */
  onUpdateProgress: (listener: (event: UpdateProgress) => void) => () => void
}

/**
 * What `checkForUpdate` found.
 *
 * `unknown` rather than a rejection, because "GitHub is unreachable" is an
 * ordinary answer for a check that runs on a timer in the background: the badge
 * this feeds should stay quiet, not raise an error nobody asked for.
 */
export type UpdateCheck =
  | { status: "current"; current: string }
  | {
      status: "available"
      /** The release's version, without the tag's `v`. */
      version: string
      current: string
      /** The release notes, as GitHub's markdown — empty when it has none. */
      notes: string
      /** The release's page, for the "What's new" link. */
      url: string
      /**
       * Whether `installUpdate` can do anything here. `install.sh` is a macOS
       * script — it mounts a `.dmg` and `ditto`s a bundle — so everywhere else
       * the only honest button is the one that opens the release page.
       */
      installable: boolean
    }
  | { status: "unknown"; current: string; error: string }

/**
 * How far an install has got, while the window is still there to say.
 *
 * Two stages rather than a percentage of the whole, because only one of them
 * can be measured: `downloading` is bytes against a known total, `installing`
 * is `install.sh` mounting, quitting this app and copying a bundle — a few
 * seconds with no progress to read and no process left to read it from. So the
 * bar is a percentage up to the handover and indeterminate after it, which is
 * the truth rather than a fake ramp to 100.
 */
export type UpdateProgress =
  | {
      stage: "downloading"
      version: string
      received: number
      /** Zero when the release does not say how large its asset is. */
      total: number
    }
  | { stage: "installing"; version: string }

/**
 * What the menus ask the renderer to do.
 *
 * The menu is a second way to reach things the renderer already owns rather
 * than a second implementation of them: the main process names the intent and
 * the renderer opens the same dialog a button used to, closes the tab ⌘W would
 * have closed, or shows the sidebar ⌘B would have shown.
 */
export type MenuCommand =
  | "add-folder"
  | "close-tab"
  | "toggle-sidebar"
  | "toggle-terminal"
  | "open-settings"

/** IPC channel names, shared so main and preload cannot drift apart. */
export const IPC = {
  getWorkspace: "workspace:get",
  addFolder: "workspace:add-folder",
  renameFolder: "workspace:rename-folder",
  removeFolder: "workspace:remove-folder",
  pickDirectory: "workspace:pick-directory",
  pickImages: "workspace:pick-images",
  pickFiles: "workspace:pick-files",
  readImageDataUrl: "files:read-image-data-url",
  clipboardImagePath: "files:clipboard-image-path",
  menuCommand: "menu:command",
  gitBranch: "git:branch",
  gitStatus: "git:status",
  gitChanges: "git:changes",
  gitStage: "git:stage",
  gitUnstage: "git:unstage",
  gitDiscard: "git:discard",
  gitDiscardAll: "git:discard-all",
  gitCommit: "git:commit",
  draftCommitMessage: "git:draft-message",
  fileDiff: "git:file-diff",
  getSetting: "settings:get",
  setSetting: "settings:set",
  listDirectory: "files:list",
  readTextFile: "files:read-text",
  writeTextFile: "files:write-text",
  createFile: "files:create-file",
  createDirectory: "files:create-directory",
  renamePath: "files:rename",
  trashPath: "files:trash",
  revealPath: "files:reveal",
  readImageFile: "files:read-image",
  readImageRelative: "files:read-image-relative",
  listWorkspaceFiles: "files:index",
  watchDirectories: "files:watch",
  directoryChanged: "files:changed",
  tsOpen: "ts:open",
  tsChange: "ts:change",
  tsClose: "ts:close",
  tsHover: "ts:hover",
  tsDefinition: "ts:definition",
  agentModels: "agent:models",
  agentCommands: "agent:commands",
  installedMcpServers: "mcp:installed",
  removeMcpServer: "mcp:remove",
  listClaudeProfiles: "claude-profiles:list",
  saveClaudeProfiles: "claude-profiles:save",
  claudeAccount: "claude-profiles:account",
  claudeLogin: "claude-profiles:login",
  listWorktreeChats: "worktree-chats:list",
  createWorktreeChat: "worktree-chats:create",
  readWorktreeChat: "worktree-chats:read",
  chatDigests: "worktree-chats:digests",
  deleteWorktreeChat: "worktree-chats:delete",
  clearWorktreeChat: "worktree-chats:clear",
  renameWorktreeChat: "worktree-chats:rename",
  setWorktreeChatOptions: "worktree-chats:options",
  answerWorktreeChatAsk: "worktree-chats:answer",
  sendWorktreeChat: "worktree-chats:send",
  stopWorktreeChat: "worktree-chats:stop",
  worktreeChatEvent: "worktree-chats:event",
  revealWorktreeChat: "worktree-chats:reveal",
  distillLearnings: "agent:distill",
  saveLearning: "agent:save-learning",
  listReviewThreads: "comments:list",
  saveReviewThreads: "comments:save",
  listBoardCards: "board:list",
  saveBoardCards: "board:save",
  listBoardColumns: "board:list-columns",
  saveBoardColumns: "board:save-columns",
  readDrawing: "drawings:read",
  writeDrawing: "drawings:write",
  writeDrawingSvg: "drawings:write-svg",
  writeNoteFile: "note-files:write",
  startProcess: "process:start",
  stopProcess: "process:stop",
  processOutput: "process:output",
  processExit: "process:exit",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  systemUsage: "system:usage",
  checkForUpdate: "update:check",
  installUpdate: "update:install",
  updateProgress: "update:progress",
} as const

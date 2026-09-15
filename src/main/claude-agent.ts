import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

import type {
  AssistantMessage,
  ChatAgent,
  ChatTodo,
  ChatWindow,
  ChatWindowSlice,
  ChatWindowTone,
  TurnUsage,
} from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { locate, spawnEnvironment } from "./shell-env"

/**
 * Running an agent conversation, over `@anthropic-ai/claude-agent-sdk`.
 *
 * **A session, not a turn.** This used to spawn a CLI per message: `query()`
 * with a string prompt, which the SDK runs as a single turn and then closes
 * stdin on, so the process exits and the next message resumes the session from
 * disk. That shape cannot be typed into while it is answering — there is no
 * process left to say anything to — and the composer was disabled for the
 * length of a turn because of it. `query()` with an **async iterable** prompt is
 * the SDK's streaming input mode: one process for the life of the chat, reading
 * user messages off `Inbox` as they are pushed. A message sent while a turn is
 * running is queued by the CLI and coalesced into the next turn, which is what
 * the interactive `claude` does with a line typed mid-answer.
 *
 * Three things follow from that and are easy to miss:
 *
 * 1. `result` no longer ends anything. It is the end of a **turn** (`onTurn`);
 *    the session ends when the stream does (`onExit`). An error result does not
 *    close the stream either — the SDK only ends input on `isSingleUserTurn`,
 *    which streaming mode is not — so a failed turn leaves the chat usable.
 * 2. `modelUsage` and `total_cost_usd` on that line are **cumulative across the
 *    session**, where they used to be one turn's whole spend. `usageOf` takes
 *    the previous result and subtracts.
 * 3. Model, effort and permission can now change *without* a new process —
 *    `setModel`, `applyFlagSettings` and `permits`, which is consulted per call.
 *    What still cannot is `cwd` and `CLAUDE_CONFIG_DIR`: those are the CLI's own
 *    argument list, and `worktree-chat.ts` opens a new session when one of them
 *    moves.
 *
 * Apart from `worktree-chat.ts`, its one caller, because the part worth having
 * on its own is the **driving**: what the SDK hands back moves between
 * versions, and a reader of it tangled into a store and a session id is one
 * nobody wants to re-read when it moves. What is *not* here is policy — which
 * tools a turn may use, where it runs and what it is told about itself are the
 * caller's, passed in.
 *
 * **Why the SDK rather than spawning `claude -p`.** This used to be a
 * `child_process.spawn` of the CLI in print mode, reading
 * `--output-format stream-json` a line at a time (`claude-print.ts`). That shape
 * had one thing wrong with it that no amount of parsing fixes: a turn which met
 * a permission prompt had nobody to answer it, so it stalled or failed. The
 * whole permission picker in the composer exists to work around it. The SDK's
 * `canUseTool` is the missing half — it hands the request back to the host and
 * waits — and it is `onAsk` here, which the composer's `Ask` permission is the
 * one mode to pass. The other four still decide up front, which is why they
 * exist; that is now a choice rather than the only possibility.
 *
 * The CLI is still the thing that runs: `pathToClaudeCodeExecutable` is the
 * user's own `claude`, found the same way it always was, so a turn uses their
 * install and their login rather than a second copy of the CLI with an
 * authentication story of its own.
 */

/** What a session is: where it runs, who it is, and what it is allowed to do.
 * The prompt is not here — a session is sent to, over and over. */
export type AgentSessionOptions = {
  /** The directory the CLI runs in. Must exist — the CLI refuses otherwise. */
  cwd: string
  /**
   * The CLI session this one *is*.
   *
   * Passed as `sessionId` the first time the id is used and `resume` afterwards,
   * which is what makes a session opened after a restart a continuation rather
   * than a fresh conversation. The caller owns the id and owns knowing which of
   * the two it is. Must be a UUID: the SDK refuses anything else, as
   * `--session-id` did.
   */
  sessionId: string
  resume: boolean
  /**
   * The model, as an alias the CLI resolves (`opus`, `sonnet`).
   *
   * Left unset for whichever model the user's own `claude` is on, which is not
   * the same as naming today's default here: their choice is a setting of
   * theirs, and this app overriding it silently would be this app deciding.
   *
   * What the session *starts* on. `setModel` moves it afterwards without a new
   * process, which is the whole reason the toolbar can be touched mid-chat.
   */
  model?: string | null
  /** Reasoning effort. Unset for the CLI's own default, for the same reason,
   * and moved afterwards by `setEffort`. */
  effort?: string | null
  /**
   * Whether the chat's *current* mode allows a tool, answered here rather than
   * by the CLI.
   *
   * Consulted on every call rather than read once, which is what lets the
   * permission picker move mid-session: the caller's closure reads the record,
   * so a turn queued under `Ask` and run under `Edits` is run under `Edits`.
   *
   * It was `--allowed-tools`, and that list is what made changing mode
   * expensive: tool definitions sit ahead of the system prompt in the request,
   * so a list that differs between two turns of one chat invalidates the whole
   * cached prefix. Measured in this repo, one mode switch cost 38,423 tokens
   * re-written and nothing read, against 103 written for a turn that changed
   * nothing — eighteen times the price for the same question.
   *
   * A bare name on that list also auto-approves the call *before* `canUseTool`
   * is consulted (the SDK says so on stderr), which meant the callback below
   * was never reached for anything a mode had listed. Both problems have the
   * one answer: the tool configuration is identical on every turn and the
   * policy lives in this function, which is how the interactive CLI has always
   * worked.
   */
  permits: (toolName: string) => boolean
  /**
   * MCP tools the workspace has switched off, as wire names or server prefixes
   * — `MCP_DISABLED_TOOLS_KEY`.
   *
   * The one thing this app still says about the CLI's tool list, and it goes
   * over as `disallowedTools` rather than being refused in-process like a mode's
   * policy: refusing per call would leave the tool in the model's prompt, paid
   * for and offered, only to fail when used. This takes it out. It is part of
   * the cached prefix, which is why it is a **workspace** setting that changes
   * rarely rather than anything per mode or per message — see `permits` and
   * `signatureOf` in `worktree-chat.ts`.
   */
  disallowedTools?: string[]
  /**
   * How much the turn may do without being asked.
   *
   * A mode that ends by asking needs an `onAsk` below to answer it, or it is a
   * turn that stalls: see `PERMISSIONS` in `worktree-chat.ts` for which of the
   * CLI's modes are paired with one and what each is for.
   */
  permissionMode?: string
  /**
   * `CLAUDE_CONFIG_DIR`, for a turn running under one of the workspace's
   * `ClaudeProfile`s rather than the default `~/.claude`.
   *
   * Unset (or null) for the account the user's own `claude` is already signed
   * into — the same "leave it alone" default `model` and `effort` follow. Goes
   * through `environment`'s `extra`, which is the one place this app's own env
   * wins over whatever the shell already exports.
   */
  configDir?: string | null
  /** Directories outside `cwd` the turn may read. */
  addDirs?: string[]
  appendSystemPrompt?: string
  /**
   * Who answers a permission prompt, for a turn that may stop and put one on
   * screen.
   *
   * Read on every call, like `permits` and for the same reason: whether *this*
   * chat stops or refuses outright is its picker's business, and the picker
   * moves while the session is open. Left unset only by a caller where nothing
   * can ever stop; what a session without one does with a call `permits`
   * refused is refuse it too, with a sentence the model can read — see
   * `deciding`.
   */
  onAsk?: AskHandler
}

/**
 * Asked what to do about one tool call, answering whenever it can.
 *
 * The turn is **held** for as long as this takes — the CLI is waiting on the
 * other end of a pipe, and there is no timeout on this side. That is the point:
 * somebody has to read the question. A turn that should not wait is one this is
 * not passed for.
 */
export type AskHandler = (request: AskRequest) => Promise<AskDecision>

export type AskRequest = {
  toolName: string
  input: Record<string, unknown>
  /** The sentence the SDK rendered, when it had one — "Claude wants to read
   * foo.txt". Better than anything rebuilt from the two fields above, since the
   * CLI knows which argument of a call is the interesting one. */
  title?: string
  /** Whether there is a rule to remember, so a caller can offer "don't ask
   * again" only when accepting it would do something. */
  canRemember: boolean
  /** Dropped when the turn ends under it — a question nobody will answer. */
  signal: AbortSignal
}

export type AskDecision =
  | {
      allow: true
      /** Honoured only where the SDK suggested a rule; see `canRemember`. */
      remember?: boolean
      /**
       * Fields to change in the call before it runs, **merged** over what was
       * asked rather than replacing it.
       *
       * Merged because that is what every use of it needs: an `AskUserQuestion`
       * is answered by adding the answers while leaving the questions in place —
       * the SDK requires them back — and narrowing a path or a command is the
       * same shape. Replacing wholesale would mean every caller reassembling
       * the parts it did not care about.
       */
      input?: Record<string, unknown>
    }
  | { allow: false; message: string }

export type AgentHandlers = {
  /**
   * One line of the conversation, as it arrives.
   *
   * The caller records and forwards it. Deliberately not done here: where a
   * conversation is written down is the caller's business, and this module has
   * no idea which chat it is running.
   */
  onMessage: (message: AssistantMessage) => void
  /**
   * What a tool call came back with, for a line already sent through
   * `onMessage`.
   *
   * Apart from `onMessage` because it changes a line rather than adding one —
   * the result of a call belongs on the row that call already drew, and a second
   * row saying "and then it returned" is a transcript twice as long saying the
   * same thing. Matched by `toolId`, which is the CLI's own.
   */
  onToolResult: (
    toolId: string,
    result: string,
    /** The whole of it, capped, and only where `result` is a count rather than
     * the output itself — see `output` on the tool line. */
    output: string | undefined,
    failed: boolean
  ) => void
  /**
   * What the turn spent, from the result line that ends it.
   *
   * Reported at all because it is otherwise invisible: the numbers arrive once,
   * on one message, and a host that reads past them has no way to answer "why
   * did that turn cost what it did" afterwards — the transcript the CLI keeps is
   * not this app's to read. Once per turn, and before `onTurn`, so the cost
   * lands in the conversation ahead of an error rather than after it.
   *
   * Already a **delta**: the SDK's own numbers are the session's running total
   * once input is streamed, and this is what that turn added — see `usageOf`.
   */
  onUsage: (usage: TurnUsage) => void
  /**
   * How full the window is, at every reply rather than at the end of the turn.
   *
   * Apart from `onUsage` because it is not a spend and does not wait for the
   * result line: the same number lands on the turn's usage line when it ends
   * (`context` on `TurnUsage`), and this is it arriving while the turn is still
   * working. A caller that only wants the record can ignore it.
   */
  onContext: (tokens: number) => void
  /**
   * The window as the CLI accounts for it, once a turn has ended.
   *
   * Apart from `onContext` because it is a different measurement, not the same
   * one arriving twice. `onContext` is a count read off a reply's own usage —
   * live, free, and with no denominator. This is `getContextUsage()`: a control
   * request that carries `maxTokens`, the auto-compact threshold and the split
   * by category, which is what turns a number into a percentage.
   *
   * Once a turn, after `onUsage` and before `onTurn`. A control request per
   * reply would be a round trip per content block for a figure nobody can act on
   * mid-answer.
   *
   * **Not called when the ask fails**, and that is deliberate: the caller keeps
   * the last window it had rather than being handed a zeroed one. A CLI too old
   * to answer this simply never moves the meter off whatever the last turn said.
   */
  onWindow: (window: ChatWindow) => void
  /**
   * The CLI has started or finished compacting.
   *
   * A state and not a fraction, because a fraction does not exist: compaction is
   * one summarisation call, and what the SDK reports is `status: 'compacting'`
   * and then `status: null` with a `compact_result`. `error` is the CLI's own
   * sentence and is set only on a failure.
   */
  onCompacting: (compacting: boolean, error: string | null) => void
  /**
   * A compaction happened, with the window either side of it.
   *
   * The measurable half of the pair above, and the one worth writing down: the
   * boundary is a point in the conversation, and everything before it is
   * something the model now knows only as a summary.
   */
  onCompacted: (compacted: {
    trigger: "manual" | "auto"
    preTokens: number
    postTokens?: number
    durationMs?: number
  }) => void
  /**
   * Whether the CLI is working on something right now.
   *
   * The one thing a host cannot infer for itself any more. With a process per
   * turn, "sent" and "not yet finished" was the whole of it; a session takes a
   * message while it is answering and runs it afterwards, so the end of a turn
   * is not the end of being busy. Driven by the CLI's own
   * `session_state_changed` where it sends one, and by the pushes and results
   * this module can see where it does not.
   *
   * Called with the same value twice quite happily — the caller is expected to
   * be a state it can set rather than an edge it has to count.
   */
  onBusy: (busy: boolean) => void
  /**
   * Which subagents are running, as the whole list every time.
   *
   * A level rather than a start and a finish to be paired up — see `ChatAgent`.
   * Called with an empty list when the last of them ends, and once more on the
   * way out, so nothing is left running on screen by a session that died holding
   * one.
   */
  onAgents: (agents: ChatAgent[]) => void
  /** One turn is over. `error` is null when it succeeded. The session is not
   * over: another message may already be queued behind this one. */
  onTurn: (error: string | null) => void
  /**
   * The session is over — the CLI exited, or `close` was called.
   *
   * `error` is null for an ordinary close and for one this host asked for.
   * Called exactly once, always after a final `onBusy(false)`, and nothing
   * arrives afterwards.
   */
  onExit: (error: string | null) => void
}

/**
 * A conversation the CLI is holding open, for as long as the caller wants it.
 *
 * `send` is the whole point: it does not wait, and it does not care whether a
 * turn is running. A message pushed mid-turn is queued by the CLI and folded
 * into the next one, which is what typing while Claude is answering has always
 * done in the terminal.
 */
export type AgentSession = {
  send: (prompt: string) => void
  /** Stops the running turn without ending the session — the Stop button. What
   * was queued behind it still runs, which is the CLI's own rule. */
  interrupt: () => void
  /** Null for the user's own default, the same as never having named one. */
  setModel: (model: string | null) => void
  setEffort: (effort: string | null) => void
  /** Ends it. `onExit` fires with a null error: this is a close, not a failure. */
  close: () => void
}

const NOT_INSTALLED =
  "Claude Code is not installed, or not on the PATH your shell gives it. Install it with: npm install -g @anthropic-ai/claude-code"

/**
 * The user's half of a streaming session, as the iterable the SDK reads.
 *
 * A queue and a promise rather than anything cleverer, because the SDK pulls:
 * it awaits the next message, and this parks on `wake` until one is pushed.
 * Nothing here is dropped on the floor — a message pushed while the generator
 * is parked wakes it, and one pushed while it is not sits in `waiting`.
 *
 * `close` is what ends the CLI: the process lives as long as its stdin does, so
 * a session nobody closes is a `claude` nobody reaps.
 */
class Inbox {
  private readonly waiting: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  constructor(private readonly sessionId: string) {}

  push(prompt: string): void {
    if (this.closed) return
    this.waiting.push({
      type: "user",
      message: { role: "user", content: prompt },
      // Not a subagent's — this is the person typing.
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null
          resolve()
        }
      })
    }
  }
}

/**
 * Opens a session on its first message, or reports that it cannot be opened.
 *
 * Resolves once the CLI is actually up — its first message back — and the
 * session is over when `onExit` fires. Resolves to null when it could not be
 * opened at all, having already called `onExit` with the reason, so a caller has
 * one path for "it failed" rather than two.
 *
 * Waiting for that first message is the point rather than an implementation
 * detail: the caller writes down that the CLI now owns this session id, and a
 * session it never opened must not be resumed on the next try. `query()` is
 * lazy — the process starts on the first read of the stream — so "the call
 * returned" is not on its own evidence of anything.
 *
 * **Which is exactly why `first` is an argument.** It was not, briefly, and that
 * deadlocked every chat: the caller waited for this to resolve before sending
 * anything, and a CLI whose input stream has yielded nothing has nothing to
 * answer and says nothing — so the wait was on a message that could only have
 * been caused by the send that was waiting. A session is always opened *for* a
 * message, so it goes in the queue before the wait rather than after it.
 */
export async function startAgentSession(
  session: AgentSessionOptions,
  handlers: AgentHandlers,
  /** The message this session is being opened for. Queued before the CLI is
   * waited on — see above. */
  first: string
): Promise<AgentSession | null> {
  // A GUI app inherits almost none of the user's PATH, so where `claude` is has
  // to be asked of their own login shell rather than of `process.env`.
  const binary = await locate(claudeBinary())
  if (!binary) {
    handlers.onBusy(false)
    handlers.onExit(NOT_INSTALLED)
    return null
  }

  const abort = new AbortController()
  /** Set by a close, so the failure that follows one is not reported as a
   * failure: an aborted stream throws like any other. */
  let stopped = false
  /** `onExit` is a promise to the caller that it fires once, and there are three
   * ways to reach the end: the stream closing, a throw, and a close. */
  let finished = false
  const exit = (error: string | null) => {
    if (finished) return
    finished = true
    handlers.onBusy(false)
    // Before `onExit`, and unconditionally: a task belongs to the CLI that was
    // running it, so a session that died holding one has no subagent left — and
    // an emptied list is the only thing that takes it off the screen.
    handlers.onAgents([])
    handlers.onExit(error)
  }

  let stderr = ""
  /** Set by Stop and read by the result line that follows it: an interrupted
   * turn comes back as `error_during_execution` like any other failure, and the
   * CLI says nothing about who asked for it. Cleared by the result it explains,
   * so a genuine failure two turns later is not blamed on an old Stop. */
  let interrupted = false
  const inbox = new Inbox(session.sessionId)

  const conversation = query({
    // The streaming half. A string here is the SDK's single-turn mode, which
    // closes stdin on the first result — see the module comment.
    prompt: inbox.stream(),
    options: {
      cwd: session.cwd,
      abortController: abort,
      // The user's own install, not the SDK's bundled CLI: their login, their
      // settings, their `CLAUDE_BIN` override.
      pathToClaudeCodeExecutable: binary,
      env: await spawnEnvironment({
        /*
         * The CLI's own state signal, which it only emits when asked to.
         *
         * Without this the stream carries no `session_state_changed` at all and
         * `reportsState` below never turns true, so "the chat is busy" falls
         * back to the `result` line — and a `result` is *not* the end of the
         * work when the turn started background subagents: the CLI closes the
         * turn, the agents carry on, their frames keep arriving with a
         * `parent_tool_use_id`, and the spinner has already gone out. The CLI's
         * own `idle` waits for those agents to exit, which is the fact this
         * app has no other way to learn.
         */
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        ...(session.configDir ? { CLAUDE_CONFIG_DIR: session.configDir } : {}),
      }),
      // One or the other, never both — the SDK refuses `sessionId` together
      // with `resume`, which is the same rule `--session-id` had.
      ...(session.resume
        ? { resume: session.sessionId }
        : { sessionId: session.sessionId }),
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort
        ? { effort: session.effort as Options["effort"] }
        : {}),
      // No `allowedTools`: every call falls through to `canUseTool`, which is
      // both what lets one cached prefix serve all five modes and what makes the
      // callback reachable at all — see `permits`. `disallowedTools` is the one
      // exception and is not a mode's business either; it is the workspace's
      // switched-off MCP tools, the same on every turn until somebody changes
      // the setting. There is no `--mcp-config`: this app configures no MCP
      // server of its own, so a turn gets what the CLI finds for itself here.
      ...(session.disallowedTools?.length
        ? { disallowedTools: session.disallowedTools }
        : {}),
      ...permissionArgs(session.permissionMode),
      ...(session.addDirs?.length
        ? { additionalDirectories: session.addDirs }
        : {}),
      // The CLI's own system prompt with this app's note after it, rather than
      // in place of it: a bare string here would *replace* the preset, and a
      // turn that had never been told it is Claude Code is a different thing.
      ...(session.appendSystemPrompt
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: session.appendSystemPrompt,
            },
          }
        : {}),
      canUseTool: deciding(session.permits, session.onAsk),
      stderr: (data) => {
        // Kept rather than reported as it arrives: the CLI writes warnings here
        // on a turn that goes on to succeed, and only a failure makes them
        // worth showing.
        stderr = (stderr + data).slice(-4000)
      },
    },
  })

  /**
   * The previous result line, for taking the running totals off this one.
   *
   * Held here rather than by the caller because it is a fact about *this*
   * process: a session that is closed and opened again starts its totals over,
   * and a baseline that outlived the process it was measured against would read
   * the first turn of the new one as a refund. See `usageOf`.
   */
  let previous: ResultMessage | null = null

  /**
   * Where the conversation stood at the last reply of the turn being read.
   *
   * The result line cannot answer this — see `context` on `TurnUsage` — so it
   * is taken off the assistant messages as they go past and handed to `usageOf`
   * when the turn ends. Reset per turn rather than kept: a turn that crashed
   * before its first reply reports nothing, which is the honest answer, and a
   * stale number would be drawn as this turn's.
   */
  let context: number | null = null

  /**
   * Whether this CLI reports its own state, so the fallback below can stand
   * down.
   *
   * Not version-sniffed: `session_state_changed` is simply absent from an older
   * CLI's stream, and the first one that arrives says the CLI has it. Until
   * then, "the turn ended" is the best guess at "no longer busy" available —
   * wrong in that a chat with something queued blinks idle for as long as it
   * takes the CLI to start the next turn, and wrong for as long as a background
   * subagent outlives the turn that started it. Which is why the env var above
   * asks for the events: without it no CLI sends any, and the fallback is what
   * every chat ran on.
   */
  let reportsState = false

  /**
   * The subagents running right now, keyed by the CLI's own task id.
   *
   * Kept here rather than announced as edges, because what the pane needs is the
   * set: `task_started` and `task_notification` are bookends, and a missed one
   * is a spinner nobody can stop. Cleared when the process ends, since a task
   * belongs to the CLI that was running it.
   */
  const agents = new Map<string, ChatAgent>()
  const announceAgents = () => handlers.onAgents([...agents.values()])
  /** Everything running, dropped at once, when the chat is known to be quiet.
   * Silent if there was nothing, so a quiet turn does not push an empty list on
   * every result. */
  const forgetAgents = () => {
    if (agents.size === 0) return
    agents.clear()
    announceAgents()
  }

  /**
   * When the turn being answered started, for the wall time on its usage line.
   *
   * Kept here rather than taken off the result line for the reason `previous`
   * is: the SDK's own `duration_ms` belongs to the session. A turn starts when
   * its prompt goes in, so a message sent while another turn is running does
   * **not** move this — the queued turn starts where the running one ended,
   * which is why the result below rewinds it rather than `send` doing so
   * unconditionally.
   */
  let turnStartedAt = Date.now()
  /** Whether a turn is in flight, so `send` knows which of the two above it
   * is. */
  let answering = true

  /**
   * The window, asked of the CLI once a turn has ended.
   *
   * **Every failure is swallowed on purpose.** This is a meter, not the
   * conversation: a CLI too old to answer the request, a session closed for
   * idleness between the result and this landing, a request that times out — all
   * of them mean "no new number", and the caller keeps the last one it had. A
   * turn that worked must not report an error because a decoration could not be
   * refreshed.
   */
  async function askWindow(): Promise<void> {
    try {
      const usage = await conversation.getContextUsage()
      handlers.onWindow(readWindow(usage))
    } catch {
      // Deliberately silent — see above.
    }
  }

  /** Resolved with whether the CLI came up at all — see the note above. */
  let settle: (running: boolean) => void = () => {}
  const running = new Promise<boolean>((resolve) => {
    settle = resolve
  })

  // Before the reader, and before anything is waited on: this is the work the
  // CLI comes up to do, and without it in the queue there is nothing for it to
  // say and nothing for `running` to resolve on. `Inbox` buffers, so pushing
  // ahead of the process existing is the ordinary case rather than a race.
  handlers.onBusy(true)
  inbox.push(first)

  void (async () => {
    try {
      for await (const message of conversation) {
        settle(true)

        if (
          message.type === "system" &&
          message.subtype === "session_state_changed"
        ) {
          reportsState = true
          // `requires_action` is an ask on screen. Still busy: the turn is held
          // rather than over, and a composer that said otherwise would invite a
          // second message on top of a question nobody has answered.
          const idle = message.state === "idle"
          handlers.onBusy(!idle)
          // The CLI's own `idle` already waits for background subagents, so an
          // entry still in the map here is a bookend that never arrived — and a
          // heartbeat under a finished chat is a spinner nobody can stop.
          if (idle) forgetAgents()
          continue
        }

        /*
         * A subagent's heartbeat, which is the only sign of life it gives.
         *
         * Four frames for the same thing: `task_started` and `task_progress`
         * say a task exists and where it has got to, `task_updated` carries a
         * status patch, and `task_notification` is the end. All four are
         * merged into one map and announced as the whole set — see `agents`.
         *
         * `skip_transcript` is the CLI asking for a task to be kept out of the
         * conversation. Housekeeping rather than work somebody asked for, so it
         * is not counted here either.
         */
        if (message.type === "system" && message.subtype === "task_started") {
          if (!message.skip_transcript) {
            agents.set(message.task_id, {
              id: message.task_id,
              description: message.description,
              ...(message.subagent_type
                ? { subagentType: message.subagent_type }
                : {}),
            })
            announceAgents()
          }
          continue
        }

        if (message.type === "system" && message.subtype === "task_progress") {
          const known = agents.get(message.task_id)
          agents.set(message.task_id, {
            id: message.task_id,
            description: message.description,
            ...(message.subagent_type
              ? { subagentType: message.subagent_type }
              : known?.subagentType
                ? { subagentType: known.subagentType }
                : {}),
            ...(message.last_tool_name
              ? { lastTool: message.last_tool_name }
              : {}),
          })
          announceAgents()
          continue
        }

        if (message.type === "system" && message.subtype === "task_updated") {
          // Only the statuses that end it: `running` and `paused` are a task
          // that is still somebody's to wait for, and dropping a paused one
          // would say the work finished.
          const status = message.patch.status
          if (
            status === "completed" ||
            status === "failed" ||
            status === "killed"
          ) {
            if (agents.delete(message.task_id)) announceAgents()
          } else if (message.patch.description) {
            const known = agents.get(message.task_id)
            if (known) {
              agents.set(message.task_id, {
                ...known,
                description: message.patch.description,
              })
              announceAgents()
            }
          }
          continue
        }

        if (
          message.type === "system" &&
          message.subtype === "task_notification"
        ) {
          if (agents.delete(message.task_id)) announceAgents()
          continue
        }

        /*
         * Compaction, which the CLI reports in two halves.
         *
         * `status` is the spinner's half — on, then off — and carries whether it
         * worked. There is no third value and no fraction: one summarisation
         * call either finishes or does not.
         */
        if (message.type === "system" && message.subtype === "status") {
          const compacting = message.status === "compacting"
          handlers.onCompacting(
            compacting,
            message.compact_result === "failed"
              ? (message.compact_error ?? "Compaction failed.")
              : null
          )
          continue
        }

        // …and `compact_boundary` is the measurable half, which becomes a line.
        if (
          message.type === "system" &&
          message.subtype === "compact_boundary"
        ) {
          const meta = message.compact_metadata
          handlers.onCompacted({
            trigger: meta.trigger === "manual" ? "manual" : "auto",
            preTokens: meta.pre_tokens,
            ...(meta.post_tokens !== undefined
              ? { postTokens: meta.post_tokens }
              : {}),
            ...(meta.duration_ms !== undefined
              ? { durationMs: meta.duration_ms }
              : {}),
          })
          continue
        }

        /*
         * The window as of this reply, kept for the result line to carry. Only
         * the main loop's own: a subagent's assistant messages arrive on this
         * same stream (`parent_tool_use_id` is what tells them apart) and its
         * context is a conversation of its own that ends with the Task.
         *
         * Every frame overwrites the last, so what the result gets is the
         * turn's final reply. The SDK emits one of these per content block
         * while a response streams and only the last of a response carries
         * final counts — but they all carry the same request's prompt, which is
         * all but a rounding error of the number here.
         */
        if (message.type === "assistant" && !message.parent_tool_use_id) {
          const at = contextOf(message.message.usage)
          if (at !== null && at !== context) {
            context = at
            handlers.onContext(at)
          }
        }

        if (message.type === "result") {
          handlers.onUsage(
            usageOf(message, previous, context, Date.now() - turnStartedAt)
          )
          previous = message
          context = null
          // Whatever is queued behind this result starts being answered now.
          turnStartedAt = Date.now()
          answering = false
          // Without state events the result *is* the end of the work as far as
          // this app can tell, so the heartbeat goes out with the spinner it
          // belongs to rather than outliving it.
          if (!reportsState) {
            handlers.onBusy(false)
            forgetAgents()
          }
          handlers.onTurn(errorOf(message, interrupted))
          interrupted = false
          /*
           * The window, measured rather than counted — see `onWindow`.
           *
           * Deliberately **not** awaited: this loop is what delivers every
           * message of the next turn, and a control request in the middle of it
           * would hold the whole conversation for its round trip. A message
           * queued behind this result is already being answered.
           */
          void askWindow()
          continue
        }

        read(message, handlers)
      }
      // The stream ended, which for a session means the CLI is gone. Nothing
      // said it failed, so nothing here says so either.
      exit(null)
    } catch (error) {
      /*
       * The SDK throws where the old reader only read.
       *
       * Not for an error *result* any more, which is the difference streaming
       * input makes: the SDK only closes its input on a single-turn query, so a
       * failed turn is delivered as a result line and the session carries on.
       * What reaches this branch is the process itself ending — a CLI that would
       * not launch, a session id it refused, a crash — where its own message,
       * or failing that its stderr, is the only account of why.
       */
      exit(stopped ? null : failure(error, stderr))
    } finally {
      settle(false)
    }
  })()

  if (!(await running)) return null

  return {
    send: (prompt) => {
      // A Stop that raced the end of its turn leaves the flag set with no result
      // to spend it on; the next message is where it stops being true.
      interrupted = false
      // An idle chat's turn starts here; one that is already working keeps the
      // clock it has, since this message is queued behind that turn.
      if (!answering) turnStartedAt = Date.now()
      answering = true
      // Ahead of any word from the CLI, and deliberately: the composer has just
      // emptied itself, and a chat that looked idle until the CLI got round to
      // saying otherwise reads as a message that went nowhere.
      handlers.onBusy(true)
      inbox.push(prompt)
    },
    interrupt: () => {
      interrupted = true
      // Rejections are the CLI having nothing to interrupt — a Stop that raced
      // the end of the turn — which is not worth a line in the chat.
      void conversation.interrupt().catch(() => {})
    },
    setModel: (model) => {
      void conversation.setModel(model ?? undefined).catch((error: unknown) => {
        console.error("Could not change the model mid-session", error)
      })
    },
    setEffort: (effort) => {
      void conversation
        // The flag settings layer, which is where `effort` would have gone as an
        // option: there is no `setEffort`, and this is the documented way to
        // move one mid-session.
        .applyFlagSettings({ effortLevel: effort as EffortLevel | null })
        .catch((error: unknown) => {
          console.error("Could not change the effort mid-session", error)
        })
    },
    close: () => {
      stopped = true
      inbox.close()
      // Both, in that order: closing stdin is the polite end and the abort is
      // what makes a CLI that is mid-turn actually stop.
      abort.abort()
    },
  }
}

/** The SDK's own result line, named once rather than spelled out at each use. */
type ResultMessage = SDKMessage & { type: "result" }

/**
 * The token counts on one reply, structurally rather than by the SDK's name for
 * them: the result line's usage has these fields non-null and an assistant
 * message's has them optional, and `contextOf` reads both.
 */
type ReplyUsage = {
  input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  output_tokens?: number | null
}

/** What a settings key is, borrowed from the SDK rather than re-listed: the
 * effort levels are the CLI's and this app does not own them. */
type EffortLevel = Parameters<
  ReturnType<typeof query>["applyFlagSettings"]
>[0]["effortLevel"]

/**
 * Why the turn stopped, or null.
 *
 * Split out of `read` when `result` stopped being the end of anything: the
 * session's reader needs the sentence and the usage off the same line, and a
 * `read` that also decided what "failed" meant would be two readers of one
 * message.
 */
function errorOf(message: ResultMessage, interrupted: boolean): string | null {
  const failed = message.is_error || message.subtype !== "success"
  if (!failed) return null
  // A Stop lands here as an ordinary failure — the CLI reports the turn it
  // abandoned, not who asked it to — so the only thing that can tell the two
  // apart is this app's own record of having asked.
  if (interrupted) return "Interrupted by user."
  // Only a successful result carries the assistant's own last word; an error
  // subtype has no `result` field to explain itself with.
  const said =
    "result" in message && typeof message.result === "string"
      ? message.result.trim()
      : ""
  return said || `The turn ended as "${message.subtype}".`
}

/**
 * The SDK's `canUseTool`: the one place a mode's policy is applied.
 *
 * There were two of these — an `asking` for the mode that stops and an
 * `orgApproving` that refused everything for the four that do not — and the
 * split only made sense while the CLI was also being handed an allow list per
 * mode. Now that the tool configuration is the same on every turn (see
 * `permits`), what a mode *is* is this function, and there is one of it.
 *
 * The order matters. `matchedAskRule` is checked first because it is set when
 * an account's own policy on a connector — a claude.ai ClickUp, say — forces a
 * prompt regardless of anything this app configured; allowing it is this app's
 * own call rather than the account holder's, and it is made in every mode,
 * `plan` and `read` included, because a connector's tool carries no read/write
 * shape this app can see. A plan turn that reaches one is trusting that policy
 * rather than this app's read-only guarantee.
 *
 * After that: what the mode permits runs, what it does not goes to whoever can
 * be asked, and with nobody to ask it is refused with a message rather than
 * left to stall. A denial carries a sentence because the model reads it and
 * adjusts, which is the difference between "no" and a turn that spends itself
 * retrying.
 *
 * Two things about what `onAsk` is handed. `suggestions` is the set of rules
 * that would stop the same call being asked about again, echoed back **whole**
 * as `updatedPermissions` — the SDK's own instruction, and the reason
 * `remember` is a flag here rather than a rule this app composes. And
 * `updatedInput` is not optional in spirit: an allow that omits it was rejected
 * outright by CLIs before 2.1.207, so the input comes back either way,
 * unchanged unless the caller replaced it.
 */
function deciding(
  permits: (toolName: string) => boolean,
  onAsk: AskHandler | undefined
): Options["canUseTool"] {
  return async (toolName, input, context) => {
    if (context.matchedAskRule) {
      return { behavior: "allow", updatedInput: input }
    }

    if (permits(toolName)) {
      return { behavior: "allow", updatedInput: input }
    }

    if (!onAsk) {
      return {
        behavior: "deny",
        message: `${toolName} is not one of the tools this chat may use, and this mode has nobody to ask.`,
      }
    }

    const suggestions = context.suggestions ?? []
    const decision = await onAsk({
      toolName,
      input,
      title: context.title,
      canRemember: suggestions.length > 0,
      signal: context.signal,
    })

    if (!decision.allow) {
      return { behavior: "deny", message: decision.message }
    }
    return {
      behavior: "allow",
      // Merged over the call rather than replacing it — see `AskDecision.input`.
      updatedInput: decision.input ? { ...input, ...decision.input } : input,
      ...(decision.remember && suggestions.length > 0
        ? { updatedPermissions: suggestions }
        : {}),
    }
  }
}

/**
 * `bypassPermissions` is the one mode the SDK asks twice about.
 *
 * It refuses the mode outright unless `allowDangerouslySkipPermissions` is set
 * alongside it — a deliberate second opt-in rather than a flag to set once and
 * forget, which is why it is pinned to that mode here rather than passed always.
 */
function permissionArgs(mode: string | undefined): Options {
  if (!mode) return {}
  return {
    permissionMode: mode as Options["permissionMode"],
    ...(mode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
  }
}

function failure(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() || stderr.trim() || "The turn failed."
}

let lines = 0

/** An id for one line of a chat, unique within this run. Not a UUID: it never
 * leaves the chat's own file and is only there so a list can be keyed. */
export function lineId(): string {
  return `l${(lines += 1)}`
}

/**
 * One message from the SDK, narrowed to what a chat draws.
 *
 * Everything else it sends — the init line, the status and progress events — is
 * read and not passed on. What is drawn is the assistant's own blocks and the
 * tool results that come back in the `user` messages between them.
 *
 * The result line is **not** here. It ends a turn rather than adding to it, and
 * it needs the session's own previous result to be read at all, so the reader in
 * `startAgentSession` takes it before anything reaches this.
 */
function read(message: SDKMessage, handlers: AgentHandlers): void {
  const { onMessage, onToolResult } = handlers

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text" && block.text.trim()) {
        onMessage({ id: lineId(), role: "assistant", text: block.text })
      }
      // Only when the model was actually thinking, which is what the effort on
      // the toolbar decides — a turn at `low` sends none of these and draws no
      // rows for them, rather than empty ones.
      if (block.type === "thinking" && block.thinking.trim()) {
        onMessage({ id: lineId(), role: "thinking", text: block.thinking })
      }
      if (block.type === "tool_use") {
        onMessage({
          id: lineId(),
          role: "tool",
          name: block.name,
          ...describeCall(block.name, block.input),
          // The CLI's own id, kept so the result can find this line again.
          toolId: block.id,
        })
      }
    }
    return
  }

  /*
   * A tool's result comes back as a `user` message the CLI wrote, not the
   * user's own.
   *
   * This is the one place the two are confusable and the reason nothing else in
   * this branch is drawn: what arrives here is the transcript's record of the
   * conversation continuing, and the only part of it a chat has not already
   * drawn is what the tools said.
   */
  if (message.type === "user") {
    const content = message.message.content
    if (typeof content === "string") return
    for (const block of content) {
      if (block.type !== "tool_result") continue
      const whole = resultText(block.content)
      const line = resultLine(block.content)
      onToolResult(
        block.tool_use_id,
        line,
        // Only where the row is showing a count rather than the output: a
        // one-line result is already on the row, and a second copy of it under
        // a fold is a click that reveals what was read a second ago.
        whole && whole !== line ? detailOf(whole) : undefined,
        block.is_error === true
      )
    }
    return
  }
}

/**
 * What the turn spent, out of the result line.
 *
 * `modelUsage` rather than `usage`, because the SDK documents the latter as the
 * main agent loop alone: a turn that ran a subagent spent what the subagent
 * spent, `Task` is pre-approved here, and a cost that quietly omitted it would
 * be wrong in exactly the case somebody is looking it up for. Summed across
 * models for the same reason — compaction and a subagent on another model are
 * both this turn — and labelled with whichever of them did the most input,
 * since that is the one the toolbar was talking about.
 *
 * **`previous` is what makes this a turn rather than a session.** The SDK is
 * explicit that `modelUsage` and `total_cost_usd` are cumulative across the
 * turns of a streaming-input session: each result carries the running total so
 * far. This app used to spawn a process per turn, so every result was its own
 * turn's and there was nothing to subtract; now one process answers a whole
 * chat, and reading the raw line would draw the fifth turn as having cost what
 * the first four cost as well. So the previous result goes in and the
 * difference comes out — per model, not on the sum, or a chat switched from
 * Sonnet to Opus would credit one against the other.
 *
 * A backwards total is a **reset**, not a refund: a mid-session `/clear` starts
 * the running totals over, and so does a session opened again over the same id.
 * Where that happens the line stands on its own, which is the only reading of
 * it that is not negative.
 *
 * `thinking` is the exception that comes off `usage`, which is the only place
 * the SDK breaks the output down; it is per-turn even here, so it is not
 * subtracted. Being main-loop only makes it a floor, and a floor answers the
 * question it is read for — whether reasoning is where the output went.
 */
export function usageOf(
  message: ResultMessage,
  /** The last result of this same process, or null for its first turn. */
  previous?: ResultMessage | null,
  /** Where the conversation stood at the turn's last reply, which the result
   * line does not say — see `context` on `TurnUsage`. */
  context?: number | null,
  /** How long the turn took, measured by the caller — see `durationMs` on
   * `TurnUsage` for why it is not read off the line. */
  durationMs?: number | null
): TurnUsage {
  const before = previous?.modelUsage ?? {}
  const models = Object.entries(message.modelUsage ?? {}).map(([name, use]) => {
    const was = before[name]
    return [
      name,
      {
        input: since(use.inputTokens, was?.inputTokens),
        cacheWrite: since(
          use.cacheCreationInputTokens,
          was?.cacheCreationInputTokens
        ),
        cacheRead: since(use.cacheReadInputTokens, was?.cacheReadInputTokens),
        output: since(use.outputTokens, was?.outputTokens),
      },
    ] as const
  })

  const total = models.reduce(
    (sum, [, use]) => ({
      input: sum.input + use.input,
      cacheWrite: sum.cacheWrite + use.cacheWrite,
      cacheRead: sum.cacheRead + use.cacheRead,
      output: sum.output + use.output,
    }),
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  )

  const busiest = models.reduce<[string, number] | null>(
    (best, [name, use]) => {
      const read = use.input + use.cacheRead
      // Strictly greater, so a model that did nothing this turn cannot displace
      // the one that did — every model the session has ever used is still on
      // the line, at last turn's numbers, and subtracts to zero.
      return best === null || read > best[1] ? [name, read] : best
    },
    null
  )

  const cost = since(message.total_cost_usd, previous?.total_cost_usd)
  return {
    model: busiest?.[0] ?? null,
    ...total,
    thinking: message.usage?.output_tokens_details?.thinking_tokens ?? 0,
    // A crashed turn reports zero for everything, and a zero drawn as `$0.00`
    // is this app claiming a turn was free rather than that nobody counted it.
    costUsd: cost > 0 ? cost : null,
    context: context ?? null,
    durationMs: durationMs ?? null,
  }
}

/**
 * The conversation's size at one reply, out of that reply's own usage.
 *
 * Everything the model was sent plus what it answered with, which is what the
 * next request starts from — the three prompt figures are the one prompt split
 * by how it was billed, not three prompts. Null where the reply carried no
 * usage at all, so a caller can keep the last number it had rather than draw a
 * zero as an empty window.
 */
/**
 * The CLI's context report, narrowed to what a meter draws.
 *
 * Field by field for the reason `readModel` and `readServer` are, and with one
 * extra reason of its own: this crosses into the renderer as something a bar is
 * sized from, so a missing `maxTokens` has to become a window with no
 * denominator rather than a division by zero.
 *
 * **The colours are dropped and the names are matched instead.** The CLI sends
 * a `color` per category, but those are its terminal theme's tokens —
 * `promptBorder`, `inactive`, `claude`, `warning`,
 * `purple_FOR_SUBAGENTS_ONLY` — which no stylesheet here can use, and which
 * carry no meaning a renderer could map: two unrelated categories share
 * `promptBorder`. So `toneOf` reads the name, and anything unrecognised becomes
 * `other`. That is the field most likely to move in a CLI release, and an
 * unfamiliar category then draws in a neutral tone rather than disappearing.
 *
 * Exported for `test/chat-window.ts`.
 */
export function readWindow(raw: unknown): ChatWindow {
  const usage = (raw ?? {}) as Record<string, unknown>
  const threshold = usage.autoCompactThreshold

  return {
    tokens: number(usage.totalTokens),
    // `rawMaxTokens` rather than `maxTokens`: the SDK documents the percentage
    // as being measured against the raw window, and a bar whose denominator
    // disagreed with the number printed beside it is worse than either alone.
    maxTokens: number(usage.rawMaxTokens) || number(usage.maxTokens),
    percentage: number(usage.percentage),
    // Only when auto-compaction is actually on: a threshold drawn on the bar of
    // a session that will never act on it is a mark promising something.
    autoCompactAt:
      usage.isAutoCompactEnabled === true && typeof threshold === "number"
        ? threshold
        : null,
    model: typeof usage.model === "string" ? usage.model : "",
    slices: Array.isArray(usage.categories)
      ? usage.categories.map(readSlice)
      : [],
  }
}

function readSlice(raw: unknown): ChatWindowSlice {
  const category = (raw ?? {}) as Record<string, unknown>
  const name = typeof category.name === "string" ? category.name : "Other"
  return {
    name,
    tokens: number(category.tokens),
    tone: toneOf(name),
    deferred: category.isDeferred === true,
  }
}

/**
 * Which tone a category draws in, from its name.
 *
 * Matched on a substring rather than on the whole string because the names
 * carry qualifiers the match has no business caring about — `System tools` and
 * `System tools (deferred)` are one tone and two rows. Order matters: `System
 * tools` has to be tested before `System prompt`'s bare `system`, or both land
 * on the same tone.
 */
function toneOf(name: string): ChatWindowTone {
  const lower = name.toLowerCase()
  if (lower.includes("free")) return "free"
  if (lower.includes("tool")) return "tools"
  if (lower.includes("memory")) return "memory"
  if (lower.includes("skill")) return "skills"
  if (lower.includes("message")) return "messages"
  if (lower.includes("system") || lower.includes("prompt")) return "system"
  return "other"
}

/** A number the CLI sent, or zero for anything that is not one. */
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function contextOf(usage: ReplyUsage | undefined): number | null {
  if (!usage) return null
  const total =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.output_tokens || 0)
  return total > 0 ? total : null
}

/**
 * One counter's movement since the last result line.
 *
 * A missing number on either side reads as zero, which is the same thing the
 * sums here have always done with one. A negative difference is the running
 * total having been reset under us — see `usageOf` — and the honest reading of
 * the line is then the line itself.
 */
function since(now: number | undefined, then: number | undefined): number {
  const moved = (now || 0) - (then || 0)
  return moved < 0 ? now || 0 : moved
}

/**
 * One line describing what a tool was called with.
 *
 * A tool call is drawn as a single row, so this is the row: the argument that
 * says which thing it was about — a statement, a request's name, a path —
 * rather than the whole input, which for a query is longer than the answer.
 */
export function summarise(input: unknown): string {
  return collapse(argumentOf(input))
}

/**
 * The argument a row is about, **before** it is collapsed into one.
 *
 * Split out of `summarise` because the row and the panel under it want the same
 * string at two lengths: 120 characters of one line to scan, and the whole of it
 * to read. Picking the key twice — once for each — is how the two quietly come
 * to disagree about which argument the row was even showing.
 */
export function argumentOf(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>

  for (const key of [
    "sql",
    "request",
    "note",
    "database",
    "file_path",
    "pattern",
    "command",
    "name",
  ]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value
    }
  }
  return JSON.stringify(record)
}

export function collapse(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * What the CLI calls the tool that runs a subagent — **both** of its names.
 *
 * It was `Task` and is now `Agent`, and which one arrives is the user's own
 * `claude`'s business rather than this app's: a chat on an older CLI still sends
 * `Task`, and a transcript on disk holds whichever was current when it was
 * written. So every test of it is a test of the pair, here and in
 * `lib/worktree-chat/activity.ts`, which is the renderer's copy of this fact —
 * the two processes never import each other.
 *
 * Getting this wrong is not cosmetic: the name is on `READ_TOOLS` and
 * `ALLOWED_TOOLS` in `worktree-chat.ts`, so a mode that did not know the new one
 * refused every handoff to a subagent.
 */
export const AGENT_TOOLS = ["Agent", "Task"]

export function isAgentTool(name: string): boolean {
  return AGENT_TOOLS.includes(name)
}

/**
 * A tool call as the three things a row draws it from.
 *
 * Pulled out of `summarise` rather than folded into it, because a row wants the
 * pieces apart: the file goes in a chip with its own icon, the model's
 * `description` is the sentence the row leads with, and the argument is the
 * muted mono text after it. One string could not have been split back up —
 * "is this a path" is not a question to ask of text somebody's command wrote.
 *
 * The subagent tool is the reason `summary` is not always `summarise`: its
 * input is a description, a whole prompt and a subagent type, none of which the
 * key list names, so every subagent row was the JSON of the entire prompt
 * collapsed to 120 characters. What a row wants there is which agent ran.
 */
export function describeCall(
  name: string,
  input: unknown
): {
  summary: string
  input?: string
  title?: string
  path?: string
  stat?: string
  change?: string
  todos?: ChatTodo[]
} {
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {}

  /*
   * A todo list is its own row, not an argument.
   *
   * Returned before anything below runs, because every piece of it would be
   * wrong here: there is no path and no description, the summary would be the
   * list's JSON, and `input` would be the same JSON again behind the fold. What
   * the row wants is the two facts a list has — how far through it is, and which
   * item is running — with the list itself under it.
   */
  const todos = todosOf(name, record)
  if (todos) {
    const done = todos.filter((todo) => todo.status === "completed").length
    const running = todos.find((todo) => todo.status === "in_progress")
    return {
      summary: running?.content ?? "",
      stat: `${done}/${todos.length}`,
      todos,
    }
  }

  const text = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === "string" && value.trim() ? value : undefined
  }

  const path = text("file_path") ?? text("notebook_path")
  const title = text("description")
  const summary = isAgentTool(name)
    ? (text("subagent_type") ?? "")
    : // Nothing at all rather than `summarise`'s `{}`: a row that says the
      // empty object says less than a row that says only the tool's name.
      Object.keys(record).length === 0
      ? ""
      : summarise(record)

  /*
   * The whole argument, but only where the row is not already showing it.
   *
   * `collapse` folds the whitespace and cuts at 120, so a `summary` equal to the
   * raw string is a row with nothing behind it — a `Read` of one path, a `Grep`
   * of one pattern — and giving those an open panel would be a click that
   * reveals the line already read. What survives the test is what somebody
   * actually wants opened: the heredoc, the 300-character query, the `Bash` line
   * with four pipes in it.
   */
  const whole = isAgentTool(name) ? "" : argumentOf(record)
  const more = whole && collapse(whole) !== whole ? detailOf(whole) : undefined

  return {
    summary,
    ...(more ? { input: more } : {}),
    ...(title ? { title: collapse(title) } : {}),
    ...(path ? { path } : {}),
    ...changeOf(name, record),
  }
}

/**
 * How much of a command or its output is kept for the row that opens.
 *
 * Capped, and not generously, because of where this ends up: a chat is
 * **rewritten whole** on every appended line, so a single `Bash` that printed a
 * build log is not paid for once — it is carried through every subsequent write
 * for the life of the conversation, and read back on every launch. Two limits
 * rather than one, since the two ways to be enormous are unrelated: a thousand
 * short lines, and one line that is a base64 blob.
 *
 * What is dropped is said out loud rather than trailed off with an ellipsis: a
 * panel that silently showed the first 200 lines of a 4,000-line result is one
 * that will be read as the whole of it.
 */
const DETAIL_LINES = 200
const DETAIL_CHARS = 12_000

export function detailOf(text: string): string {
  const trimmed = text.replace(/\s+$/, "")
  if (!trimmed) return ""

  const lines = trimmed.split("\n")
  const cut = lines.length > DETAIL_LINES
  const kept = cut ? lines.slice(0, DETAIL_LINES).join("\n") : trimmed

  if (kept.length > DETAIL_CHARS) {
    return `${kept.slice(0, DETAIL_CHARS)}\n… truncated at ${DETAIL_CHARS.toLocaleString()} characters`
  }
  return cut
    ? `${kept}\n… ${(lines.length - DETAIL_LINES).toLocaleString()} more lines`
    : kept
}

/**
 * The list out of a `TodoWrite` call, or null.
 *
 * Null for every other tool and for a payload that does not have this shape,
 * which is what makes this safe to put ahead of everything else in
 * `describeCall`: a CLI that renames the field or the statuses lands back on the
 * JSON argument the row drew before this existed, rather than on a checklist
 * with nothing in it. Same reasoning as `asked` in `worktree-chat.ts` — the tool
 * name says which kind of call it is, and this says whether the payload agrees.
 *
 * An item with no content is dropped rather than drawn as an empty line, and a
 * status this does not know is read as `pending`: the list is worth showing even
 * when one of its rows arrived in a shape from a later CLI.
 */
export function todosOf(
  name: string,
  record: Record<string, unknown>
): ChatTodo[] | null {
  if (name !== "TodoWrite") return null
  if (!Array.isArray(record.todos)) return null

  const todos = record.todos.flatMap((entry): ChatTodo[] => {
    const todo = entry as Record<string, unknown>
    const content = typeof todo?.content === "string" ? todo.content.trim() : ""
    if (!content) return []
    const status =
      todo.status === "in_progress" || todo.status === "completed"
        ? todo.status
        : "pending"
    return [{ content: collapse(content), status }]
  })

  return todos.length > 0 ? todos : null
}

const CHANGE_LINES = 16

export function changeOf(
  name: string,
  record: Record<string, unknown>
): { stat?: string; change?: string } {
  const string = (value: unknown): string | null =>
    typeof value === "string" ? value : null

  /** One edit as its two sides, `null` for a side the call does not have. */
  const pairs: { old: string | null; now: string | null }[] = []

  if (name === "Edit") {
    pairs.push({
      old: string(record.old_string),
      now: string(record.new_string),
    })
  } else if (name === "MultiEdit" && Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      const one = edit as Record<string, unknown>
      pairs.push({ old: string(one?.old_string), now: string(one?.new_string) })
    }
  } else if (name === "Write") {
    pairs.push({ old: null, now: string(record.content) })
  } else if (name === "NotebookEdit") {
    pairs.push({ old: null, now: string(record.new_source) })
  } else {
    return {}
  }

  const lines: string[] = []
  let added = 0
  let removed = 0

  for (const pair of pairs) {
    // An empty string is a real side — deleting a block, or writing an empty
    // file — so the split is guarded on null rather than on falsiness.
    const before = pair.old === null ? [] : splitLines(pair.old)
    const after = pair.now === null ? [] : splitLines(pair.now)
    removed += before.length
    added += after.length

    for (const line of before) lines.push(`- ${line}`)
    for (const line of after) lines.push(`+ ${line}`)
  }

  if (added === 0 && removed === 0) return {}

  const stat = [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""]
    .filter(Boolean)
    .join(" ")

  const shown = lines.slice(0, CHANGE_LINES)
  if (lines.length > shown.length) {
    shown.push(`… ${lines.length - shown.length} more`)
  }

  return { stat, change: shown.join("\n") }
}

/** The lines of one side of an edit. A trailing newline is the end of the last
 * line rather than an empty line after it, which is what `split` would make of
 * it — and an empty side has no lines at all. */
function splitLines(text: string): string[] {
  if (text === "") return []
  return text.replace(/\n$/, "").split("\n")
}

/**
 * What a tool call came back with, in one line.
 *
 * A count rather than the output itself once there is more than a line of it:
 * a `Read` returns the file, and a row that tried to show it would be the file
 * in the transcript. One line is shown as it stands, because "the command
 * printed nothing" and "the command printed `3`" are the two answers somebody
 * scanning the rows is actually looking for.
 *
 * Lines rather than bytes because that is the unit the tools themselves work
 * in — `Read` is given a line count and refuses past one — so it is the number
 * the next call will be phrased in.
 */
export function resultLine(content: unknown): string {
  const trimmed = resultText(content)
  if (!trimmed) return ""

  const lines = trimmed.split("\n")
  return lines.length === 1
    ? collapse(lines[0]!)
    : `${lines.length.toLocaleString()} lines`
}

/**
 * The text of a result, before it is reduced to a line.
 *
 * The reading half of `resultLine`, split out for the reason `argumentOf` was:
 * the row wants `631 lines` and the panel under it wants the 631, and two
 * readers of the SDK's block shape are two places to fix when it moves.
 */
export function resultText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              const record = block as Record<string, unknown>
              return typeof record?.text === "string" ? record.text : ""
            })
            .join("\n")
        : ""
  return text.trim()
}

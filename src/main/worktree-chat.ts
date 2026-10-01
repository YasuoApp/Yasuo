import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import {
  chatOptions,
  chatRootId,
  type AssistantMessage,
  type ChatAskOption,
  type ChatAskQuestion,
  type ChatDigest,
  type ChatEffort,
  type ChatImage,
  type ChatPermission,
  type ChatPlace,
  type ChatSearchResult,
  type ChatSeed,
  type ChatSpend,
  type ClaudeProfile,
  type WorktreeChat,
  type WorktreeChatAnswer,
  type WorktreeChatAsk,
  type WorktreeChatEvent,
  type WorktreeChatOptions,
} from "../shared/api"
import { digestOf, spendOf, spendRows } from "./chat-digest"
import { chatMatchesIn } from "./content-search"
import {
  AGENT_TOOLS,
  collapse,
  lineId,
  startAgentSession,
  summarise,
  type AgentPrompt,
  type AgentSession,
  type AskDecision,
  type AskRequest,
} from "./claude-agent"
import { expandHome } from "./shell-env"

/**
 * A project's chats: one agent turn at a time, in that project's directory.
 *
 * **Why the app drives the CLI and does not read after it.** A session's chat
 * view tails the transcript the interactive CLI writes, and that is the right
 * shape for a session: the terminal and the chat are two views of one
 * conversation, and a permission prompt is answered in the terminal. A
 * a project's chat is not that. It is a conversation the app is *hosting* — its
 * own message model, its own composer, its own tool-call rows — and hosting one
 * means driving. `@anthropic-ai/claude-agent-sdk` is what it drives through,
 * which was `claude -p` and `--output-format stream-json` until the SDK could do
 * the one thing print mode could not: hand a permission request back to the
 * host. See `claude-agent.ts`.
 *
 * `retitle` is the **one** read of that transcript, and it is not a tail: it
 * takes the one thing the CLI writes there and sends nowhere — the name it gave
 * the conversation — once, at the end of a chat's first turn. Everything the
 * pane draws still arrives on the message stream.
 *
 * This is the only `claude` the app runs as a **conversation**. There was a
 * workspace assistant beside it — one conversation, read-only, in no folder at
 * all — and it was removed; what `CLAUDE.md` has always refused is something
 * else and still is: features calling the CLI as a helper, an AI filter or an
 * import button, because a helper turn is a turn nobody asked for. This is a
 * conversation somebody is having.
 *
 * `one-turn-agent.ts` is the one other place a session is opened, and it is
 * deliberately not this class: each of its turns is read-only, opened for a
 * question and closed on the answer, with no transcript, no resume and nothing
 * to send a second message to. Neither is a helper turn either — each is a
 * button pressed by the person who reads its answer — and the argument for them
 * is at the top of that file.
 *
 * **What it may do, and why.** A chat runs in the user's own working tree,
 * which is the case the isolation argument does *not* cover: there was a
 * `git worktree` layer here — a checkout on a branch of its own, which is what
 * made pre-approving edits honest — and it is gone, so the default is `edits`
 * over the files the user is actually working in. Nothing claims otherwise: the
 * turn is told where it really is (`SYSTEM_PROMPT`), the caption under the
 * composer says the project, and the picker is the user's to set — `Plan` and
 * `Ask` are there for exactly this. Most of the modes in `PERMISSIONS` decide
 * up front, because a mode that stops to ask was impossible until the turn
 * moved to the SDK. `ask` stops for anything unlisted and `edits` for an MCP
 * tool; everywhere else a refusal is named rather than left to stall.
 *
 * **No MCP config goes over at all.** This app used to serve its own panels as
 * three `yasuo-*` servers and hand a turn the config naming them; that whole
 * feature is gone (see `docs/design.md`). What is left is the CLI's own
 * discovery, which is what a turn has always also had: `~/.claude.json`, a
 * repository's own `.mcp.json`, enabled plugins, claude.ai connectors, all
 * merged the way running plain `claude` in this directory would. So a server
 * that works from the dock's Terminal works from a chat here, with nothing to
 * switch on for it — and Settings › MCP is a listing of what that came to
 * rather than a set of switches.
 *
 * **What the chat's own toolbar decides** is on the record rather than here:
 * `WorktreeChatOptions` is a model, an effort and a permission per chat, and a
 * turn is built from whatever it said when the message was sent. Only the last
 * of the three changes what a turn may do, and `PERMISSIONS` is the whole of
 * that — including why plan mode is a tool list and not `--permission-mode
 * plan`.
 */

/**
 * The CLI process holding one chat open.
 *
 * A **session** rather than a turn, which is the change the composer is built
 * on: a message sent while one is answering is pushed into the same process and
 * queued, instead of being refused with "that chat is still answering". Mutable
 * on purpose — the toolbar moves under a session that is already running, and
 * `permits` reads `options` off this record on every tool call.
 */
type Live = {
  session: AgentSession | null
  /** Held while the CLI is coming up, so two sends in quick succession wait on
   * one process rather than spawning a second. Null once it is up, or once it
   * has failed. */
  opening: Promise<AgentSession | null> | null
  /** What the CLI was given as arguments — see `signatureOf`. A session whose
   * signature no longer matches the chat is closed and opened again. */
  signature: string
  /** Which `CLAUDE_CONFIG_DIR` this session's transcript is under, so `retitle`
   * can find the file the CLI is writing. Part of the signature already, and
   * kept whole here rather than parsed back out of it. */
  configDir: string | null
  /** What the session is *currently* on, so `retune` can tell a real change
   * from the same value being written back. Both start as whatever opened it. */
  model: string | null
  effort: ChatEffort | null
  /** The chat's toolbar as it stands, read by `permits` and by the `onAsk`
   * below at the moment of the call rather than when the session opened. */
  options: WorktreeChatOptions
  /** The permission whose sentence last went at the head of a message in this
   * session — see `headed`. Null until the first message, so a fresh session is
   * always told its mode. */
  saidMode: ChatPermission | null
  /** Whether the CLI is working on something — the same thing the renderer is
   * told. Held here because `reap` must not close a session mid-turn. */
  busy: boolean
  /** Armed whenever the session goes quiet, cleared whenever it does not — see
   * `IDLE_MS`. */
  idle: ReturnType<typeof setTimeout> | null
}

/**
 * How long a chat's CLI is kept alive with nothing to do.
 *
 * A session is a process, and this app now holds one open per chat that has been
 * sent to rather than one per turn. Left alone that is a `claude` for every
 * conversation somebody opened this morning, still resident this afternoon — the
 * one real cost of the change, and not one the user asked to pay.
 *
 * Closing an idle one costs nothing that was not already being paid before
 * sessions existed: the next message opens it again as a resume, which is
 * exactly what every message used to do. So the window only has to be long
 * enough to cover the gap it exists for — reading an answer and typing a reply —
 * and five minutes is generous for that.
 */
const IDLE_MS = 5 * 60 * 1000

export type WorktreeChatSource = {
  /** The MCP tools Settings › MCP has switched off, as wire names or server
   * prefixes — see `MCP_DISABLED_TOOLS_KEY`. Asked per message, like the
   * profiles: it is an argument the CLI is started with, so a change to it opens
   * a new session (`signatureOf`). */
  disabledTools: () => Promise<string[]>
  /** The directory a project names, or null when it has left the workspace —
   * what a chat runs in. */
  folderDir: (folderId: string) => Promise<string | null>
  /** The workspace's `CLAUDE_CONFIG_DIR` profiles, for resolving a chat's
   * `options.profileId` at send time — see `ClaudeProfile`. */
  claudeProfiles: () => Promise<ClaudeProfile[]>

  chats: () => Promise<WorktreeChat[]>
  saveChats: (chats: WorktreeChat[]) => Promise<void>
  readChat: (id: string) => Promise<AssistantMessage[]>
  writeChat: (id: string, messages: AssistantMessage[]) => Promise<void>
  deleteChat: (id: string) => Promise<void>
}

/**
 * Pre-approved for a worktree chat.
 *
 * Read the class comment before widening this. It is broad on purpose — a chat
 * that cannot edit a file is not a coding chat — and it is only defensible
 * because the directory it runs in is a branch of its own.
 *
 * `--permission-mode acceptEdits` covers the edit tools; these are the ones that
 * would otherwise still be asked about, and in print mode "asked about" means
 * "refused".
 *
 * `ToolSearch` is on the list because a CLI configured to defer tools reaches an
 * MCP tool through it, and being asked to approve a search for a tool is a
 * prompt nobody can answer. No MCP server is named here at all: this app no
 * longer configures one, so it has no name to name — a tool from a server the
 * CLI found on its own is decided by the mode — see `asks` on `PERMISSIONS`.
 */
const ALLOWED_TOOLS = [
  "ToolSearch",
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  ...AGENT_TOOLS,
]

/**
 * The tool a turn asks a question with.
 *
 * Not a permission but a delivery mechanism: it reaches this app by being on no
 * mode's `allowed`, so the request comes through `canUseTool` and the questions
 * arrive with it. Unlike everything else `canUseTool` sees, this is the model
 * asking the *user* something rather than asking for permission, so every mode
 * wires it to `onAsk` and it becomes a card regardless of what else that mode
 * permits — see the `onAsk` passed to `runAgentTurn` below, and `permitting`,
 * which keeps `full`'s "everything" from auto-answering it before `onAsk` is
 * ever reached.
 */
const ASK_TOOL = "AskUserQuestion"

/**
 * The read-only half: everything that reads, and nothing that writes.
 *
 * What both `plan` and `read` run as — they differ in what the turn is *told*,
 * not in what it may do, since "describe the change" and "answer the question"
 * are the same permission and different requests.
 *
 * **Why not `--permission-mode plan`.** That is the CLI's own plan mode, and it
 * ends by asking — `ExitPlanMode` is a prompt, and print mode has nobody to
 * answer it. A turn started that way spends itself trying to leave: it writes
 * the plan to a file it may not write, calls a tool that is disabled, and comes
 * back `is_error` with an apology instead of a plan. So plan mode here is the
 * thing somebody actually wanted from it — a turn that cannot change anything —
 * built out of the tool list, which print mode *can* enforce.
 *
 * `Bash` is not on it, and that is the whole of the guarantee: a command can
 * write, and no reading of an argument list decides which ones do. What it costs
 * is `git log` and `rg`, and `Glob` and `Grep` are the same reconnaissance
 * without a shell.
 *
 * The one hole in it that is not this app's to close: `orgApproving` in
 * `claude-agent.ts` lets a `matchedAskRule` call through in every mode,
 * `plan` and `read` included, because an account's own policy on a connector
 * carries no read/write shape this app can see. A plan turn that reaches one
 * of those is trusting that policy rather than this list.
 */
const READ_TOOLS = [
  "ToolSearch",
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  ...AGENT_TOOLS,
]

/**
 * What a plan-mode turn is told, on top of `SYSTEM_PROMPT`.
 *
 * Said as well as enforced: a model that discovers it cannot write by being
 * refused spends a tool call finding out, and one that was told up front spends
 * it reading instead.
 */
const PLAN_PROMPT =
  "This turn is read-only: describe what you would change and why, in enough detail that it could be carried out, and do not modify anything. The editing tools and the shell are unavailable on purpose, so do not try them."

/**
 * The same tools as `PLAN_PROMPT` and a different request.
 *
 * Read-only without asking for a plan: somebody wanting to know where a
 * function is called does not want a numbered list of changes back, and a turn
 * told to plan will find something to propose whether or not it was asked.
 */
const READ_PROMPT =
  "This turn is read-only: answer the question, and do not modify anything. The editing tools and the shell are unavailable on purpose, so do not try them. Only lay out a plan of changes if that is what was asked for."

/**
 * What an asking turn is told, on top of `SYSTEM_PROMPT`.
 *
 * Said because the alternative is a model working around the prompts rather than
 * through them: one that finds a write refused and does not know a person is
 * reading will rephrase, retry, or settle for describing the change. Told that
 * somebody is there, it asks once and carries on.
 */
const ASK_PROMPT =
  "Anything the user's settings do not already allow will stop and ask the user, who is present and will answer. Go ahead and use the tools the work needs rather than working around them — a request is a short pause, not a refusal. Use AskUserQuestion when a choice is genuinely the user's to make."

/**
 * What each permission actually runs as.
 *
 * One table rather than a conditional per flag, because the five differ along
 * four axes at once — the tool list, the refusals, what the turn is told and
 * whether it may stop to ask — and a turn assembled from four separate ternaries
 * is one edit away from a mode that says `read` and allows `Bash`.
 *
 * `acceptEdits` for three of the five, the read-only pair included: the mode is
 * what stops the *permitted* tools stalling on a prompt nobody can answer, and
 * what makes those two read-only is the tool list. See `READ_TOOLS`.
 */
const PERMISSIONS: Record<
  ChatPermission,
  {
    /** What this mode runs without being asked, checked in this process by
     * `permitting`. Undefined is "everything" — only `full`. */
    allowed?: string[]
    /** Put at the head of the message rather than into the system prompt — and
     * only on the message where the mode moved, see `headed`. The system
     * prompt is part of the cached prefix, and a per-mode one cost a full
     * re-write on every switch: 42,345 tokens written and none read, against
     * 103 for a turn that changed nothing. */
    prompt?: string
    /** Which unpermitted calls a turn may stop and put on screen rather than
     * refusing outright. `onAsk` is handed to `runAgentTurn` in every mode
     * regardless — see `ASK_TOOL` — this only covers everything else
     * `permits` refused. */
    asks?: (toolName: string) => boolean
    /** Whether a call an account's own ask rule matched is put on screen like
     * any other prompt, rather than allowed — see `deciding`. */
    asksRules?: boolean
  }
> = {
  plan: { allowed: READ_TOOLS, prompt: PLAN_PROMPT },
  read: { allowed: READ_TOOLS, prompt: READ_PROMPT },
  /*
   * The plain CLI, exactly: permits nothing of its own and asks about all of it.
   *
   * That is not four prompts before a file is read, because `canUseTool` is
   * only reached for a call the CLI would itself have prompted on — its own
   * rules (`settings.json`'s allow and deny, a read inside `cwd`) are applied
   * first, and the session loads every settings source. It used to pre-approve
   * `READ_TOOLS` too, which made it the CLI plus a list — and a list is what
   * makes "the terminal does it, the app does not" possible. An "Always allow"
   * here hands back the CLI's own `suggestions`, so it is the same rule the
   * terminal would have written. `AskUserQuestion` reaches here by being
   * unpermitted, like everything else. See `ASK_TOOL`.
   */
  ask: {
    allowed: [],
    prompt: ASK_PROMPT,
    asks: () => true,
    asksRules: true,
  },
  /*
   * Asks about an MCP tool rather than refusing it. Refusing was a mode that
   * runs any `curl` without a word but could not fetch a Figma frame through
   * the server the user's own `claude` already has — the plain CLI asks once
   * and remembers, and this did not even ask. Only MCP: anything else off
   * `ALLOWED_TOOLS` is a built-in this mode deliberately left out.
   */
  edits: { allowed: ALLOWED_TOOLS, asks: isMcpTool },
  /*
   * Nothing is refused except `ASK_TOOL`, and nothing else is asked.
   *
   * This was `bypassPermissions`, and dropping it is what keeps every mode on
   * one `permissionMode`: that mode auto-approves every call before
   * `canUseTool` is reached, so anything this app named as refused was the
   * CLI's business rather than this app's — and one `permissionMode` across the
   * five is what keeps one cached prefix serving all of them. `Full access`
   * still means what its tooltip says: a turn reaching for a tool this app
   * never listed runs rather than stalling. `AskUserQuestion` is the one
   * exception `permitting` carves out of "everything": without it, `full`'s own
   * `allowed: undefined` would auto-answer the model's question with its own
   * unanswered input before `onAsk` ever saw it.
   */
  full: {},
}

/**
 * One `permits` for `claude-agent.ts`, out of a mode's list.
 *
 * Names, matched whole. It used to also read an entry as a server prefix, so
 * `mcp__yasuo-api` stood for every tool on that server; nothing names a
 * server here any more — this app configures none — and a prefix rule with no
 * entry to apply to is a rule that only matters the day somebody misreads it.
 * A tool from a server the CLI found on its own is on no mode's list, which is
 * the point: the modes below say what happens to it.
 *
 * `ASK_TOOL` never comes back permitted, `full`'s `allowed: undefined`
 * included: `deciding` in `claude-agent.ts` only reaches `onAsk` for a call
 * `permits` refused, so letting "everything" cover it too would run the
 * model's question as a no-op tool call instead of putting it on screen.
 */
/** A tool on an MCP server, by the wire name the CLI gives every one of them. */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__")
}

function permitting(allowed: string[] | undefined): (name: string) => boolean {
  if (!allowed) return (name) => name !== ASK_TOOL
  return (name) => name !== ASK_TOOL && allowed.includes(name)
}

/**
 * What the turn is told it is in, and what that costs it.
 *
 * There is exactly one kind of place now: the project's own working tree. There
 * were two while chats could be in a `git worktree` checkout, and the sentence
 * that differed was a *claim* — "edits here cannot disturb the branch you have
 * checked out elsewhere" — which is false here and is the one line worth
 * getting right, since it decides how freely a turn reaches for `Bash` and how
 * much it bothers to ask.
 *
 * One sentence rather than the two it was: the second told the turn what the
 * `yasuo-*` tools were attached to, and there are no such tools now.
 */
const SYSTEM_PROMPT =
  "You are a chat in a project inside Yasuo, a desktop studio: this directory is the user's own working tree on whatever branch they have checked out, so edits and commands here change the files they are working in. There is no isolation to fall back on — prefer the smallest change that does the job, and say what you are about to do before doing anything wide-reaching."

export class WorktreeChats {
  /** A turn per chat, keyed by chat id. Several chats can be answering at once,
   * which is the point of keying everything here by chat id. */
  private readonly live = new Map<string, Live>()

  /**
   * Which `CLAUDE_CONFIG_DIR`s the CLI has been started on each chat in during
   * *this* run — see `WorktreeChat.startedIn`, of which this is the shape in
   * memory.
   *
   * A write-through cache in front of `startedIn` on the record, and not a
   * duplicate of it: the listing is rewritten by a read-modify-write on every
   * appended line, so a turn's first answer could read the listing before
   * `markStarted` had saved and write it back afterwards, dropping the flag it
   * never saw. Both writers merge this in, which is what makes the order between
   * them stop mattering.
   */
  private readonly startedIn = new Map<string, Set<string>>()

  /**
   * Chats `append` named after their first message and `retitle` has not yet
   * renamed — the only ones the CLI's own title may overwrite.
   *
   * In memory rather than a flag on the record, because it is only ever true of
   * a chat whose first turn is running *now*: the CLI writes its title during
   * that turn and never again. An entry leaves on the rename that lands, on the
   * user's own rename, and with the chat.
   */
  private readonly autoTitled = new Set<string>()

  /** Each chat's lines, held so a turn's events can be appended and written
   * without reading the file back on every one of them. Dropped when a chat is
   * deleted; kept otherwise, since a chat somebody is switching between is a
   * chat they are about to read again. */
  private readonly messages = new Map<string, AssistantMessage[]>()

  /**
   * What `digests` folded out of a chat nobody has open, against the
   * `updatedAt` it was folded from.
   *
   * The fold and not the lines, which is the point of it: this is asked for
   * every chat in the workspace whenever the `Changes` list re-reads, and
   * caching the transcripts instead would hold every conversation ever had in
   * memory to save re-reading a file. A record whose `at` no longer matches the
   * listing is simply folded again.
   */
  private readonly digested = new Map<
    string,
    { at: string; digest: ChatDigest }
  >()

  /** The dashboard's rows for a chat nobody has open — the same bargain as
   * `digested`, one row per turn instead of one per chat. */
  private readonly spent = new Map<string, { at: string; rows: ChatSpend[] }>()

  /**
   * Which chats have been told they are over budget, and at what cap.
   *
   * Keyed to the cap rather than to the chat, so a cap that is raised and
   * crossed again says so again, while a chat that keeps running past the same
   * cap is told once rather than after every turn — the line is a warning, and
   * a warning repeated ten times is a transcript nobody can read.
   */
  private readonly budgetWarned = new Map<string, number>()

  /**
   * What `search` keeps of a chat nobody has open: the two voices and nothing
   * else, against the `updatedAt` they were read at — the same bargain as
   * `digested`. Tool output is most of a transcript and none of what is
   * searched, so this is a small fraction of the file it saves re-reading on
   * every keystroke.
   */
  private readonly said = new Map<
    string,
    { at: string; messages: AssistantMessage[] }
  >()

  /**
   * Questions a turn has stopped on, keyed by ask id.
   *
   * By ask rather than by chat, even though a chat has one at a time: an answer
   * names the question it is answering, so a card left on screen after its
   * question was withdrawn cannot decide the next one. `answered` is what the
   * turn is waiting on — calling it is what lets the CLI move.
   *
   * In memory only. What is on the other end is a held tool call in a running
   * process, so there is nothing about it worth writing down: a reload loses the
   * question, and the turn is ended with Stop.
   */
  private readonly asks = new Map<
    string,
    {
      /** Kept beside the resolver so the line recording the decision can say
       * what was decided *about*: an answer on its own is a bare "Allowed". */
      ask: WorktreeChatAsk
      answered: (decision: AskDecision) => void
    }
  >()

  constructor(
    private readonly source: WorktreeChatSource,
    private readonly emit: (event: WorktreeChatEvent) => void
  ) {}

  list(): Promise<WorktreeChat[]> {
    return this.source.chats()
  }

  /**
   * A chat in a project's own working tree, written down.
   *
   * **Not what the `+` calls.** This used to be made up front, on the reasoning
   * that the row has to exist for somebody to type into — a tab that only
   * appears once you have said something is a `+` that does nothing. That is
   * still true and is still how it behaves; what changed is that the tab is the
   * *renderer's* until the first message, so the `+` nobody used costs no row in
   * the project's list and no file on disk. See `unsaved` in
   * `lib/worktree-chat/store.ts`.
   *
   * So `seed` is the usual case rather than the exception: the chat has been on
   * screen, and its id, name and toolbar came from there. The id especially —
   * it is the CLI's session id, and minting a new one here would write down a
   * different chat to the one somebody is looking at.
   *
   * An id already in the listing is **returned as it stands**. Two messages sent
   * before the first write landed would otherwise be two records of one chat,
   * and the second would overwrite the lines of the first.
   */
  async create(place: ChatPlace, seed?: ChatSeed): Promise<WorktreeChat> {
    const chats = await this.source.chats()
    const held = seed && chats.find((chat) => chat.id === seed.id)
    if (held) return held

    const now = new Date().toISOString()
    const chat: WorktreeChat = {
      id: seed?.id ?? randomUUID(),
      folderId: place.folderId,
      // Named by its first message, once there is one — `titleOf`, and then the
      // CLI's own name for it in `retitle`. Until then this is what the tab
      // says; Conductor's own new tab says the same thing.
      title: seed?.title?.trim() || "Untitled",
      ...(seed?.options ? { options: seed.options } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await this.source.saveChats([...chats, chat])
    this.messages.set(chat.id, [])
    return chat
  }

  /** What was said in a chat. Read from disk the first time and cached after. */
  async read(id: string): Promise<AssistantMessage[]> {
    const held = this.messages.get(id)
    if (held) return held

    const messages = await this.source.readChat(id)
    this.messages.set(id, messages)
    return messages
  }

  /**
   * Every chat folded to what it did — see `ChatDigest` and `chat-digest.ts`.
   *
   * **Deliberately not `read`.** That one keeps a chat's whole transcript in
   * memory for the rest of the run, which is the right bargain for a chat
   * somebody is switching between and the wrong one for a fold over *every*
   * chat in the workspace: it would end with every conversation ever had
   * resident, to answer a question whose answer is two numbers and a list of
   * paths. So a chat nobody has open is read, folded and dropped, and what is
   * kept is the fold.
   *
   * Three sources, in the order they cost: the lines already in memory for a
   * chat that is open or running, which is the live case and touches no disk;
   * the digest cached against the `updatedAt` it was folded from, which is what
   * makes the second call on the same tick free; and the file. `updatedAt`
   * moves on every appended line (`append`), so a running chat cannot be served
   * a stale fold from the cache — and it never reaches the cache anyway,
   * because its lines are in memory.
   */
  async digests(): Promise<ChatDigest[]> {
    const chats = await this.source.chats()

    const digests: ChatDigest[] = []
    for (const chat of chats) {
      const place = { id: chat.id, folderId: chatRootId(chat) }

      const held = this.messages.get(chat.id)
      if (held) {
        digests.push(digestOf(place, held))
        continue
      }

      const cached = this.digested.get(chat.id)
      if (cached && cached.at === chat.updatedAt) {
        digests.push(cached.digest)
        continue
      }

      const digest = digestOf(place, await this.source.readChat(chat.id))
      this.digested.set(chat.id, { at: chat.updatedAt, digest })
      digests.push(digest)
    }

    return digests
  }

  /**
   * Every turn's bill across every chat — `digests` with the fold swapped, and
   * the same three sources in the same order. See `spendRows`.
   */
  async spend(): Promise<ChatSpend[]> {
    const chats = await this.source.chats()

    const rows: ChatSpend[] = []
    for (const chat of chats) {
      const place = {
        id: chat.id,
        title: chat.title,
        folderId: chatRootId(chat),
        updatedAt: chat.updatedAt,
      }

      const held = this.messages.get(chat.id)
      if (held) {
        rows.push(...spendRows(place, held))
        continue
      }

      const cached = this.spent.get(chat.id)
      if (cached && cached.at === chat.updatedAt) {
        rows.push(...cached.rows)
        continue
      }

      const folded = spendRows(place, await this.source.readChat(chat.id))
      this.spent.set(chat.id, { at: chat.updatedAt, rows: folded })
      rows.push(...folded)
    }

    return rows
  }

  /**
   * Every chat with a match in what was said, the most recently active first —
   * the left column's Search (`content-search.ts`).
   *
   * Not `read`, for the reason `digests` is not: that keeps a whole transcript
   * resident for the rest of the run. The lines already held are used as they
   * are; the rest go through `said`.
   */
  async search(
    matcher: RegExp,
    limit: number,
    stale: () => boolean
  ): Promise<{ chats: ChatSearchResult[]; matches: number }> {
    const chats = [...(await this.source.chats())].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )

    const found: ChatSearchResult[] = []
    let matches = 0
    for (const chat of chats) {
      if (matches >= limit || stale()) break

      let messages = this.messages.get(chat.id)
      if (!messages) {
        const cached = this.said.get(chat.id)
        if (cached && cached.at === chat.updatedAt) messages = cached.messages
        else {
          messages = (await this.source.readChat(chat.id)).filter(
            (line) => line.role === "user" || line.role === "assistant"
          )
          this.said.set(chat.id, { at: chat.updatedAt, messages })
        }
      }

      const hits = chatMatchesIn(messages, matcher, limit - matches)
      if (hits.length === 0) continue
      matches += hits.length
      found.push({
        chatId: chat.id,
        folderId: chatRootId(chat),
        title: chat.title,
        matches: hits,
      })
    }

    return { chats: found, matches }
  }

  /**
   * Empties a chat and closes the CLI behind it — the composer's `/clear`.
   *
   * **The session goes with the lines, and that is the whole point.** A chat's
   * id is the CLI's session id, and `started` is what decides whether the next
   * message opens a session or `resume`s one. Wiping the transcript alone would
   * leave a chat that looks empty and answers out of the context it was asked to
   * forget — the CLI's own `/clear` is a new session, not an edited one.
   *
   * The close is the same one `delete` does, in the same order and for the same
   * reason: out of the map first, so the `onExit` it causes reads as the
   * expected end it is rather than as a CLI that died.
   *
   * A chat paused on a permission card is the case the `asks` loop is for. That
   * card is a promise the turn is awaiting, and closing the process out from
   * under it would leave the question on screen with nothing behind it — the
   * same settle `dispose` does at shutdown, narrowed to this chat.
   *
   * Nothing is emitted for the lines: the renderer empties its own copy, the way
   * it does for `delete`, and there is no event a chat's *absence* of lines
   * could be. The busy flag is, because it is main's to say and a chat cleared
   * mid-turn would otherwise spin for the rest of the run.
   */
  async clear(id: string): Promise<void> {
    const live = this.live.get(id)
    this.live.delete(id)
    if (live?.idle) clearTimeout(live.idle)
    live?.session?.close()

    for (const [askId, pending] of [...this.asks]) {
      if (pending.ask.chatId !== id) continue
      this.asks.delete(askId)
      pending.answered({ allow: false, message: "That chat was cleared." })
    }

    this.messages.set(id, [])
    this.startedIn.delete(id)
    // Spend is back at nothing, so crossing the same cap again is news again.
    this.budgetWarned.delete(id)
    this.setBusy(id, false)

    await this.source.writeChat(id, [])
  }

  async delete(id: string): Promise<void> {
    const live = this.live.get(id)
    // Out of the map before the close, so the `onExit` it causes reads as the
    // expected end it is rather than as a chat whose CLI died.
    this.live.delete(id)
    if (live?.idle) clearTimeout(live.idle)
    live?.session?.close()

    this.messages.delete(id)
    this.digested.delete(id)
    this.spent.delete(id)
    this.budgetWarned.delete(id)
    this.said.delete(id)
    this.startedIn.delete(id)
    this.autoTitled.delete(id)

    await this.source.saveChats(
      (await this.source.chats()).filter((chat) => chat.id !== id)
    )
    await this.source.deleteChat(id)
  }

  /**
   * One message into a chat, whether or not it is already answering.
   *
   * **Nothing refuses a second message any more.** This used to throw while a
   * turn was in flight, because a turn *was* a process and there was nothing
   * left to say anything to once it had been given its prompt. A session takes
   * the message either way: the CLI queues it and folds it into the next turn,
   * which is what the interactive `claude` does with a line typed mid-answer.
   *
   * The order below is the part worth keeping. The user's line is written down
   * before the session is touched, so a message survives a CLI that will not
   * start — the chat reads back with the question in it and the reason under it,
   * rather than with neither.
   */
  async send(
    id: string,
    prompt: string,
    images: ChatImage[] = []
  ): Promise<void> {
    const chats = await this.source.chats()
    const chat = chats.find((entry) => entry.id === id)
    if (!chat) throw new Error("That chat no longer exists.")

    /*
     * The chat's own project, and nothing else.
     *
     * No fallback chain: a chat whose folder has left the workspace has nowhere
     * to run, and the nearest directory that happens to be readable is not it —
     * a turn landing in a project this chat was never pointed at, with edits
     * pre-approved, is a diff nobody asked for.
     */
    const cwd = chat.folderId
      ? await this.source.folderDir(chat.folderId)
      : null
    if (!cwd) {
      // The place has gone out from under the chat. The conversation is still
      // readable — it is on disk — but there is nowhere to run a turn.
      //
      // Both events, because this is the one refusal no process is involved in:
      // the composer marks a chat busy the moment it sends, and every other way
      // a message ends up going nowhere passes through a session that says so on
      // its way out. Without this the chat spins for the rest of the run.
      this.setBusy(id, false)
      this.endTurn(id, "That project is no longer in the workspace.")
      return
    }

    // Read at send time rather than held: the toolbar writes to the record, and
    // a message takes whatever it said when it was sent. Through `chatOptions`,
    // which is where a record older than either field is brought up to date.
    const options = chatOptions(chat.options)

    // The line keeps the `[Image #n]` and not the picture: a transcript that
    // carried base64 would be megabytes re-read every time the chat is opened.
    await this.append(id, { id: lineId(), role: "user", text: prompt })
    await this.deliver(id, cwd, options, prompt, images)
  }

  /**
   * The mode's own sentence at the head of the message, not in the system
   * prompt — and only when the mode has *moved*.
   *
   * The reason it is on the message is doubled. It was the cached prefix: a
   * per-mode system prompt cost a full re-write on every switch. It is also
   * the only place it *can* go — one session serves every mode this chat is
   * ever put in, and the prompt it was opened with cannot be rewritten for a
   * message sent under a different one.
   *
   * The reason it is not on *every* message is what the sentence costs once it
   * has been read: the conversation already carries it, so repeating it on each
   * of a long chat's messages is the same paragraph billed forty times for a
   * model that read it on the first. `saidMode` is per session rather than per
   * chat, so the one case where the context may not carry it — a fresh session
   * under an id the profile switch could not carry (`isSessionMissing`) — says
   * it again, at worst once per reopened session. A mode with no sentence
   * (`edits`, `full`) still records itself, so switching away and back says the
   * new mode's sentence rather than trusting a stale one.
   */
  private headed(
    live: Live,
    options: WorktreeChatOptions,
    prompt: string,
    images: ChatImage[]
  ): AgentPrompt {
    const said = live.saidMode
    live.saidMode = options.permission

    const permission = PERMISSIONS[options.permission] ?? PERMISSIONS.edits
    const text =
      !permission.prompt || said === options.permission
        ? prompt
        : `${permission.prompt}\n\n${prompt}`
    return images.length > 0 ? { text, images } : text
  }

  /**
   * Gets one message into the chat's CLI, opening one if it has none.
   *
   * The one place a process is reached for, so the "is there one, is it the
   * right one, is somebody else already opening it" question is asked once — and
   * **it delivers**, rather than handing a session back for the caller to push
   * into. That split is what deadlocked this: a session is opened *for* a
   * message, and a caller that waited for the open before sending was waiting
   * for a CLI that had nothing to answer. Both paths below end in the message
   * being queued, and neither can be taken without it.
   */
  private async deliver(
    id: string,
    cwd: string,
    options: WorktreeChatOptions,
    prompt: string,
    images: ChatImage[]
  ): Promise<void> {
    // Asked per message rather than held, because Settings can be changed
    // between two messages in the same chat — and unlike the model, this is an
    // argument the CLI was started with, so a change to it needs a new process.
    // Sorted so that two lists with the same tools in a different order are the
    // same signature and do not close a session for nothing.
    const disabledTools = [...(await this.source.disabledTools())].sort()

    // Looked up by id rather than trusted whole: a profile named on the record
    // can have been renamed or deleted since — see `WorktreeChatOptions.
    // profileId`. A missing id reads as null, the same as never having picked
    // one.
    //
    // Expanded again here rather than trusted from Settings' own save: a profile
    // written before that expansion existed can still carry a literal `~`, and
    // `CLAUDE_CONFIG_DIR` reaches `claude` with no shell in between to expand
    // it — see `expandHome`.
    const profiles = await this.source.claudeProfiles()
    const profileConfigDir = options.profileId
      ? (profiles.find((profile) => profile.id === options.profileId)
          ?.configDir ?? null)
      : null
    const configDir = profileConfigDir ? expandHome(profileConfigDir) : null

    const signature = signatureOf(cwd, configDir, disabledTools)

    const live = this.live.get(id)
    if (live) {
      // The opening one, for a second message that arrived while the CLI was
      // still coming up — which is exactly the case this whole change is for.
      const open = live.opening ? await live.opening : live.session
      if (open && live.signature === signature) {
        this.retune(live, options)
        // The CLI queues it behind whatever it is doing, which is the whole
        // point: this is the path a message typed mid-answer takes.
        open.send(this.headed(live, options, prompt, images))
        return
      }
      // Either it died, or something it was started with has moved. Neither is
      // a session this message can go into. Out of the map first, so the `onExit`
      // the close is about to cause reads it as the expected end it is.
      this.live.delete(id)
      if (live.idle) clearTimeout(live.idle)
      open?.close()
    }

    const entry: Live = {
      session: null,
      opening: null,
      signature,
      configDir,
      model: options.model,
      effort: options.effort,
      options,
      saidMode: null,
      // Ahead of the CLI saying so: the message this is being opened for is
      // about to go in, and a session that read as idle for the second it takes
      // to come up is one `reap` could close under the message.
      busy: true,
      idle: null,
    }
    // In the map *before* the open, because the open reads `options` back off
    // it: `permits` is consulted for the first tool call of the first turn, and
    // an entry that only landed afterwards would be an entry that mode has to
    // fall back for.
    this.live.set(id, entry)

    // Off the record rather than off a `Set` in this process: the CLI's session
    // outlives the app's run, so a chat sent to before a restart has to come
    // back as `--resume`.
    //
    // Asked of *this* config directory, not of the chat: a session is a file
    // under one account's directory, so a chat resumed on the profile it was not
    // started on is resumed against a directory that has never heard of the id.
    // A chat written before that was recorded has only `started`, and resumes
    // the way it always did — see `isSessionMissing`, which is what catches the
    // profile switch it cannot see coming.
    const record = (await this.source.chats()).find((chat) => chat.id === id)
    const dir = configDir ?? ""
    const startedHere =
      this.startedIn.get(id)?.has(dir) === true ||
      record?.startedIn?.includes(dir) === true

    /** A chat from before `startedIn`: the CLI has this id somewhere and the
     * record does not say where, so every profile the workspace knows is a
     * candidate, plus the default directory a chat with no profile ran in. */
    const legacy = record?.started === true && record.startedIn === undefined
    const elsewhere = [
      ...new Set([
        ...(record?.startedIn ?? []),
        ...(this.startedIn.get(id) ?? []),
        ...(legacy
          ? ["", ...profiles.map((profile) => expandHome(profile.configDir))]
          : []),
      ]),
    ].filter((other) => other !== dir)

    // Which is the whole point of switching profile mid-chat rather than
    // starting a new one: the conversation moves with it. `carryTranscript`
    // fails quietly, and a chat that could not be carried opens a new session
    // rather than refusing the message.
    //
    // Asked even when this chat has run here before, which `startedHere` alone
    // would have short-circuited: a directory it has already been in holds the
    // conversation as it stood when it *left*, and A → B → A resumed that rather
    // than what B went on to say. `carryTranscript` is what compares them.
    const carried =
      elsewhere.length > 0 && (await carryTranscript(id, elsewhere, dir))
    const resume =
      startedHere ||
      carried ||
      // Nothing to carry and nothing recorded, but the CLI does have the id —
      // resume the way this always did and let `isSessionMissing` catch it.
      legacy

    // The message goes with it: `open` hands it to the CLI as the work it is
    // coming up to do, so there is no window in which a session exists with an
    // empty queue and a caller waiting on it.
    entry.opening = this.open(
      id,
      cwd,
      options,
      configDir,
      disabledTools,
      resume,
      // Headed here rather than inside `open`, so the retry paths there resend
      // the exact message that failed instead of deciding the head twice.
      this.headed(entry, options, prompt, images)
    )

    await entry.opening
    entry.opening = null
    // `entry.session` is set by `open` rather than here, so that it is in place
    // before anything can be awaited on it — see the `onExit` there, which tells
    // its own session's death from a stale one by exactly that field.
  }

  /**
   * Moves a running session onto the toolbar's current model and effort.
   *
   * Both go over as control requests rather than as a new process, which is the
   * thing streaming input bought that is easiest to overlook: changing model
   * used to mean the next message spawned a `claude` with a different argument
   * list, and now it means the running one is told. Only what actually changed
   * is sent — writing the same model back on every message would be a round
   * trip per message for nothing.
   *
   * The permission is not here on purpose. It is not the CLI's to know: `permits`
   * reads `options` off this record at the moment of each tool call, so putting
   * the picker on `Plan` takes effect on the call after it and needs nothing
   * sent anywhere.
   */
  private retune(live: Live, options: WorktreeChatOptions): void {
    live.options = options

    if (live.model !== options.model) {
      live.model = options.model
      live.session?.setModel(options.model)
    }
    if (live.effort !== options.effort) {
      live.effort = options.effort
      live.session?.setEffort(options.effort)
    }
  }

  /**
   * A turn has stopped on something. Put it on screen and wait.
   *
   * The promise this returns *is* the pause: the CLI is holding the tool call
   * until it settles, and nothing on this side times it out — somebody has to
   * read the question, and a question that answered itself after thirty seconds
   * would be this app deciding.
   *
   * Two shapes out of one callback, because the CLI asks two different things
   * through it: `AskUserQuestion` is the model asking the user to choose, and
   * everything else is the model asking to be allowed. They are told apart by
   * tool name, which is the only thing that distinguishes them.
   */
  private ask(chatId: string, request: AskRequest): Promise<AskDecision> {
    const id = randomUUID()
    const questions =
      request.toolName === ASK_TOOL ? asked(request.input) : null

    const ask: WorktreeChatAsk = questions
      ? { id, chatId, kind: "questions", questions }
      : {
          id,
          chatId,
          kind: "tool",
          // The CLI's own sentence when there is one, and `titleFor` otherwise
          // — which is most of the time, so it is not really a fallback.
          title: request.title ?? titleFor(request.toolName, request.input),
          name: request.toolName,
          summary: summarise(request.input),
          always: request.canRemember,
        }

    return new Promise<AskDecision>((resolve) => {
      const settle = (decision: AskDecision) => {
        if (!this.asks.delete(id)) return
        resolve(decision)
      }

      this.asks.set(id, { ask, answered: settle })
      // The turn ending under a question — Stop, or the process dying — leaves
      // the CLI with nothing to receive an answer, so the wait has to end too or
      // this promise is held for the life of the app.
      request.signal.addEventListener("abort", () =>
        settle({ allow: false, message: "The turn was stopped." })
      )
      this.emit({ chatId, type: "ask", ask })
    })
  }

  /**
   * What the user said, back to the turn that is waiting.
   *
   * Silent about an id nothing is waiting on: a card can be answered twice — a
   * click and the keyboard, or a window that had not yet heard the turn was
   * stopped — and the second one has nothing left to decide.
   *
   * The decision is written into the conversation before it is handed over,
   * which is the part worth keeping: the question is gone once it is answered,
   * and a transcript that shows a turn editing a file with no sign of anybody
   * allowing it is a transcript that is missing the reason.
   */
  answer(askId: string, answer: WorktreeChatAnswer): void {
    const pending = this.asks.get(askId)
    if (!pending) return

    void this.append(pending.ask.chatId, {
      id: lineId(),
      role: "ask",
      text: said(pending.ask, answer),
    })

    pending.answered(decided(answer))
  }

  /**
   * What a chat is called.
   *
   * A title is otherwise the first thing that was asked in it, which is a
   * sentence rather than a name — and a chat found again in the column a week
   * later is found by what it was *about*. `append` only titles a chat still
   * called `Untitled`, so a renamed one keeps the name through its next turn.
   *
   * A read-modify-write of the listing like `setOptions`, for the same reason.
   */
  async rename(id: string, title: string): Promise<void> {
    const name = title.trim()
    if (!name) return

    // A chat somebody has named is not renamed out from under them, including
    // by a turn still running — see `retitle`.
    this.autoTitled.delete(id)

    const chats = await this.source.chats()
    if (!chats.some((chat) => chat.id === id)) return

    await this.source.saveChats(
      chats.map((chat) => (chat.id === id ? { ...chat, title: name } : chat))
    )
  }

  /**
   * The model, effort and permission for one chat.
   *
   * Whole rather than a patch, so two controls changed in quick succession
   * cannot merge into a state neither of them asked for. A read-modify-write of
   * the listing like every other change to it — the store's own queue serialises
   * them, so this cannot interleave with the line a turn is appending.
   *
   * **A running session is moved too**, which it never used to be: the options
   * were the process's argument list, so a chat mid-turn kept whatever it had
   * started with. Model and effort now go over as control requests and the
   * permission is read per tool call — see `retune`. What still cannot move
   * under a running session is the project, the profile and the MCP config;
   * those are picked up by the next message, which opens a new one.
   */
  async setOptions(id: string, options: WorktreeChatOptions): Promise<void> {
    const chats = await this.source.chats()
    if (!chats.some((chat) => chat.id === id)) return

    await this.source.saveChats(
      chats.map((chat) => (chat.id === id ? { ...chat, options } : chat))
    )

    const live = this.live.get(id)
    if (live) this.retune(live, options)
  }

  /**
   * Opens the CLI on one chat, or reports that it could not be opened.
   *
   * Apart from `deliver` because of the retry below, and apart from `send`
   * because a session that has to be opened a second time must give the CLI the
   * same message again without writing that message down a second time.
   *
   * Everything handed over that a mode could change is handed over as a
   * **function**: `permits` and `onAsk` read the live record when they are
   * called, so one process serves whatever the picker is set to at the time. The
   * fixed half — the tool refusals, the permission mode, the system prompt — is
   * the same on every session of every mode, which is what keeps one cached
   * prefix serving all five.
   */
  private async open(
    id: string,
    cwd: string,
    options: WorktreeChatOptions,
    configDir: string | null,
    /** The workspace's switched-off MCP tools — see `AgentSessionOptions.
     * disallowedTools`. */
    disabledTools: string[],
    resume: boolean,
    /** The message the session is being opened for, queued by
     * `startAgentSession` before it waits for the CLI. */
    message: AgentPrompt
  ): Promise<AgentSession | null> {
    /** Set once the session is this object's to report the death of. Until then
     * the reporting is done below, which is what lets the retry swallow the
     * failure it is retrying. */
    let mine = false
    let exited = false
    let exitError: string | null = null
    /** This session, once it exists, for telling its own death from that of one
     * already replaced — see `onExit`. */
    let opened: AgentSession | null = null

    /**
     * The entry this open is for, and whether it is still the chat's.
     *
     * Everything below that describes a *live process* — busy, the subagents,
     * the context meter — has to be dropped once the chat has moved on to
     * another session, and `close()` is exactly when that matters: the abort it
     * raises reaches the stream a tick later, and the `exit` that follows calls
     * `onBusy(false)` and `onAgents([])` unconditionally. Switching profile
     * mid-chat closes one session and opens another for the same message, so
     * that late `false` landed on the *new* session's turn and the chat went
     * quiet on screen while it was still answering — and armed `reap` against a
     * session that was working.
     *
     * By the entry rather than by `entry.session`, which is what `onExit` can
     * afford to use: the first `onBusy(true)` arrives from inside
     * `startAgentSession`, before there is a session object to compare.
     */
    const owner = this.live.get(id)
    const current = () => this.live.get(id) === owner

    const session = await startAgentSession(
      {
        cwd,
        sessionId: id,
        resume,
        // Both null unless the toolbar says otherwise, which leaves the user's
        // own `claude` deciding — see `AgentSessionOptions`. What it is *now*
        // rather than for ever: `retune` moves a running session.
        model: options.model,
        effort: options.effort,
        configDir,
        // The mode's own policy, applied in this process and read per call. What
        // goes to the CLI is identical for every mode, which is what keeps one
        // cached prefix serving all five — see `permits` in `claude-agent.ts`.
        permits: (name) => permitting(this.permissionOf(id).allowed)(name),
        asksRules: () => this.permissionOf(id).asksRules === true,
        // Not a mode's business and not read per call: the same list for every
        // turn of this session, which is what keeps it inside the cached prefix.
        disallowedTools: disabledTools,
        permissionMode: "manual",
        // The same sentence for every mode. What the mode is goes at the head of
        // each message instead: this one is part of the cached prefix, and one
        // session answers messages sent under several modes.
        appendSystemPrompt: SYSTEM_PROMPT,
        // Always handed over, unlike the tool list above: an `AskUserQuestion`
        // call is the model asking the user, not asking for permission, and
        // every mode puts it on screen. For anything else `permits` refused,
        // only the mode's own `asks` says whether this asks or refuses outright
        // — its absence is what stops the other four ever pausing on those.
        onAsk: (request: AskRequest) =>
          request.toolName === ASK_TOOL ||
          this.permissionOf(id).asks?.(request.toolName)
            ? this.ask(id, request)
            : Promise.resolve({
                allow: false,
                message: `${request.toolName} is not one of the tools this chat may use, and this mode has nobody to ask.`,
              }),
      },
      {
        onMessage: (message) => void this.append(id, message),
        onToolResult: (toolId, result, output, failed) =>
          this.recordResult(id, toolId, result, output, failed),
        // A line like any other, so it is written down and read back with the
        // rest of the conversation rather than held for the window that
        // happened to be open when the turn ended.
        onUsage: (usage) =>
          void this.append(id, { id: lineId(), role: "usage", usage }),
        // Forwarded and not kept, like `busy`: the same number is on the usage
        // line this turn ends with, and this is only it arriving early enough
        // to watch. A window that reloads mid-turn reads the last line instead.
        onContext: (tokens) => {
          if (current()) this.emit({ chatId: id, type: "context", tokens })
        },
        // Forwarded and not kept, for the same reason as `busy` rather than as
        // `context`: this is the state of a live process. A chat read back off
        // disk has no session to have asked, so a stored copy would be a meter
        // describing a window that no longer exists.
        onWindow: (window) => {
          if (current()) this.emit({ chatId: id, type: "window", window })
        },
        onCompacting: (compacting, error) => {
          if (current())
            this.emit({ chatId: id, type: "compacting", compacting, error })
        },
        // A line, unlike the two above: a compaction happened *at a point in
        // the conversation*, and everything above it is something the model now
        // knows only as a summary. That is worth reading back next week.
        onCompacted: (compacted) =>
          void this.append(id, {
            id: lineId(),
            role: "compact",
            ...compacted,
          }),
        // Forwarded and kept: the renderer draws it, and `reap` needs it to know
        // it is not closing a session mid-turn. Nothing is written down —
        // whether a chat is working is true of a process rather than of a
        // conversation, and a reload finds out by there being no session rather
        // than by reading a stale flag.
        onBusy: (busy) => {
          if (current()) this.setBusy(id, busy)
        },
        // Forwarded and not kept, like `busy` and for the same reason: which
        // subagents are running is true of a live CLI, and a chat read back off
        // disk has none. What they *did* is the tool rows they wrote.
        onAgents: (agents) => {
          if (current()) this.emit({ chatId: id, type: "agents", agents })
        },
        onTurn: (error) => {
          if (current()) this.endTurn(id, error)
        },
        onExit: (error) => {
          exited = true
          exitError = error
          if (!mine) return

          /*
           * Only where this is still the chat's own session.
           *
           * A session that was reaped, or replaced because the project moved,
           * was taken out of the map *before* it was closed, so what this finds
           * is either nothing or somebody else's — and either way its death was
           * asked for and is not news. Compared by identity rather than by the
           * entry existing, because the chat can already have opened a second
           * session by the time the first one's stream finishes closing.
           */
          const live = this.live.get(id)
          if (!live || live.session !== opened) return

          // The process is gone, so the chat has no session — the next message
          // opens one, as a resume.
          if (live.idle) clearTimeout(live.idle)
          this.live.delete(id)
          this.endTurn(id, error)
        },
      },
      message
    )

    if (session && !exited) {
      const entry = this.live.get(id)
      // Deleted while the CLI was coming up, which `delete` does without
      // knowing there was a process on the way.
      if (!entry) {
        session.close()
        return null
      }

      // Both before the first `await` below, and in this order: `onExit` reads
      // `entry.session` to recognise its own death, and `mine` is what lets it
      // read at all. A window between them is a real crash reported as a stale
      // one, or worse, swallowed.
      entry.session = session
      opened = session
      mine = true

      // From here the CLI owns this id, so the next session resumes it rather
      // than asking for it again — including one opened after a failure, and
      // including one after a restart, which is why this is written down.
      //
      // Only once the CLI is actually up: `startAgentSession` hands back null
      // when it could not be started at all, and a session the CLI never opened
      // must not be resumed on the next try. It resolves on the CLI's first
      // message rather than on the call returning, because `query()` is lazy —
      // see its comment.
      await this.markStarted(id, configDir)

      // Awaiting a file write above means the process can have died in the
      // meantime, in which case `onExit` has reported it and taken the entry
      // out. Handing the session back anyway would hand back a corpse.
      return this.live.get(id) === entry ? session : null
    }

    // It never came up, or it came up and died in the same breath.
    session?.close()

    /*
     * The CLI already has this session — open it again as a resume.
     *
     * This is what a chat written before `started` was a field looks like: the
     * id was used in an earlier run of the app, nothing on the record says so,
     * and the session that would have written it down is the one being refused.
     * Guessing from the transcript instead would be guessing — a chat can hold
     * lines from a session that died before the CLI opened anything — so the
     * answer is taken from the CLI, which is the only party that knows.
     *
     * Once, and only where this attempt did not already resume, so a genuine
     * failure is still reported rather than retried for ever.
     *
     * This is the **only** error an open is retried on, and the test for it is
     * narrow for that reason. A model the CLI refused used to be retried too —
     * silently, on the CLI's own default, with the toolbar rewritten underneath
     * — which meant the error line said the model does not exist and an answer
     * arrived anyway, from a model nobody picked, billed at whatever that one
     * costs. A refused model is a failure the user has to see and decide about,
     * so it stops here.
     */
    if (!resume && exitError !== null && isSessionTaken(exitError)) {
      // The same message, which the retry is *for* — it was never delivered, and
      // it is already written down, so it must not be appended again.
      return this.open(
        id,
        cwd,
        options,
        configDir,
        disabledTools,
        true,
        message
      )
    }

    /*
     * The mirror of it: this profile has never had this session, so open it.
     *
     * A session lives under one account's `CLAUDE_CONFIG_DIR`, and the profile
     * picker moves a chat between them mid-conversation — so the id this chat
     * *is* names a conversation in the directory it was started in and nothing
     * at all in the one it has just been moved to. `startedIn` is what keeps
     * this from happening at all, and this is what covers the chats written
     * before that field existed, whose record says only that the CLI has the id
     * somewhere.
     *
     * What the new session does *not* get is the conversation: the lines are
     * this app's, the context was the other account's, and there is nothing to
     * carry across. That is what changing account means, and it is the reason
     * this is a fresh session rather than a failure — the alternative is a chat
     * that can never be spoken into again.
     *
     * Narrow, once, and only the other way round, for the same reason
     * `isSessionTaken` is.
     */
    if (resume && exitError !== null && isSessionMissing(exitError)) {
      return this.open(
        id,
        cwd,
        options,
        configDir,
        disabledTools,
        false,
        message
      )
    }

    // Only this open's own entry: a chat that has already been given another
    // session — the profile picker closes one and opens the next — must not have
    // it taken back out from under it by a failure that belongs to the old one.
    if (current()) {
      this.live.delete(id)
      this.endTurn(id, exitError)
    }
    return null
  }

  /**
   * What the chat's picker is set to right now, for `permits` and `onAsk`.
   *
   * Two fallbacks, and they go opposite ways on purpose.
   *
   * A mode this build has never heard of — a chat written by a newer one — falls
   * back to `edits`, because the record is a chat somebody is using and the
   * alternative is `undefined`, which `permitting` reads as "everything".
   *
   * **No record at all falls back to nothing.** That state is only reachable
   * while a session is being taken away — the chat deleted, the process
   * closing — and a tool call arriving in that window is one nobody is watching.
   * Widening it to `edits` there would be this app permitting a write on the way
   * out; `allowed: []` refuses it with a sentence instead.
   */
  private permissionOf(id: string): (typeof PERMISSIONS)[ChatPermission] {
    const live = this.live.get(id)
    if (!live) return { allowed: [] }
    return PERMISSIONS[live.options.permission] ?? PERMISSIONS.edits
  }

  /**
   * The chat is working, or it is not — told to the renderer and to the clock.
   *
   * The clock half is what keeps this app from leaving a `claude` per
   * conversation resident for the afternoon: a session that goes quiet is given
   * `IDLE_MS` and then closed, and one that starts working again has the timer
   * taken off it. Armed on the *transition* to quiet, and re-armed by every
   * later `false`, which costs one `clearTimeout` per repeat and is worth it —
   * the alternative is remembering which of two sources last spoke.
   */
  private setBusy(id: string, busy: boolean): void {
    this.emit({ chatId: id, type: "busy", busy })

    const live = this.live.get(id)
    if (!live) return

    live.busy = busy
    if (live.idle) clearTimeout(live.idle)
    live.idle = busy ? null : setTimeout(() => this.reap(id), IDLE_MS)
    // Nothing in this app waits on the app: a chat quiet at quitting time must
    // not be the reason Electron stays up for five more minutes.
    live.idle?.unref?.()
  }

  /**
   * Closes a session that has had nothing to do for `IDLE_MS`.
   *
   * Quietly, and that is the point: the entry comes out of the map *before* the
   * close, so the `onExit` this causes reads as the expected end it is and
   * writes no line. Nothing is lost — the conversation is on disk and the next
   * message opens the session again as a resume, which is what every message
   * used to do.
   */
  private reap(id: string): void {
    const live = this.live.get(id)
    // Busy is the race this is written against: a turn can start between the
    // timer being armed and it firing.
    if (!live || live.busy) return

    this.live.delete(id)
    live.session?.close()
  }

  /**
   * Stops the running turn without ending the session.
   *
   * An interrupt rather than a kill, which is what the button meant all along:
   * killing the process was only ever how a turn was stopped when a turn *was*
   * the process, and it cost the chat its warm CLI as well. Whatever was queued
   * behind the interrupted turn still runs — the CLI's own rule, and the same
   * one the terminal follows.
   */
  stop(id: string): void {
    this.live.get(id)?.session?.interrupt()
  }

  /** Closes every session, for shutdown. */
  dispose(): void {
    for (const live of this.live.values()) {
      if (live.idle) clearTimeout(live.idle)
      live.session?.close()
    }
    this.live.clear()
    // Nothing is going to answer these now, and each one is a promise a turn is
    // still awaiting — see `asks`.
    for (const pending of [...this.asks.values()]) {
      pending.answered({ allow: false, message: "The app is closing." })
    }
  }

  /**
   * Writes down that the CLI has this id now.
   *
   * A read-modify-write of the listing like every other change to it — the
   * store's own queue serialises them, so this cannot interleave with the title
   * the same turn is about to set.
   */
  private async markStarted(
    id: string,
    configDir: string | null
  ): Promise<void> {
    const dir = configDir ?? ""
    const dirs = this.startedIn.get(id) ?? new Set<string>()
    if (dirs.has(dir)) return
    dirs.add(dir)
    this.startedIn.set(id, dirs)

    try {
      const chats = await this.source.chats()
      if (!chats.some((chat) => chat.id === id)) return
      await this.source.saveChats(
        chats.map((chat) =>
          chat.id === id
            ? { ...chat, started: true, startedIn: startedDirs(chat, dirs) }
            : chat
        )
      )
    } catch (error) {
      // Worth a line in the log and not worth failing the turn over: the cost
      // is one refused `--session-id` on the next launch, and the turn that is
      // running right now is fine.
      console.error("Could not record that the chat has started", error)
    }
  }

  /**
   * One turn is over, whatever else the chat has queued.
   *
   * **It does not touch the session**, which is the whole of what changed here:
   * this used to be `finish`, and dropping the `live` entry was how the next
   * message knew to spawn a process. Now the entry is the process, a turn ending
   * is not the process ending, and the two ends that *are* — a CLI that died, a
   * chat with nowhere to run — delete it themselves before calling this.
   *
   * Nor does it say the chat is idle: a message queued behind this turn will run
   * without anybody sending anything, and only the session knows whether one is.
   * See `onBusy`.
   */
  private endTurn(id: string, error: string | null): void {
    /*
     * Any question this chat was holding goes with the turn.
     *
     * Belt and braces beside the abort listener in `ask`: that fires when the
     * SDK's own signal trips, and this covers the ends that do not go through
     * it — a result that arrived while a request was outstanding, a process that
     * died. An entry left here would be a card on screen answering into
     * nothing, and `answer` would write a decision line for a turn that is over.
     */
    for (const pending of [...this.asks.values()]) {
      if (pending.ask.chatId !== id) continue
      // `answered` is what removes the entry — deleting it here first would
      // trip its own once-only guard and leave the promise unresolved.
      pending.answered({ allow: false, message: "The turn ended." })
    }

    /*
     * The one place a failure becomes a line, and it says so once.
     *
     * `append` announces it as an `error` event; `done` below only ends the
     * turn. They used to be the same event, which made every failure that
     * reached a result line arrive twice — once from the agent's own error line
     * and once from this one — and left two of them in the chat's file for the
     * next open. The agent no longer draws its own; this is it.
     */
    if (error) {
      void this.append(id, { id: lineId(), role: "error", text: error })
    }
    /*
     * `done` is what the renderer re-reads the listing on, so the name
     * `retitle` is about to write has to be in the file before it goes out —
     * otherwise the re-read is a stale title landing on top of the fresh one.
     *
     * The wait is a microtask for every turn but a chat's first: `retitle`
     * returns at the `autoTitled` test without touching the disk, and it never
     * rejects — a failure there leaves the chat named after its first message,
     * which is what it was named before any of this existed.
     */
    void this.retitle(id).then(() => {
      this.emit({ chatId: id, type: "done", error })
    })
  }

  /**
   * The name the CLI gave the conversation, once it has given one.
   *
   * `append` names a chat after the first thing asked in it, which is a sentence
   * rather than a name — and a chat found again in the column a week later is
   * found by what it was *about*. The CLI writes exactly that name for itself:
   * an `ai-title` entry in the session's own transcript, produced off the first
   * message by a model of its own, so this costs the chat's session no tokens
   * and this app no turn of its own — which is the only reason it is here at
   * all, `CLAUDE.md` refusing features that call the CLI as a helper.
   *
   * **The file is the only place it exists.** Nothing on the SDK's message
   * stream carries it and there is no control request that asks; `getSessionInfo
   * ()` would answer, but it reads the config directory of *this* process, and a
   * chat on a profile is under a `CLAUDE_CONFIG_DIR` of its own.
   *
   * Read once the turn is over, by which time it has long been written — the CLI
   * appends it ahead of the turn's first reply. A turn that ends before it lands
   * simply leaves the sentence in place: `autoTitled` still holds the chat, so
   * the next turn's end looks again.
   */
  private async retitle(id: string): Promise<void> {
    if (!this.autoTitled.has(id)) return

    try {
      const title = await aiTitleOf(this.live.get(id)?.configDir ?? null, id)
      // `delete` rather than a second `has`: the read above was awaited, and a
      // rename that landed in the meantime is the user naming the chat.
      if (!title || !this.autoTitled.delete(id)) return

      const chats = await this.source.chats()
      if (!chats.some((chat) => chat.id === id)) return
      await this.source.saveChats(
        chats.map((chat) => (chat.id === id ? { ...chat, title } : chat))
      )

      this.emit({ chatId: id, type: "title", title })
    } catch (error) {
      // The chat keeps the sentence it was named after, which is what it had
      // before any of this existed.
      console.error("Could not read the chat's own title", error)
    }
  }

  /**
   * Appends one line, writes it down, and tells the renderer.
   *
   * The listing is touched on the same pass: a chat's first user line is also
   * its title, and every line afterwards moves it up the list. A failed write
   * costs the record of a line and is not worth abandoning a turn over — the
   * store's own queue serialises them, so the file cannot be interleaved.
   *
   * **The user's own line is written but not announced.** A `text` event is a
   * line of the answer — it carries no role, because everything streaming out
   * of a turn is the model's — so emitting the prompt through it drew the
   * question a second time in the answer's own style, under the bubble the
   * composer had already put on screen. The only window that could receive it
   * is the one that typed it, and that window has it.
   */
  /**
   * What a tool call came back with, onto the line that call already wrote.
   *
   * **Synchronous over the held lines, and only those.** Every other write here
   * is a read-modify-write with an `await` in the middle, and that is safe for
   * an append because the store's queue serialises the files; it is not safe for
   * a change to a line the same turn is appending after. Between a turn's first
   * message and its last the lines are in memory by definition — `append` put
   * them there — so a patch that finds nothing held is a patch for a chat no
   * turn is running in, which is a result for a call that cannot still be
   * outstanding.
   *
   * A call whose line has no `toolId` is left alone: that is a line written
   * before ids existed, read back off disk, and there is nothing to match it by.
   */
  private recordResult(
    id: string,
    toolId: string,
    result: string,
    output: string | undefined,
    failed: boolean
  ): void {
    const messages = this.messages.get(id)
    if (!messages) return

    let found = false
    const next = messages.map((line) => {
      if (found || line.role !== "tool" || line.toolId !== toolId) return line
      found = true
      return { ...line, result, failed, ...(output ? { output } : {}) }
    })
    if (!found) return
    this.messages.set(id, next)

    this.emit({
      chatId: id,
      type: "tool-result",
      toolId,
      result,
      ...(output ? { output } : {}),
      failed,
    })

    // Written without awaiting, like the line itself: losing the record of what
    // a tool returned is not worth abandoning a turn over.
    void this.source.writeChat(id, next).catch((error: unknown) => {
      console.error("Could not write the chat", error)
    })
  }

  private async append(id: string, line: AssistantMessage): Promise<void> {
    // Stamped here, the one writer, so every line carries the same clock — and
    // only when the caller did not bring one, which nothing does yet.
    const message: AssistantMessage = {
      ...line,
      at: line.at ?? new Date().toISOString(),
    }
    const messages = [...(await this.read(id)), message]
    this.messages.set(id, messages)

    if (message.role !== "user") {
      this.emit(
        message.role === "tool"
          ? {
              chatId: id,
              type: "tool",
              name: message.name,
              summary: message.summary,
              toolId: message.toolId,
              title: message.title,
              path: message.path,
              input: message.input,
              stat: message.stat,
              change: message.change,
            }
          : message.role === "error"
            ? { chatId: id, type: "error", text: message.text }
            : message.role === "ask"
              ? { chatId: id, type: "decision", text: message.text }
              : message.role === "thinking"
                ? { chatId: id, type: "thinking", text: message.text }
                : message.role === "usage"
                  ? { chatId: id, type: "usage", usage: message.usage }
                  : message.role === "compact"
                    ? {
                        chatId: id,
                        type: "compact",
                        trigger: message.trigger,
                        preTokens: message.preTokens,
                        postTokens: message.postTokens,
                        durationMs: message.durationMs,
                      }
                    : { chatId: id, type: "text", text: message.text }
      )
    }

    try {
      await this.source.writeChat(id, messages)

      const chats = await this.source.chats()
      const existing = chats.find((chat) => chat.id === id)
      if (!existing) return

      // After the usage line is on disk and before the listing moves, so the
      // warning reads the total this turn made rather than the one before it.
      if (message.role === "usage") this.checkBudget(id, existing, messages)

      const titled =
        existing.title === "Untitled" && message.role === "user"
          ? titleOf(message.text)
          : existing.title
      // This name is a sentence and stands in for the one the CLI is about to
      // write — see `retitle`, which only touches a chat named here.
      if (titled !== existing.title) this.autoTitled.add(id)

      await this.source.saveChats(
        chats.map((chat) =>
          chat.id === id
            ? {
                ...chat,
                title: titled,
                // Merged in rather than carried through: this listing may have
                // been read before `markStarted` saved — see `startedIn`.
                started: chat.started === true || this.startedIn.has(id),
                startedIn: startedDirs(chat, this.startedIn.get(id)),
                updatedAt: new Date().toISOString(),
              }
            : chat
        )
      )
    } catch (error) {
      console.error("Could not write the chat", error)
    }
  }

  /**
   * Says, once per cap, that a chat has spent past the cap its toolbar set.
   *
   * An `error` line rather than a new role: it is drawn in the colour a thing
   * worth stopping for is drawn in, `notify.ts` already rings a failure while
   * the window is unfocused, and a chat read back next week shows where the
   * money ran out. The turn itself is not stopped — see `budgetUsd`.
   */
  private checkBudget(
    id: string,
    chat: WorktreeChat,
    messages: AssistantMessage[]
  ): void {
    const cap = chatOptions(chat.options).budgetUsd ?? null
    if (cap === null) {
      this.budgetWarned.delete(id)
      return
    }
    const { costUsd } = spendOf(messages)
    if (costUsd < cap) return
    if (this.budgetWarned.get(id) === cap) return

    this.budgetWarned.set(id, cap)
    void this.append(id, {
      id: lineId(),
      role: "error",
      text: `Over budget: this chat has spent $${costUsd.toFixed(2)} of its $${cap.toFixed(2)} cap. The next message still goes — raise or clear the cap in the toolbar if that is what you want.`,
    })
  }
}

/**
 * What the card says a turn is trying to do.
 *
 * The SDK documents a rendered `title` and in practice does not send one for a
 * plain SDK run — it comes from the bridge the interactive CLI uses — so this is
 * what somebody actually reads before deciding, not a fallback that never fires.
 * Which is why it is a sentence per tool rather than the tool's name: "Claude
 * wants to use Bash" over a card, with the command on the line below, asks
 * somebody to work out what they are being asked.
 *
 * A verb per tool this app pre-approves *anywhere*, because those are the ones
 * that can reach here; anything else gets its name, which is the honest answer
 * for a tool this app has never heard of.
 */
export function titleFor(tool: string, input: Record<string, unknown>): string {
  const named = (key: string) => {
    const value = input[key]
    return typeof value === "string" && value.trim() ? collapse(value) : null
  }

  const path = named("file_path") ?? named("path") ?? named("notebook_path")
  switch (tool) {
    case "Bash":
      return `Claude wants to run ${named("command") ?? "a command"}`
    case "Write":
      return `Claude wants to create ${path ?? "a file"}`
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Claude wants to edit ${path ?? "a file"}`
    case "Read":
      return `Claude wants to read ${path ?? "a file"}`
    case "WebFetch":
      return `Claude wants to fetch ${named("url") ?? "a page"}`
    case "WebSearch":
      return `Claude wants to search the web for ${named("query") ?? "something"}`
    default:
      return `Claude wants to use ${tool}`
  }
}

/**
 * The questions out of an `AskUserQuestion` call, or null.
 *
 * Null for anything that does not have them, which is what makes the call a
 * permission request instead: the tool name says which kind it is, and this says
 * whether the payload agrees. A newer CLI that changes the shape lands here
 * rather than in the pane.
 */
export function asked(
  input: Record<string, unknown>
): ChatAskQuestion[] | null {
  const questions = Array.isArray(input.questions) ? input.questions : []
  const read = questions.flatMap((entry): ChatAskQuestion[] => {
    const question = entry as Record<string, unknown>
    const options = Array.isArray(question.options) ? question.options : []
    if (typeof question.question !== "string" || options.length === 0) return []

    return [
      {
        question: question.question,
        header:
          typeof question.header === "string"
            ? question.header
            : question.question,
        options: options.flatMap((value): ChatAskOption[] => {
          const option = value as Record<string, unknown>
          if (typeof option.label !== "string") return []
          return [
            {
              label: option.label,
              description:
                typeof option.description === "string"
                  ? option.description
                  : "",
            },
          ]
        }),
        multiSelect: question.multiSelect === true,
      },
    ]
  })

  // A question with no answerable option is not a question: it would draw a
  // card with nothing to click, and the turn would wait for ever.
  return read.some((question) => question.options.length > 0) ? read : null
}

/**
 * The answer, as the SDK wants it back.
 *
 * `AskUserQuestion` is answered by **allowing the call with the answers written
 * into its input** — an odd shape until you notice it is the same channel a
 * permission travels down, so the tool "runs" with what the user picked. The
 * original questions have to go back with it, which the SDK is explicit about.
 *
 * The labels are joined rather than passed as an array: a single-select question
 * wants one string, and joining a one-element list gives exactly that, so there
 * is one path instead of a branch on `multiSelect` that could disagree with the
 * one in the pane.
 */
export function decided(answer: WorktreeChatAnswer): AskDecision {
  if (answer.kind === "allow") {
    return { allow: true, remember: answer.always === true }
  }
  if (answer.kind === "deny") {
    return {
      allow: false,
      // Read by the model, which is the point: "no" on its own invites another
      // attempt at the same thing.
      message:
        "The user declined this. Do not try it again; say what you would need instead, or carry on with the rest of the work.",
    }
  }
  return {
    allow: true,
    input: {
      answers: Object.fromEntries(
        Object.entries(answer.answers).map(([question, labels]) => [
          question,
          labels.join(", "),
        ])
      ),
    },
  }
}

/**
 * The line a decision leaves in the conversation.
 *
 * Written for somebody reading the chat back later, so it names the thing rather
 * than the mechanism: what was allowed, what was refused, what was chosen. The
 * pane draws it as a note rather than as anybody's message, because it is
 * neither side speaking.
 */
export function said(ask: WorktreeChatAsk, answer: WorktreeChatAnswer): string {
  if (ask.kind === "questions") {
    if (answer.kind !== "answers") return "Question dismissed"
    return ask.questions
      .map((question) => {
        const picked = answer.answers[question.question] ?? []
        return `${question.header}: ${picked.join(", ") || "no answer"}`
      })
      .join(" · ")
  }

  const what = ask.summary ? `${ask.name}: ${ask.summary}` : ask.name
  if (answer.kind === "deny") return `Refused ${what}`
  // `always` only reads as "remembered" where there was a rule to remember —
  // see `WorktreeChatAsk.always`.
  const remembered = answer.kind === "allow" && answer.always && ask.always
  return remembered
    ? `Allowed ${what}, and will not ask again`
    : `Allowed ${what}`
}

/**
 * What a session cannot be changed out from under.
 *
 * The things the CLI took as arguments and has no control request for: the
 * directory it runs in, the account it runs as, and the tool list it was started
 * with. A chat whose project moved, whose profile was switched, or whose
 * switched-off MCP tools changed in Settings is a chat the running process is
 * answering *wrongly*, so the next message closes it and opens another rather
 * than being queued into it. (There was a fourth — the MCP config file this app
 * wrote — and it went with the servers it named.) Model, effort and permission
 * are deliberately absent: those move under a live session, which is the point
 * of `retune`.
 *
 * A joined string rather than an object compared field by field, because it is
 * only ever tested for equality and a null is a real value here: "no profile" is
 * a state a session can be in, and it must not compare equal to a profile named
 * `""`. `\0` is the separator because the first two are paths and it is the one
 * byte a path cannot hold — a separator that could turn up inside one is two
 * different signatures comparing equal. The tool list is joined on `\n`, which a
 * tool name cannot hold either, and is expected **sorted** by the caller so that
 * the same set in another order is the same signature.
 */
function signatureOf(
  cwd: string,
  configDir: string | null,
  disabledTools: string[]
): string {
  return [cwd, configDir ?? "", disabledTools.join("\n")].join("\0")
}

/**
 * Whether the CLI refused an id because it already has that session.
 *
 * Matched on the text because that is all there is: the CLI exits non-zero with
 * a message, and there is no code to switch on. Deliberately narrow — it is the
 * trigger for running a turn a second time, and a looser test would rerun turns
 * that failed for some other reason.
 */
function isSessionTaken(error: string): boolean {
  return /session id .* is already in use/i.test(error)
}

/**
 * Whether the CLI refused to resume because it has no such session.
 *
 * Matched on the text for the same reason `isSessionTaken` is, and just as
 * narrowly: it is the trigger for starting a *new* conversation under an id the
 * user believes is an old one, so anything looser would throw a chat's context
 * away over an unrelated failure.
 */
function isSessionMissing(error: string): boolean {
  return /no conversation found with session id/i.test(error)
}

/**
 * The config directories a chat's record should now say the CLI has it in.
 *
 * Merged rather than written, because two writers keep this field — `markStarted`
 * and `append` — and either can be reading a listing the other has already
 * saved over. Undefined stays undefined until there is something to say, so a
 * chat nobody has spoken into is not given an empty array.
 */
function startedDirs(
  chat: WorktreeChat,
  dirs: Set<string> | undefined
): string[] | undefined {
  if (!dirs || dirs.size === 0) return chat.startedIn
  return [...new Set([...(chat.startedIn ?? []), ...dirs])]
}

/** A chat's name: the first thing asked, on one line and short enough for a tab
 * in a strip. */
function titleOf(text: string): string {
  const line = collapse(text)
  if (!line) return "Untitled"
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

/**
 * Where the CLI keeps one session's transcript under one config directory, or
 * null if that directory has no such session.
 *
 * **Found by looking rather than by computing where.** The transcript lives in a
 * folder named for the project — the path with every non-alphanumeric character
 * replaced by `-` — but applied to the path the CLI *resolved*, so a folder
 * reached through a symlink lands somewhere this app would have to guess at
 * (`/tmp` is filed under `-private-tmp` on macOS). A session id is a UUID, so
 * the file name alone identifies it and the folder does not have to be derived.
 *
 * `""` is the default directory, the way it is on `WorktreeChat.startedIn`.
 */
async function transcriptIn(
  configDir: string,
  sessionId: string
): Promise<string | null> {
  const projects = join(configDir || join(homedir(), ".claude"), "projects")

  let folders: string[]
  try {
    folders = await readdir(projects)
  } catch {
    // No transcripts at all — a first run, or a profile pointed somewhere the
    // CLI has not written yet.
    return null
  }

  for (const folder of folders) {
    const path = join(projects, folder, `${sessionId}.jsonl`)
    try {
      await stat(path)
      return path
    } catch {
      continue
    }
  }

  return null
}

/**
 * Copies a session's transcript into the config directory it is about to be
 * resumed under, so that switching profile keeps the conversation.
 *
 * A session is a file, and `--resume` is that file being read: the two accounts
 * share no state, so the *only* way the new one can continue a conversation the
 * old one had is to be given it. The folder is the source's own rather than one
 * derived from the cwd — the CLI names it after the path it resolved, which is
 * exactly the guess `transcriptIn` exists to avoid — and it is the same name
 * under either directory, because it is the same project.
 *
 * Two things follow from this that are worth saying out loud. The conversation
 * is **handed to the other account**: its messages are sent, billed and stored
 * under the profile the user has just switched to, which is what they asked for
 * by switching mid-chat. And the first turn after a switch re-reads the whole
 * context — the prompt cache belongs to the account too, so this is a copy, not
 * a move of something warm.
 *
 * **The newest copy wins, not the first one found and not the one already
 * here.** A chat that has been on two profiles has a transcript under each, and
 * every one but the last is a snapshot of the conversation as it stood when it
 * left that account. Taking either the head of the list or whatever is already
 * under `to` rewinds the chat to that snapshot: A → B → C read A's file and
 * answered as though B's turns had never happened, and A → B → A found A's own
 * stale copy and did the same. `mtime` is what tells them apart — a carried copy
 * is written at the moment of the carry and appended to by the CLI from then on,
 * so the directory the conversation actually continued in is the latest.
 */
async function carryTranscript(
  sessionId: string,
  from: string[],
  to: string
): Promise<boolean> {
  const copies: { dir: string; path: string; written: number }[] = []
  for (const dir of [to, ...from]) {
    const path = await transcriptIn(dir, sessionId)
    if (!path) continue
    try {
      copies.push({ dir, path, written: (await stat(path)).mtimeMs })
    } catch {
      // Gone between the look and the stat. Nothing to carry from here.
      continue
    }
  }

  const latest = copies.sort((a, b) => b.written - a.written)[0]
  if (!latest) return false
  if (latest.dir === to) return true

  // Over the copy already under `to` where there is one, rather than to a folder
  // derived from the source's name: the two agree for the same project, and
  // writing the derived one anyway would leave `transcriptIn` two files to pick
  // between by readdir order.
  const stale = copies.find((copy) => copy.dir === to)
  const destination =
    stale?.path ??
    join(
      to || join(homedir(), ".claude"),
      "projects",
      basename(dirname(latest.path)),
      `${sessionId}.jsonl`
    )

  try {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(latest.path, destination)
    return true
  } catch (error) {
    // Worth a line and not worth failing the message over: what it costs is
    // the conversation, and the turn still runs — as a new session, which is
    // what this app did before it could carry one at all.
    console.error("Could not carry the chat to the new profile", error)
    return false
  }
}

/**
 * The CLI's own name for a session, out of the transcript it keeps.
 *
 * The **last** entry wins: the CLI appends a fresh line rather than rewriting,
 * and a conversation that turned out to be about something else is retitled.
 *
 * The line-by-line test before parsing is not micro-optimisation — it is what
 * keeps this off `JSON.parse` for every message of the transcript, which is
 * where the whole cost of reading the file would otherwise be.
 */
async function aiTitleOf(
  configDir: string | null,
  sessionId: string
): Promise<string | null> {
  const path = await transcriptIn(configDir ?? "", sessionId)
  if (!path) return null

  let transcript: string
  try {
    transcript = await readFile(path, "utf8")
  } catch {
    return null
  }

  let title: string | null = null
  for (const line of transcript.split("\n")) {
    if (!line.includes('"ai-title"')) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (
        entry &&
        typeof entry === "object" &&
        "type" in entry &&
        entry.type === "ai-title" &&
        "aiTitle" in entry &&
        typeof entry.aiTitle === "string"
      ) {
        const named = collapse(entry.aiTitle)
        if (named) title = named
      }
    } catch {
      // A line the CLI was still writing when this read it. The turn after
      // this one looks again.
    }
  }
  return title
}

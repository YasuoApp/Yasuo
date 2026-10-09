# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This file is the **operating manual**: the commands, the contracts, and the
handful of constraints that cost a debugging session if you do not know them.
It is deliberately short, because every turn in this repository pays for it.

**`docs/design.md` is the design document** — what each panel does and why, how
the workspace's data lives on disk, every argument that was had and every
feature that was removed. Read the relevant section there before changing an
area's behaviour. When the two disagree, `design.md` is the fuller account.

## What this is

**Yasuo**: an Electron studio for running several `claude` conversations
against a project at once and reading what they did — its folders, its chats,
its diffs and the chats that made them, in one tab strip.

There is one **workspace**, holding any number of **folders** — directories
already on this machine, worked on where they are. It is deliberately not
switchable. What is per folder is what is genuinely per repository — a shell's
cwd, a branch name. Sign-in will bring a second workspace; until then
`DEFAULT_WORKSPACE_ID` is a constant.

One package, no monorepo workspaces. `src/main/` is the Electron main process,
`src/preload/` the one bridge script, `src/renderer/` the React app, and
`src/shared/` the contract between the two. `src/server/` is the **browser
build**: the same handlers over HTTP on `127.0.0.1`, for the same renderer in a
tab — `docs/design.md` § The browser build.

## Commands

```bash
bun install
bun run dev      # scripts/dev.mjs: esbuild main, start Vite, launch Electron at it
bun run test     # `bun test` is Bun's own runner and would find nothing
bun run lint
bun run typecheck
bun run build    # bundle main/preload/daemon + vite build the renderer
bun run format   # prettier over the whole repo; format:check is what CI runs
bun run dev:web  # the browser build: Vite + src/server on 127.0.0.1 (prints a URL with a token)
bun run build:web && bun run web   # the same, built, on one port
```

`typecheck` runs three TypeScript projects, because the three environments do
not share globals: `tsconfig.main.json` (Node), `tsconfig.renderer.json` (DOM),
and `tsconfig.test.json`, which is the one that sees both.

A `Makefile` wraps packaging — `make dmg` (this machine's arch), `make
dmg-arm64` / `dmg-x64` / `dmg-universal`, `make app` (unpacked `.app`, faster
for a smoke test), `make help` for the rest. Unsigned unless `SIGN=1`.

### Tests

Plain `bun` scripts under `test/`, no test framework — see `test/harness.ts` for
the reasoning. `bun run test` runs `scripts/test.mjs`, which discovers every
`.ts` in that directory (skipping `harness.ts` and `*.local.*`), so adding a
test is dropping a file in. Run one directly while working on it:

```bash
bun test/transcript.ts
```

The tests that touch the world do so for real rather than against a fixture:
`test/files.ts` creates, renames and indexes real files, and `test/git-changes.ts`
drives a real repository.

## The IPC contract — the one rule that matters

The main process (`src/main/`) and the renderer (`src/renderer/`) **never import
each other**. Everything crossing between them is:

1. a method on `DesktopApi` in `src/shared/api.ts` (types only, no runtime code),
2. a channel name in the `IPC` map at the bottom of that same file,
3. a thunk in `src/preload/index.ts`,
4. a handler in `src/main/ipc.ts`.

Adding or changing a call means touching all four. That is deliberate — the
alternative is two sides that disagree about what a call returns. The renderer
reaches the contract through the `@shared/*` alias; `@/*` is `src/renderer`.

The browser build reads the same four: `src/renderer/web/channels.ts` generates
its `window.desktop` from the `IPC` map by the preload's naming rule (a method
is its channel's key, a subscription is `on` + the key — keep to it),
`test/web-desktop.ts` checks it against the preload, and the handler is the same
entry in `createIpc`.

## Main process (`src/main/`)

`main.ts` creates the window and calls `registerIpc()` (`electron-ipc.ts`);
`ipc.ts` owns every handler and the long-lived managers (`Store`,
`TerminalManager`, `WorktreeChats`) as **`createIpc(host)`**, a table keyed by
channel that **does not import `electron`**. What Electron and the server
genuinely do differently — dialogs, windows, the tray, the trash,
notifications — is `main/host.ts`, implemented by `electron-ipc.ts` and
`server/web-host.ts`. A handler that needs one of those asks `host`; nothing
under `src/main/` that `ipc.ts` imports may reach `electron`, and
`scripts/build-web.mjs` leaves it unresolvable so a slip is a build error.

- **`store.ts`** — all state on disk under `~/.yasuo`: `manifest.json` for the
  workspace and its settings, `workspace/` for the panels' own files. A
  folder's own files are never under here — the manifest records an absolute
  path and they are read where they are. The manifest also carries a
  `databases?: unknown` nothing reads: it is the deleted Database panel's
  records, kept because a manifest is rewritten whole and dropping the key would
  delete somebody's saved connections. A **Claude profile's `CLAUDE_CONFIG_DIR`** is one of those workspace files —
  `workspace/claude-profiles/<slug>`, named by `claude-profiles.ts` because the
  renderer cannot see `YASUO_DATA_DIR`, created by the `claude auth login` that
  `IPC.claudeLogin` runs in a pty. Settings has no path field: a profile is a
  name, and `saveClaudeProfiles` answers with the directory it was given.
- **`daemon.ts` + `daemon-client.ts`** — ptys live in a detached, per-machine
  daemon over a Unix socket/named pipe with newline-delimited JSON.
  `TerminalManager.killAll()` is awaited on quit and nothing reattaches.
  `daemon.ts` gets its own esbuild entry point and is `asarUnpack`ed.
- **`notify.ts`** — which transitions in a chat's event stream are worth an OS
  notification: quiet (**not** `done` — a message sent mid-turn is queued behind
  it), a failure, a question. Free of `electron` so `test/notify.ts` can import
  it; `ipc.ts` rings the bell, only while the window is unfocused, and the click
  comes back as `IPC.revealWorktreeChat`. Its `pending()` is those same two sets
  read as a **standing count** rather than as edges.
- **`tray.ts`** — the menu bar's icon and that count beside it, drawn in the
  sidebar row's own words: `activityLabel` and friends live in
  `@shared/chat-activity`, re-exported by `lib/worktree-chat/running.ts`, so the
  count outside the window and the one inside it cannot disagree. A `Tray` built
  before `whenReady` throws, so it is created with the managers and shown from
  `startTray`; it is **held on the object**, since an unreferenced one is
  collected and the icon vanishes with nothing in any log. `CHAT_TRAY_KEY`
  switches it off, and `ipc.ts` acts on that key as the write lands.
- **`files.ts`** — every `files:*` call goes through `insideAny`, which is what
  keeps an absolute path from the renderer inside the roots the workspace was
  pointed at. Deleting is `shell.trashItem`, never `unlink`. `fileRoots` in
  `ipc.ts` is main's one list of roots, feeding the gate, the watchers, the
  palette's walk and the tsservers at once.
- **`git.ts`** — `workingTree` for the tree's colours, `changes()` for the
  Changes tab (`git status` with the ignored dropped, plus a `git diff
--numstat` per side of the index), `fileAtHead` for the diff's left side,
  `fileDiff` for the diff **itself** — `git diff HEAD --unified=0`, so the pane
  and the row's `+`/`-` counts are one algorithm rather than two that agree most
  of the time — and `stage` / `unstage` / `discard` for the list's menu. No git panel exists.
  **`commit` is the one write past that line**, and the reversal is recorded in
  `docs/design.md` § Committing: the sentence a commit needs can now be drafted
  off the staged diff by the read-only `claude` (`draftCommitMessage` in
  `one-turn-agent.ts`, fed by `stagedDiff` / `recentSubjects` here), so the gesture
  is ending a reading of the diff rather than writing a paragraph in a panel with
  no room for one. **`log` is the one read of history** — the checked-out
  branch's commits a page at a time (`--skip`) for the `Commits` view, nothing
  written (`docs/design.md` § Commits). **`blame` is the second**, one per file
  with the editor's buffer on stdin, for the current-line annotation
  (`lib/editor-git-blame.ts`, § Who last changed a line). Amend, branch and
  push stay out — that is
  the git client the dock's shell already is. `discard`
  answers with the paths it could not restore instead of deleting them: they go
  to the trash in `ipc.ts`, because this module stays free of `electron` so the
  tests can import it.
- **`updater.ts`** — whether GitHub has a newer release, and running
  `install.sh` (carried in the bundle as an `extraResources` entry) to install
  it. **Not `electron-updater`**: Squirrel.Mac will not replace an unsigned
  bundle and these builds are unsigned. The installer is spawned **detached**,
  because the script's own second act is quitting this app. Free of `electron` —
  the version and the script's path are arguments — so `test/updates.ts` can
  import `isNewer`. `docs/design.md` § Updating has the rest.
- **`tsserver.ts`** — one per Explorer root, using _that root's own_
  `typescript`, and nothing if it has none.
- **`mcp-servers.ts`** — which MCP servers the user's own `claude` has, asked of
  it over the SDK's control channel (`mcpServerStatus()`) in a project's own
  directory, for the composer's MCP menu (`worktree/chat-mcp.tsx` — there is
  no Settings › MCP any more), plus `removeMcpServer`, which
  runs the CLI's own `claude mcp remove`. **This app serves no MCP server of its
  own**: the three that served the Database, API and Notes panels are deleted —
  see `docs/design.md`. What it does still say about MCP is which _tools_ a chat
  may call — **per chat**, `WorktreeChatOptions.disabledTools`, handed over as
  `disallowedTools`.

- **`plan-usage.ts`** — how much of the claude.ai plan's five-hour and
  seven-day windows an account has used, for the composer's usage meter
  (`worktree/chat-plan-usage.tsx`). Asked the way the MCP listing is — a
  `claude` and no tokens, one control request — under the chat's profile's
  `CLAUDE_CONFIG_DIR`, held a minute per account. The request is the SDK's
  `usage_EXPERIMENTAL_…`, so `readPlanUsage` narrows everything
  (`test/plan-usage.ts`) and a missing method is an answer, not a throw.

- **`one-turn-agent.ts`** — the **second** `claude`, and the only one that is not
  a conversation: one read-only turn, opened for a question and closed on the
  answer, with no transcript, no resume and nothing to send a second message to.
  One of them — `draftCommitMessage`, which reads the staged diff and the last
  ten subjects and answers with a message for the box above the piles, never
  with a commit. It was `review-agent.ts` and had two more, `reviewReply` and
  `reviewChanges`: **the agent half of the review is deleted**, and so are the
  hand-written comments that outlived it — `docs/design.md` § Comments,
  removed. **`distillLearnings` is deleted too** — the chat row's `Distill
learnings…`, its dialog, `main/learnings.ts`, `shared/learnings.ts` and the
  two `agent:*` channels (§ Distilling learnings, removed). The rule below still
  holds — a feature calling the CLI as a helper is refused — and the draft is
  not one: it is asked for out loud by a button and answers as text in a box
  somebody still has to press Commit on. `docs/design.md` § Committing has the
  argument.

- **`content-search.ts`** — the left column's Search (`Find in files`): a query
  with `Aa` / `ab` / `.*` over every file under the workspace's folders and what
  was said in every chat (`WorktreeChats.search`), one channel
  (`search:workspace`) whose **generation** in `ipc.ts` stops an older search
  typed past. A walk and a read per search, nothing indexed; capped at 2,000
  matches. It **reverses** two deletions — `docs/design.md` § Searching inside
  the files and the chats has the argument. Free of `electron`
  (`test/content-search.ts`).

- **`chat-digest.ts`** — `spendRows`, the **cost dashboard's** fold: one row
  per usage line, with the chat's title and the line's `at`. Pure and free of
  `electron` (`test/chat-digest.ts`); `WorktreeChats.spend` holds the lines and
  the cache, and deliberately does **not** go through `read`, which would keep
  every transcript in the workspace resident. The per-chat `ChatDigest`, its
  `chatDigests` channel and the system bar's running total are **deleted**
  (`docs/design.md` § What the chats have cost, removed). Searching what a chat
  **said** is not here and is not main's: it is asked of the conversation on
  screen, whose lines the renderer already holds (`lib/worktree-chat/search.ts`).

- **Every chat line carries `at`** (ISO), stamped in `WorktreeChats.append`,
  the one writer; lines from before it have none and draw no time. There is
  **no per-chat budget** any more — the toolbar's `Budget`, `budgetUsd` and
  `checkBudget` are deleted (`docs/design.md` § A chat's budget, removed).

- **A chat can be popped out** into a window of its own: `openChatWindow` in
  `main.ts` loads this same renderer with `?chat=<id>`, which `App.tsx` reads
  and draws as `ChatWindow`. For that, `send` in `ipc.ts` **broadcasts every
  push event to every window**, and the notification check asks whether _any_
  window is focused. `setAlwaysOnTop` acts on the calling window.

- **There is no `Preview` tab** in the dock any more, and so no `webviewTag`
  (`docs/design.md` § Preview, removed). `saveTextFile` is the one write
  outside the roots — a save dialog names the destination — for a chat's
  export.

### `worktree-chat.ts` + `claude-agent.ts` — the `claude` a conversation runs on

`worktree-chat.ts` is the policy, `claude-agent.ts` the SDK runner under it. A
chat is `@anthropic-ai/claude-agent-sdk`, not a `spawn` of `claude -p`. Five
things are not visible from the option names:

1. `pathToClaudeCodeExecutable` is the **user's own** `claude` (their login,
   their `CLAUDE_BIN`), located through their login shell — a GUI app inherits
   almost none of their `PATH`.
2. No `--mcp-config` goes over at all, so a turn gets exactly the servers the
   CLI finds for itself in that directory. There used to be one, through
   `extraArgs` rather than the SDK's `mcpServers` option, which serialises a
   config onto a command line every process on the machine can read.
3. `appendSystemPrompt` is an `initialize` frame on stdin, not a flag.
4. The SDK throws only when the **process** ends, not on an error result — that
   is true of streaming input; with a string prompt it threw after delivering
   the result as a message too. The `finished` guard on `onExit` is what keeps
   one death being reported once.
5. `main.cjs` gets its own esbuild build — the package is ESM and its
   `import.meta.url` becomes `{}` under a CJS bundle, so a `define`/banner
   points it at a real file URL. That banner must not go near the sandboxed
   preload.
6. `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is what makes the CLI say whether it
   is busy at all. Without it there is no `session_state_changed` on the stream
   and busy falls back to the `result` line — which is wrong for exactly as long
   as a background subagent outlives the turn that started it. The subagent
   heartbeat (`task_*`) is read the same way, as the `agents` event.

**What the CLI is handed is identical on every turn of every mode**, and this is
load-bearing rather than tidiness. `allowedTools`, `disallowedTools` and a
per-mode `appendSystemPrompt` are all part of the request's **cached prefix** —
tool definitions sit ahead of the system prompt — so expressing a mode in them
meant changing mode mid-chat threw the prefix away. Measured here against a 43k
prompt: **42,345 tokens re-written and none read**, against 103 for a turn that
changed nothing. So no `allowedTools` at all, one `permissionMode` (`manual`),
one system prompt, and a `disallowedTools` that is **not** a mode's business —
the chat's switched-off MCP tools, identical on every turn until somebody
flips a switch in the composer's MCP menu; the mode is applied in-process by `permits`,
which `deciding` in `claude-agent.ts` consults, and the mode's own sentence goes
at the head of the **message**. A switch now costs 100–170 tokens.

Two traps behind that, worth knowing before adding a tool list back:

- A bare tool name on `allowedTools` **auto-approves before `canUseTool` is
  consulted** (the SDK warns on stderr), so a mode's own callback is never
  reached for anything that mode listed.
- `permissionMode: "bypassPermissions"` skips `canUseTool` entirely, which makes
  any refusal named beside it a request rather than a guarantee.

`PERMISSIONS` is the one table of the five modes — `Plan` / `Read only` / `Ask`
/ `Edits` / `Full access` — each holding what it permits, what the turn is told,
and whether it may stop to ask. Plan mode is a permit list, **not**
`--permission-mode plan`: that mode ends by asking, `ExitPlanMode` is a prompt,
and a turn started that way spends itself trying to leave.

`Ask` is **the plain CLI, exactly**: it permits nothing itself and asks about
every call `canUseTool` sees, ask rules included (`asksRules`) — the CLI's own
settings have already approved the rest. Its other half is `mergeShellEnv` in
`shell-env.ts`: a spawned `claude` gets the login shell's whole env, not only
PATH. `Ask` is the mode that stops: an unpermitted call comes back through
`canUseTool` as a card above the composer, and the promise `WorktreeChats.ask`
returns **is** the pause — nothing times it out. `Edits` stops too, for an MCP
tool alone (`asks` on `PERMISSIONS` is a predicate): refusing one there meant a
Figma frame the plain CLI fetches after one prompt. `endTurn` and `dispose` both
settle outstanding asks, or the CLI waits on a promise nobody will resolve.

**A chat is one CLI held open, not a process per message.** `query()` is given
an async iterable (`Inbox`), which is the SDK's streaming input mode, so a
message sent while a turn is running is pushed to the same process and the CLI
queues it — that is what makes the composer live mid-answer, and `Stop` an
`interrupt()` rather than a kill. Four consequences to know before touching it:

- `result` ends a **turn** (`onTurn`); the session ends when the stream does
  (`onExit`). They were one `onDone`.
- `modelUsage` and `total_cost_usd` are the **session's running total** on every
  result. `usageOf` subtracts the previous result, per model, and reads a
  backwards total as a reset rather than a refund.
- Whether a chat is busy is main's to say — the `busy` event, off the CLI's
  `session_state_changed` where there is one. A turn ending is not the chat
  going quiet: another message may already be queued.
- Model and effort move under a running session (`setModel`,
  `applyFlagSettings`), and the permission never went to the CLI at all. `cwd`,
  `CLAUDE_CONFIG_DIR` and the switched-off MCP tools **cannot** — a change to any
  of them closes the session and opens another (`signatureOf`).

A session with nothing to do for `IDLE_MS` is closed, silently: the alternative
is a `claude` per conversation resident all day, and reopening costs exactly
what every message used to.

A chat's id **is** the CLI's session id, so whether a session opens with
`sessionId` or `resume` is `started` on the record rather than a `Set` in the
process. A chat's lines are `workspace/worktree-chats/<id>.json`, listed in
`workspace/worktree-chats.json`. The cwd resolve is deliberately **not** a
fallback chain: a chat whose folder has left the workspace finishes with a line
saying so rather than running its next turn in whichever directory is readable.

That id is also how a chat gets its **name**. `append` calls it the first thing
asked in it; `retitle` then replaces that with the CLI's own `ai-title`, read out
of the session transcript — the app produces no summary of its own, because a
turn nobody asked for is what `CLAUDE.md` refuses. It is the one read of that
file (`worktree-chat.ts` says why), it never touches a chat the user has named,
and `done` waits on it so the listing's re-read cannot race the write.

**A chat is written down by its first message, not by the `+`.** The tab opens
at once — the renderer mints the id (which is the session id) and holds the chat
in `unsaved` — and `createWorktreeChat` is called from `send`, carrying a
`ChatSeed` of whatever the tab picked up meanwhile: its id, its name, its
toolbar. So a `+` nobody spoke into leaves no row and no file. `create` used to
take a `save` option for a caller that recorded the id elsewhere — the deleted
board's `startChat` — and no longer does.

No MCP config is passed, so whatever the user's own `claude` is configured with —
`~/.claude.json`, a repository's `.mcp.json`, enabled plugins, claude.ai
connectors — reaches a turn the way it would running plain `claude` in that
directory, minus whatever that chat's MCP menu has switched off. The cost is that
`Plan` and `Read only` cannot refuse a server _by name_, since this app
configures none and so has no name for one; an unlisted tool is still refused by
`deciding`.

A switched-off tool is a **wire** name (`mcp__claude_ai_ClickUp__clickup_search`),
not the name the listing shows: the CLI normalises a server's configured name
into it, so `wireServer` in `lib/worktree-chat/mcp-servers.ts` is what an entry
has to be built through or it matches nothing. Verified against the CLI's `init`
frame: two named tools disallowed are two tools **absent from the model's list**,
not refused on use.

## Renderer (`src/renderer/`)

React 19 + Vite + Tailwind v4. `components/studio/` is split by panel
(`worktree`, `api`, `db`, `note`, `files`), and each panel's logic and zustand
store live in the matching `lib/` directory, with `lib/store.ts` holding the
studio-wide state and `lib/workspace.ts` the thin repo over the workspace calls.
`components/ui/` is shadcn/ui — add to it with the CLI (`bunx shadcn@latest add
dialog`), not by hand. Vite's root is `src/renderer`, so `index.html` and
`public/` are there too.

The shape, in one pass: the **left column** (`workspace-sidebar.tsx`) shows
either its sections or **Search** (`SidebarView` in `lib/projects.ts`, switched
by the `NavRail`'s two buttons and `⇧⌘F`; `search-section.tsx`). Its sections are
`Projects` and nothing else — `SIDEBAR_SECTIONS` in `lib/projects.ts` is
the one line saying which sections are drawn, and the next to arrive is an id
added to it. It stacked three once: the **Database and API panels are deleted**,
and with them the panel windows they were the only users of, so there is one
window again (`docs/design.md` § Database and API, removed).
A project's rows say what is happening in them — a spinner, a shield for a chat
stopped on a question, and a count on the project's own row **while it is shut**
(`activityOf` in `lib/worktree-chat/running.ts`, tested; waiting wins over
working, since both are true while a card is up). Out of the window, that is a
notification — see `main/notify.ts`.
Those all say what is happening **now** and go dark together, so a chat that has
answered while somebody was reading another one is marked **unread** — a dot and
a heavier title on the row and on the tab, off `marksUnread` in
`lib/worktree-chat/unread.ts` (tested). Same rule as the notice, **quiet not
`done`**; read is selected-and-focused; nothing is written down, since unread is
this run's attention. Its count is kept out of `ChatActivity` deliberately —
that shape is the tray's too, and the tray counts what is happening.
A message sent into a chat that was **already working** is marked `Queued` on its
own line until the running turn ends (`queued` in the store, cleared on `done`) —
in memory like `unread`, and a mark rather than a cancel: holding it back in main
would take away the fold into the next turn that the queue is for.
`⌘F` opens a **find bar over the transcript** (`chat-find.tsx`, matching in
`lib/worktree-chat/search.ts`) — a bar and not a palette group, since the results
are the conversation behind it. The matched **text** is painted through the CSS
Custom Highlight API (`find-marks.ts`), which is the only way to mark a run of
characters inside rendered markdown without wrapping it in an element React owns;
a ring is left for folds alone, whose text may be collapsed out of the DOM. A
match is an **occurrence** and not a message — `n of m`, the arrows and the marks
are one unit, and the count is read off the message's own text so a match inside
a shut fold still counts. It is the one window shortcut claimed conditionally: the panes are
hidden rather than unmounted, so the pane checks it is the one showing before
taking a key that belongs to CodeMirror everywhere else.
The **right-hand panel** is Explorer, with `All files` and `Git` tabs, and it
is the whole height of its column. The window is a **canvas with cards**: a
full-width title bar (`WindowTitleBar` — crumb left, a centred `Run a command`
field for the palette), then the `NavRail` (projects toggle with the activity
dot, Search, Terminal, Settings), the projects column, the pane + dock and the
Explorer, each a card (`CARD`, an inward outline so collapsed sizes stay exact)
with the gaps as resize handles (`Gap`). **Explorer collapses to a 36px rail**
(`explorer-rail.tsx`, `RAIL_WIDTH`), the same bargain the dock's strip makes;
the **projects column collapses to nothing**, since the rail's first button is
its way back. A rail is **positioned, not laid out**: it takes none of its
column's width, and the one row it lands on leaves the room (`pr-11` on
Explorer's header). A shut column is hidden rather than squeezed and never
unmounted. The **dock** — a tab per shell, and a `+` — is under
the **pane**, spanning its width, collapsed rather than unmounted because a pty
taken out of the tree ends. It used to be the lower half of the Explorer column,
where a 520px cap left the shell ~60 columns wide; `docs/design.md` has the
argument. It collapses to its own tab row rather than to nothing — that row is
the way back, which is why no dock button is left in the title bar — so the row's
height and the panel's `collapsedSize` are one exported `DOCK_STRIP_HEIGHT`
rather than an `h-9` beside a `36`. `⌃\`` toggles the Terminal tab
(`isTerminalShortcut`), and it is the one shortcut deliberately _not_ refused
inside a pty. A project's rows are its **chats**.
The `Changes` list's **per-chat chips are deleted** (`docs/design.md` § Whose
work this is, removed), so its actions are about the whole checkout again.

The Explorer's tab row is **two**: `All files` and `Git`, and `Git` holds two
views in a row under it — `Changes` and `Commits` (`ExplorerTab` and `GitView`
in `lib/store.ts`; a strip saved on the old `changes`/`commits` tabs reads back
as `Git` at that view). `commits-list.tsx` is re-read off the same git status
signal the `Changes` list is, so a commit in the dock's shell lands without
Refresh. **There are no comments on a diff** — the `+` column, the
threads, the `Comments` tab and the badges are deleted (`docs/design.md`
§ Comments, removed); nothing reads `workspace/review.json` any more.
A project's chat list shows the newest **20** (`CHAT_LIMIT` in
`projects-section.tsx`) and a `View all` row; the selected chat stays listed
past the cut.

**There is no board** — the kanban a project used to have is deleted: its pane,
its cards and columns, the drawer behind a card, the chip on a chat naming its
card, the four `board:*` channels and the `board` pane itself. `docs/design.md`
§ Board, removed has the argument — a backlog is the one thing in this studio
nobody can read off the repository, so it was either a duplicate of the tracker
the team already keeps or the stale half of a pair. What stays on disk stays:
nothing reads `workspace/board.json` or `workspace/board-columns.json` any more,
and nothing deletes them either.

**There is no ClickUp watcher** — the button, the panel, the poll, the sealed
key and the agents a watched task could be assigned to are all deleted, along
with the `readOnlyTurn` they were the only caller of. `docs/design.md` § Watching
ClickUp tasks, removed has the argument. What stays on a user's disk stays:
nothing reads `workspace/clickup-watches.json` or the `clickup.token` key any
more, and nothing deletes them either.

A project's row also makes a **`git worktree`** — the button beside its `+`,
`main/worktrees.ts`, `test/worktrees.ts`. What it produces is an ordinary
**workspace folder** pointed at the checkout, under
`workspace/worktrees/<folderId>/<branch slug>`, so the worktree _layer_ that was
deleted stays deleted: no `worktreeId`, nothing nullable in `FileRoot`, and every
panel works on it as a project. Whether a folder **is** a checkout is asked of
git per folder (`worktreeRepo`, beside the branch in the studio store) rather
than written down, which is what makes `Remove worktree` correct for a checkout
somebody made in their own shell — and what makes the `realpath` on both sides of
that comparison load-bearing. `docs/design.md` § Worktrees, as projects has the
argument, and § Worktrees, removed is the one it is held against.
The **column** files a checkout one indent under the project it was cut from
(`projectTree` in `lib/project-tree.ts`, tested) — the only nesting there is, and
the column's alone: it pairs on that same `worktreeRepo` answer rather than on
anything written down, so nothing in the data model nests and a checkout whose
repository is not in the workspace keeps a top-level row. A shut project counts
its checkouts' chats too, since folding it now hides them.

**The branch field is optional**, and an empty one is the case to know: the
checkout goes on `yasuo/untitled-<hex>` and the first chat in it that receives a
title renames the branch _and_ the project (`nameWorktree` in `ipc.ts`, off the
same CLI `ai-title` a chat names itself with, so it costs no turn). That
`git branch -m` is the **one branch write in this app** — `git.ts` keeps branch,
amend, log and push out — and it is narrow by construction: only a branch this
app minted, only while `isUntitledBranch` still holds, never one the user named.

### Constraints that bite

- **One copy of `@codemirror/view`, enforced twice.** A CodeMirror extension is
  identified by the object it was built from, so two copies of that package are
  two `EditorView.theme` facets and an extension that is silently inert — no
  error, the theme simply does not apply. Milkdown depends on the same packages
  and this install resolves thirteen nested copies at the _same version_, so
  neither the package manager nor `tsc` sees a conflict. `package.json` pins the
  version exactly and `resolve.dedupe` in `vite.config.ts` pins the module.
  **Read the comments on both before touching either.**
- **Every editor is CodeMirror**, set up once in `lib/editor.ts` and always
  behind a `lazy`. A language is a _dynamic import_ rather than a bundled
  grammar (`lib/editor-languages.ts`, 143 of them), so an editor opens in plain
  text and colours a frame later. There are no workers. The one thing this costs
  is that **`.ts` files get no syntax squiggles** — Lezer parses and does not
  diagnose.
- **`lib/files/documents.ts` is a document registry that had to be written**,
  because Monaco owned its documents and CodeMirror deliberately does not. Two
  editors can hold one path's buffer (a file tab and the `Changes` diff of it);
  it counts holders, drops the buffer at zero, forwards edits between views on
  the same path, and hands an editable view's undo history and caret to the next
  one. Only one view of a path can ever be typed into — a diff is read-only on
  both sides.
- **The diff is the one editor unmounted rather than hidden.** The panes are
  stacked and hidden with `invisible` to keep editing state; a live diff painted
  its bands through whatever pane was showing.
- **`PANELS` in `lib/panels.ts` is where a tab's identity lives.** `rootOf` says
  which project a tab belongs to (it is in the strip only while that project is
  active); `groupOf` says what a folder means per panel when grouping is on. A
  panel that leaves `rootOf` off is one whose tabs belong to the _workspace_
  rather than to a project, and so never leave the strip.
  `reconcileScope` is called from an effect in `studio.tsx`, not from `setActive`
  — a store reaching into `lib/panels.ts` would be a cycle.
- **`lib/files/roots.ts` holds two lists and the difference matters**:
  `shownRootOf` is what the tree draws, `fileRootsOf` is every root there is —
  what may be read, which tabs survive, which project a path belongs to.
- **`lib/files/paths.ts` is the one place a file path is split.** It accepts both
  separators, unlike `lib/runtime/tree.ts`, which is for paths this app made up.
- **`@shared/tree`** holds `descendantFolderIds` and `isDescendant`. They are
  shared because main used to delete a request folder too (through the MCP server
  that is now gone); the renderer is the only reader left, through
  `lib/tree.ts`, which re-exports them.
- **Excalidraw fonts are served by this app**, not from a CDN — see the
  `excalidraw-fonts` plugin in `vite.config.ts`. A drawing's scene is its own
  `workspace/drawings/<id>.excalidraw` file and the document holds only the id,
  in a ```drawing fence (`adoptDrawingFences` in `lib/note/blocks.ts`).
- **A picture in a block document is a file of the workspace's own** under
  `workspace/note-files/`, addressed by a `note-file://` URL —
  `shared/note-files.ts` is the shape and `main/protocol.ts` serves it. Nothing
  deletes one: the walks that did were the Notes panel's.
- **The Database and API panels are gone** (`docs/design.md` § Database and API,
  removed) — `main/database.ts`, `main/docker.ts`, `main/http.ts`,
  `main/encryption.ts`, `shared/http-request.ts`, `lib/db/`, `lib/http/`, both
  component directories, nineteen channels, `pg` / `mysql2` / `@codemirror/lang-sql`.
  The **panel windows** went with them (`openPanelWindow`, `?view=`,
  `panel-window.tsx`): they existed for these two and nothing else.
  `RenameDialog` is the one thing rescued, now `components/studio/rename-dialog.tsx`.
- **The Notes panel is gone** (`docs/design.md` § Notes, removed) — the store,
  the list, the pane, the preview server, the `notes:*` channels and the note
  types with it. What stayed is the **block editor**, because the Explorer's
  `.note` and `.md` tabs are that editor over a file: `components/studio/note/`
  and `lib/note/` are named for where they came from and are the editor's now.
- **Animation is CSS**, in `styles/motion.css`, and an animation added anywhere
  else should go there too.

### Pure halves, where the tests are

Logic worth testing is split out from the drawing: `lib/worktree-chat/activity.ts`
(`test/chat-activity.ts`), `lib/worktree-chat/usage.ts` (`test/chat-usage.ts`),
`lib/tab-groups.ts`
(`test/tab-groups.ts`), `lib/files/roots.ts` (`test/file-roots.ts`),
`lib/worktree-chat/running.ts` (`test/chat-running.ts`) with `main/notify.ts`'s
own `ChatNotices` (`test/notify.ts`),
`lib/worktree-chat/unread.ts` (`test/chat-unread.ts`),
`main/chat-digest.ts`'s `spendRows` (`test/chat-digest.ts`),
`lib/worktree-chat/search.ts` (`test/chat-search.ts`),
`lib/worktree-chat/outline.ts` — the chat's table of contents, one entry per
user message (`test/chat-outline.ts`),
`lib/worktree-chat/images.ts`'s `attachedIn` — a picture dropped or pasted into
the composer is read as base64 at once and written as `[Image #n]`, because a
macOS screenshot's temporary file is gone by the time a path to it is read; at
send each is also kept as a note file and the user line names it, so the
composer and the transcript both draw thumbnails (`chat-images.tsx`,
`docs/design.md` § Pictures in a message) (`test/chat-images.ts`),
`lib/files/change-tree.ts` (`test/change-tree.ts`),
`lib/files/conflicts.ts` — merge-conflict blocks and what Accept writes, drawn
by `lib/editor-conflicts.ts` in the file editor (`test/conflicts.ts`),
`lib/project-tree.ts` (`test/project-tree.ts`),
`lib/files/git-diff.ts` with `main/git.ts`'s own `fileDiff` (`test/git-diff.ts`),
`lib/files/diff-copy.ts` (`test/diff-copy.ts`),
`lib/files/block-doc.ts`, `lib/worktree-chat/mention-text.ts`
(`test/chat-mentions.ts`), `lib/worktree-chat/mcp-servers.ts` with
`main/mcp-servers.ts`'s own `readServer` (`test/mcp-servers.ts`),
`lib/worktree-chat/claude-profiles.ts`'s `accountLabel` / `accountCaption` with
`main/claude-auth.ts`'s own `readAuthStatus` and `main/claude-profiles.ts`'s
naming of a profile's directory (`test/claude-account.ts`),
`lib/worktree-chat/plan-usage.ts` — the usage meter's words, with
`main/plan-usage.ts`'s own `readPlanUsage` (`test/plan-usage.ts`),
`lib/worktree-chat/spend.ts` — the cost dashboard's grouping by day, project,
model and chat (`test/chat-spend.ts`), `lib/worktree-chat/export.ts` — a chat as
Markdown (`test/chat-export.ts`; `export-html.ts` is the DOM half),
`lib/appearance.ts` — palettes, fonts, font size and density as root attributes
and CSS vars (`test/appearance.ts`). Put new logic on that side of the line.

A terminal selection is put into the chat's composer from outside the pane
through `lib/worktree-chat/composer-bus.ts`:
a delivery addressed to a chat, which the pane drawing that chat types in.
Code blocks in a reply are coloured by `lib/markdown/highlight.ts`, the editor's
grammar walked once into `.tok-*` spans rather than a CodeMirror per fence.
`⌘⇧[` / `⌘⇧]` and `⌘1`–`⌘9` walk the strip (`tabStepOf`, `tabNumberOf` in
`lib/shortcuts.ts`). The first launch shows `onboarding-tour.tsx` once
(`onboarded` in settings); Settings › Appearance replays it.

## Conventions

- Prettier: no semicolons, double quotes, 80 columns, es5 trailing commas.
- Comments explain **why**, not what — which failure a constant was written
  against, why an approach was rejected. A comment restating the line below it is
  noise. Match the density and tone of the surrounding code.
- `*.local.*` is gitignored scratch. Use that suffix for repros and one-off
  experiments instead of leaving files untracked or committing them.
- Changes under `src/main/`, `src/preload/` or `src/shared/` need `bun dev`
  restarted; only the renderer hot-reloads.
- Removing a feature means **deleting** it — its store, its channels, its tests,
  its types — rather than hiding it, and recording the argument in
  `docs/design.md`. What is already on a user's disk is left alone: nothing
  reads `workspace/mail.json` or `workspace/tasks.json` any more, and nothing
  deletes them either. A **setting key** already written is the same bargain,
  which is why `reviewModel` / `reviewEffort` / `reviewProfileId` still carry
  the deleted agent review's name.

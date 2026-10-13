# Visual Studio Claude — design

An Electron studio for running several `claude` conversations against a project
at once and reading what they did. A workspace points at real directories on
disk, and every tool over them — the chats, their diffs, the files, a terminal —
is a tab in one window.

This document says what each part does and **why**, briefly. The commands and
the contracts are in `CLAUDE.md`; the long history of each decision is in git.

## Layout

| Path            | What it is                                                    |
| --------------- | ------------------------------------------------------------- |
| `src/main/`     | Main process: storage, chats, git, terminals, IPC.            |
| `src/preload/`  | The one bridge script, sandboxed.                             |
| `src/shared/`   | The typed IPC contract, imported by both sides (`@shared/*`). |
| `src/renderer/` | Renderer: the Vite + React studio.                            |
| `test/`         | Plain `bun` scripts, no test framework.                       |

## The workspace

There is exactly one workspace, holding any number of **folders** — directories
already on this machine, worked on where they are. Nothing is copied in and
nothing is written into them that you did not ask for; the manifest records an
absolute path.

```
~/.vsclaude/
  manifest.json              the workspace, its folders, settings
  workspace/
    worktree-chats.json      the chats, listed
    worktree-chats/<id>.json one chat's lines
    worktrees/<folderId>/    `git worktree` checkouts cut from a project
    claude-profiles/<slug>/  one Claude profile's `CLAUDE_CONFIG_DIR`
    note-files/              pictures dropped into a document or a chat
    drawings/                one `<id>.excalidraw` per drawing
```

**There is no switching.** Somebody working on a frontend and the API behind it
has two folders open, not two applications to alternate between. What is per
folder is what is genuinely per repository — a shell's cwd, a branch name.
Sign-in will bring a second workspace; until then its id is a constant.

**What a removed feature left on disk is left alone.** Nothing reads
`mail.json`, `tasks.json`, `board.json`, `review.json`, `notes.json`,
`clickup-watches.json` and the rest any more, and nothing deletes them either.
The manifest keeps an opaque `databases?: unknown` because it is rewritten
whole, and dropping the key would delete somebody's saved connections.

## The window

A canvas with cards: a full-width title bar (a centred `Run a command` field
that opens the palette, no crumb), then a 48px **`NavRail`**, the projects
column, the pane with the dock under it, and the Explorer. The gaps between
cards are the resize handles; a card's edge is an inward outline (`CARD`) so
collapsed sizes stay exact.

- **The left column** shows either its sections or **Search** (`SidebarView`,
  `⇧⌘F`). `SIDEBAR_SECTIONS` draws `Projects` and nothing else.
- **The right column is the Explorer**, its whole height. `⌘B` closes it to a
  36px rail; the projects column closes to nothing, since the rail's first
  button is its way back.
- **The dock** is under the pane, spanning its width — not under the Explorer,
  where a 520px cap left a shell ~60 columns wide.
- The current **branch** is at the head of the status bar along the bottom.

A shut column is hidden rather than squeezed, and never unmounted: the tree
watches the checkout, and a pty taken out of the React tree ends.

## Projects and chats

A project's rows are its **chats**; clicking one opens it and points the
Explorer and the dock's shell at that project too. The `+` on a project row
starts a chat; the button beside it makes a worktree. The list shows the newest
20 and a `View all` row. Each row carries its age (`since`, coarse: `9h`, `now`).

### Saying which chats are working, and calling you back

Three distances:

- **The chat's row**: a spinner while working, a shield while it waits on a
  question. Waiting wins over working.
- **A shut project's row**: a count (`2`, `1!`, `2 · 1!`) — drawn only while
  shut, since open, the rows say it. `activityOf` in
  `lib/worktree-chat/running.ts`, tested.
- **The rail**: a dot, counting every chat.

A chat that answered while you read another is **unread**: a dot and a heavier
title, on the row and the tab (`marksUnread`, tested). It is marked on
**quiet**, not on `done` — a message queued behind a turn starts the next one.
"Read" is selected in a focused window, and none of it is written down: unread
is this run's attention. It is kept out of `ChatActivity`, which the tray
shares and which counts what is happening.

A message sent into a chat that is **already working** is marked `Queued` until
the turn ends. It is a mark, not a cancel: the CLI folds queued messages into
the next turn, and holding them back would take that away.

### The notification

A chat that goes **quiet**, **fails** or **stops to ask** rings an OS
notification while the window is unfocused; clicking it opens the chat
(`IPC.revealWorktreeChat`). `ChatNotices` in `main/notify.ts` turns the event
stream into edges and is free of `electron` so `test/notify.ts` can hold it to
them — the failures are ringing twice and swallowing a quiet. The title is read
when the notice is due, since `retitle` renames a chat mid-turn. On by default
(`CHAT_NOTIFICATIONS_KEY`).

### The menu bar

A tray icon with **the same count** beside it, drawn by `activityLabel` from
`@shared/chat-activity` so the two can never disagree; empty when nothing runs.
Its menu names the chats, waiting first. `ChatNotices.pending()` feeds it — no
second watcher. The `Tray` is **held on the object** (an unreferenced one is
collected and vanishes silently), created with the managers but shown from
`whenReady`, and redrawn in sequence. Switchable off (`CHAT_TRAY_KEY`), which
destroys it at once. The icon is a template image from `scripts/tray-icon.mjs`.

### The chat's loading indicator

While a turn runs the pane draws three `primary` dots hopping in turn, then
`Working…` with a light passing over it, then a running clock — all CSS in
`styles/motion.css`, so it follows the theme and `prefers-reduced-motion` (the
dots fall back to breathing, the shimmer stops). It was a hand-drawn SVG, then a
spritesheet, then a GIF swordsman beside `Hasaging…`, removed at the user's
request: `prefers-reduced-motion` could not reach it, it did not follow the
theme, and it was fan art of somebody else's character.

### Worktrees, as projects

The button beside `+` makes a `git worktree` (`main/worktrees.ts`) and adds it
as an **ordinary workspace folder** under
`workspace/worktrees/<folderId>/<branch slug>`. There is no worktree layer:
nothing nullable in `FileRoot`, no `worktreeId` in `ChatPlace`, and every panel
works on the checkout as a project. Creating one also opens a chat in it.

- **The branch field is optional.** Empty mints `vsclaude/untitled-<hex>`, and
  the first chat there to receive a title renames the branch and the project
  (`nameWorktree`, off the CLI's own `ai-title`, so it costs no turn). That
  `git branch -m` is the one branch write in the app, refused unless
  `isUntitledBranch` still holds.
- **An existing branch is checked out** rather than refused.
- **Removing one deletes the directory** (forced), and says so; the branch and
  its commits stay. `git worktree remove` runs before the folder is dropped.
- **Whether a folder is a checkout is asked of git** (`worktreeRepo`, with
  `realpath` on both sides), never written down — so one made in your own shell
  behaves the same.
- The column files a checkout **one indent under its project**
  (`projectTree`, tested), the only nesting there is. A shut project counts its
  checkouts' chats too.

### Editing a message

A user bubble's **Edit** re-sends the message in its place and drops everything
after it. The cut is made **in the CLI's session too**: `WorktreeChats.edit`
closes the session and resumes it at the entry before the message
(`resumeSessionAt`), found in the CLI transcript by `main/chat-fork.ts`
(tested). Messages are matched from the end by text — a mid-turn message is a
`queued_command` attachment, Stop and slash commands write `user` entries
nobody typed. Editing the first message renames the transcript aside and starts
over under the same id.

Not done: putting **files** back (the edit box names the files the dropped
turns wrote), keeping the old branch on screen, editing while working, and
editing pictures.

## The chat is hosted, not tailed

A chat is driven through `@anthropic-ai/claude-agent-sdk`
(`main/claude-agent.ts`, the SDK runner; `main/worktree-chat.ts`, the policy).
The user's own `claude` is what runs — their install, their login, their MCP
servers — located through their login shell.

### A chat is a place

A chat's cwd is its project's own working tree (`folderId` on `ChatPlace`). The
system prompt tells the turn it is in the user's real checkout, and the empty
state says the same. A chat whose folder left the workspace finishes with a
line saying so rather than running somewhere else.

### A chat holds its CLI open

`query()` takes an async iterable (`Inbox`), so one CLI lives for the chat and
the composer is live mid-answer; the CLI queues what is sent. `Stop` is an
`interrupt()`, not a kill. Consequences:

- `result` ends a **turn** (`onTurn`); the stream ending ends the session
  (`onExit`).
- `modelUsage` is the session's **running total**; `usageOf` subtracts the
  previous result per model and reads a backwards total as a reset.
- **Busy is main's to say**, from `session_state_changed` — which only arrives
  with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` set. Without it a turn that
  starts background subagents looks idle while they work. Subagents' heartbeat
  (`task_*`) is kept as a set and drawn as `Working · 3 agents…`. The tool is
  both `Task` and `Agent` depending on the CLI (`AGENT_TOOLS`).
- Model and effort move under a running session; cwd, profile and switched-off
  MCP tools cannot, so a change closes the session (`signatureOf`).
- A session idle for `IDLE_MS` is closed quietly; the next message resumes it.

A chat's id **is** the CLI's session id; `started` on the record decides
`sessionId` vs `resume`, and a turn refused as "already in use" is retried once
as a resume. A chat is **written down by its first message**: the renderer mints
the id and holds the tab in `unsaved`, and `createWorktreeChat` takes a
`ChatSeed`. It is **named** first by its opening sentence, then by the CLI's own
`ai-title` read out of the session transcript (`retitle`) — the app runs no
summarising turn of its own. `done` waits on that write.

### What a turn looks like

A turn's **working is folded and its answer is not**: one line (`7 tool calls,
13 messages, 1 subagent`, with a mark per kind of tool) over the calls, the
thinking and the narration. Errors, refusals and the cost line are never
folded. The slot under the fold holds the latest thing said; later calls join
the fold above it. `lib/worktree-chat/activity.ts` is pure and tested.

A tool row is **verb · object · outcome** for every tool (`rowOf` in
`lib/worktree-chat/tool-row.ts`, tested), with the model's description on the
hover line. Consecutive calls of one verb merge into one row of chips; failures,
commands, agents and MCP calls never merge. Everything that opens uses the same
chevron and the same rule. An edit's row shows `+3 −1` read off the call's
input, and its lines in a popover on click; a `TodoWrite` row shows `1/3` and
the current item, and the closed fold carries the last list. A result is filled
into its row when it arrives (`recordResult`, synchronous on purpose). The
spinner shows elapsed time (`elapsed`), kept on the store so it survives
switching chats.

### What a turn cost

Every turn ends with an unfolded line:

```
Opus 5 · 39.1k prompt, 96% cached · 1.9k out · 1m5s · 41.3k context · $0.31
```

The cached share is the number that matters — a cache miss costs an order of
magnitude more. Figures come from `modelUsage` (subagents included); the time is
measured in main around the turn; the **context** is a level, not a sum, taken
from the last main-loop assistant message and sent live as its own event. The
lines are `role: "usage"` lines of the conversation, and the chat's total under
the composer is summed from them (`lib/worktree-chat/usage.ts`, tested).

### The composer's toolbar

Per chat (`WorktreeChatOptions`): model, effort, permission, profile, MCP.

- **Models are asked of the user's CLI** (`supportedModels()` over the control
  channel — a process, no tokens; `main/agent-models.ts`). A new chat opens on
  the CLI's `default`; `Inherit` (`null`) defers to the user's settings.
- **Effort is per model**: a model that takes none hides the picker. There is no
  `Default` row — `DEFAULT_CHAT_EFFORT` is `medium`, named out loud.
- **Permission is one picker**: `Plan` / `Read only` / `Ask` / `Edits` /
  `Full access`, one entry each in `PERMISSIONS`.

**What the CLI is handed is identical on every turn of every mode.**
`allowedTools`, `disallowedTools` and the system prompt sit in the cached
prefix, so expressing a mode there cost ~42k tokens per switch. Now: no
`allowedTools`, one `permissionMode` (`manual`), one system prompt; the mode is
applied in-process by `permits` (consulted by `deciding`), and its sentence goes
at the head of the message. A switch costs 100–170 tokens. Two traps: a bare
name on `allowedTools` auto-approves before `canUseTool`, and
`bypassPermissions` skips `canUseTool` entirely.

- **Plan** and **Read only** permit `READ_TOOLS` only (no `Bash`); they differ in
  what the turn is told. Plan is not `--permission-mode plan`, which ends by
  asking.
- **Ask** is **the plain CLI, exactly**: it permits nothing itself and puts
  every call `canUseTool` sees on screen. Parity also needs the login shell's
  whole env (`mergeShellEnv`).
- **Edits** pre-approves edits and `Bash`, and asks about MCP tools.
- **Full access** permits everything.

### Asking

An unpermitted call comes back through `canUseTool` as a card above the
composer, and the promise `WorktreeChats.ask` returns **is** the pause — nothing
times it out; `finish` and `dispose` settle what is outstanding. Answering
writes a `role: "ask"` line composed by main. `Always allow` echoes the SDK's
own `suggestions`. **`AskUserQuestion`** reaches the user in every mode and is
answered by allowing the call with the picks merged in. An account's
`matchedAskRule` is honoured first, in every mode. `titleFor` writes the card's
sentence (`test/chat-ask.ts`).

### `@` in a chat's composer

`@` offers the checkout's **files and folders** and inserts a path relative to
the project, keeping the `@` so the mention can be tinted. Nothing is pasted in:
the turn can `Read` the path itself. Each row shows its estimated token cost
(size ÷ 4). The list is the Explorer's index (shared with `⌘P`) minus what git
ignores. The tint is drawn by a mirror behind a plain textarea, matched word by
word (`markMentions`). **Attach file** (⌘U) writes the same kind of path.

### Pictures in a message

A pasted or dropped picture is read as bytes at once and written as
`[Image #n]` — a macOS screenshot's temp file is gone before a path is read. At
send each is stored as a note file and the line records the names, so both the
composer and the transcript draw thumbnails (`note-file://`). A tool's image
results are kept the same way and drawn under the row, outside the fold.

### A chat's shared media

Telegram's "shared media", beside the transcript: a column with `Media` (every
picture, both sides', as a grid that opens a viewer with `←`/`→`), `Files`
(what the chat wrote, once each, by its last write) and `Links` (web links said
by either side, not tool output). Newest first, read off the lines on screen
(`lib/worktree-chat/media.ts`) with nothing stored. Every item lands on the
line it came from; a subagent's lands on its `Agent` row. It takes the same
slot as the table of contents and the two are exclusive — two columns leave a
narrow pane no transcript. That slot (`SideColumn`) is dragged wider by its
left edge, 200–560px and never past half the pane, one width for both columns
and every chat, this run only; a double-click puts it back to 240.

### `/` in a chat's composer

At the head of a message only, `/` lists the slash commands the user's CLI would
run in this project (`supportedCommands()`, asked on the first `/` and held per
project). Everything goes to the CLI verbatim except two that are this app's:
**`/clear`** empties the lines **and** closes the session (same id, tab and
title), and **`/rename`**. A short `HIDDEN` list drops terminal-only commands and
ones the toolbar already covers.

### The context window, and compaction

The toolbar meter shows **room left before auto-compaction**, draining, read
against the auto-compact threshold rather than the window
(`getContextUsage()`, once a turn). Compaction itself has no progress events,
so it stays a spinner; its boundary is a rule across the transcript, never
folded. Every failure to refresh the meter is swallowed — it keeps the last
number.

### The plan's own limits

Beside it, how much of the claude.ai plan's five-hour window the chat's account
has used, with every window in a popover (`main/plan-usage.ts`, asked of the
CLI with the profile's `CLAUDE_CONFIG_DIR`, held a minute per account). The
request is experimental in the SDK, so the answer is narrowed field by field and
a missing method is not an error. Nothing is drawn for API-key accounts.

### Finding a line in the chat on screen

`⌘F` is a find bar over the transcript (`chat-find.tsx`,
`lib/worktree-chat/search.ts`): the query as typed, case ignored. Matches are
painted with the **CSS Custom Highlight API** (`find-marks.ts`) — no DOM touched
inside rendered markdown. `n of m` counts **occurrences**, read off message
text so a match inside a shut fold still counts; the fold gets a ring. Only the
two voices are searched. The key is claimed only while the chat pane is showing,
since elsewhere it is CodeMirror's.

### Replying to a part of what was said

Selecting a run of the transcript shows `Reply`, which types it into the
composer as a `>` quote, unsent (`quoteOf`, tested).

## The dock

A tab per shell and a `+`, under the pane. **Collapsed, not unmounted** — a pty
taken out of the tree ends — and it collapses to its own tab row
(`DOCK_STRIP_HEIGHT`), which is the way back. Dragging it shut is the same as the
chevron. `⌃\`` toggles it, even from inside a pty.

### Terminal

Any number of shells per project, a tab each, named for the directory the shell
is in now (asked of the kernel off the pty's pid, once output goes quiet after
Enter). Clicking a project row points the dock at that project; the pty starts
only when the tab is shown. Shells are not restored across a launch. ptys live
in a detached per-machine daemon (`main/daemon.ts`).

## The tab strip

One strip for the whole workbench; `lib/panels.ts` holds each panel's tab rules
(`PANELS`), and `tabOrder` the order across panels. Closing a panel's last tab
hands over to the neighbour, whichever panel it belongs to (`neighbour`). The
strip is restored on reload, each record reconciled against what exists. Panels
and tabs switched away from are **hidden, not unmounted**, so scroll, undo and
carets survive — except the diff (see below).

### One project's tabs, or every project's

A file, a chat and a `Changes` tab belong to a project (`rootOf`), and by
default the strip holds only the active project's; the rest stay open and come
back with their project. Settings › Tabs & editor › **Show tabs from every
project** (`allProjectTabs`) lifts that in `inScope`, so the strip, the pane,
`⌘W`, a drag and Close All all see every project's tabs; picking one moves the
active project to it. A `Changes` tab adds its project's name in that mode.
Turning it off closes nothing — `reconcileScope` moves the pane back into the
active project.

### The preview tab

A single click in the tree opens an italic **preview** tab that the next single
click replaces; a double click or a keystroke keeps it. Only the tree previews.

## Search

**`⌘P`** opens everything this window can open — files and chats. It only
opens things; there is no commands half. Files come from an index walked the
first time the palette opens (skipping `IGNORED_DIRECTORIES`, capped at 20,000),
re-walked by Refresh or when a folder is added or removed, and cut to a
shortlist by a subsequence pass before cmdk ranks them.

### Searching inside the files and the chats

The left column's **Search** (`⇧⌘F`): one query with `Aa` / `ab` / `.*` over
every file in the workspace and everything said in every chat
(`main/content-search.ts`, tested). It reverses two earlier deletions on
purpose, paying their costs deliberately: one channel with a **generation** so
an older search stops, a list (git's own `ls-files` in a repository) and a read
per search with nothing indexed, binary and >1 MB files skipped, a 2,000-match
cap, and transcripts not made resident. A chat hit opens that chat with its
`⌘F` bar on the occurrence.

## The window shortcuts

`⌘P`, `⇧⌘F`, `⌘F`, `⌘W`, `⌘S`, `⌘B` and `⌃\`` are `keydown` listeners in the
renderer (`lib/shortcuts.ts`), not menu accelerators, because each needs
something only the renderer knows. The menu lists them with
`registerAccelerator: false`. Closing the window is `⇧⌘W`. Off macOS the
dock's shell keeps `Ctrl+P`/`Ctrl+W`(readline's).`⌘B`is refused inside`contenteditable`, where it means bold. `⌘⇧[`/`⌘⇧]`and`⌘1`–`⌘9` walk the
strip.

## Settings

A dialog (⌘,), applied as picked — no Save. Sections: **Appearance**, **Tabs &
editor**, **Chats**, **Claude**, **Updates**.

**Claude** holds named profiles, each a `CLAUDE_CONFIG_DIR`. Adding one is a
name, a click and a login: the app names the directory
(`workspace/claude-profiles/<slug>`, in main, because the renderer cannot see
`VSCLAUDE_DATA_DIR`) and runs `claude auth login` in a pty with that directory
set — on the command line too, since a `.zshrc` export would otherwise win.
Every row says whether it is signed in and as whom, **asked of the CLI**
(`claude auth status --json`); a missing directory is never spawned into, since
the CLI would create it. The composer's account menu shows each profile's email.

## MCP: what the user's own `claude` has

**This app serves no MCP server and passes no MCP config.** A turn gets exactly
the servers the CLI finds in that directory — `~/.claude.json`, `.mcp.json`,
plugins, claude.ai connectors. The cost: `Plan` and `Read only` cannot refuse a
server by name; an unlisted tool is still refused by `deciding`.

### Per chat, in the composer

The composer's MCP menu (`worktree/chat-mcp.tsx`) lists the servers, asked of
the CLI in the project's directory (`mcpServerStatus()`, not cached, re-asked
for up to 8 s while servers are pending — claude.ai connectors take ~4 s).
Trouble sorts first; headers are never drawn.

- **Switches** are this app's refusal, per chat (`disabledTools`), sent as
  `disallowedTools` so the tools are **absent** from the prompt, not refused on
  use. They change rarely, so they live in the cached prefix and in
  `signatureOf`. Entries are **wire** names (`wireServer`, tested).
- **Remove** runs `claude mcp remove`, only where a scope allows it.
- A **`needs-auth`** claude.ai connector links to its settings page; any other
  points at `/mcp` in a terminal.

## Explorer

The files of **the project being worked in**, one tree with no root row
(`shownRootOf`). `fileRootsOf` is every root — what may be read, which tabs
survive — and keeping the two apart is what stops switching project from
closing the other project's tabs. Its header is two tabs, `All files` and
`Git`; `Git` holds `Changes` and `Commits`.

- **Only expanded folders are watched**, one non-recursive `fs.watch` each; each
  root's `.git` is watched for status. Refresh re-reads everything for
  filesystems `fs.watch` misses.
- **Rows are coloured and lettered by git** (`M`, `U`, `A`, `D`, `C`), ignored
  ones greyed, in the editors' own colours. A deleted file keeps its tab, marked
  `deleted` — from git, or from the listing only where git has nothing to say.
- **A path is the identity**: `file:` + absolute path. `lib/files/paths.ts`
  accepts both separators.
- **Every `files:*` call goes through `insideAny`**; deleting is
  `shell.trashItem`. Adding, renaming and removing workspace folders is here;
  removing one never touches the directory. Rows are renamed in place.
- **Viewers** (`lib/files/viewers.ts`): text, image (on a checkerboard),
  markdown preview, HTML preview (a sandboxed `srcdoc` frame without
  `allow-same-origin`), the block editor for `.note` and optionally `.md`, and
  diff. Binary files and anything over 2 MB are reported, not opened.

### Closing it leaves the rail

The column collapses to a 36px rail (`RAIL_WIDTH`) that is always on screen and
**positioned, not laid out**, so the tree keeps its width. Contents are hidden
with `opacity-0`, not `invisible`: `visibility` transitions with `Button`'s
`transition-all` and held the rows on screen for 150ms.

### Changes

The list is a **folder tree** (`lib/files/change-tree.ts`, tested), with
single-child chains folded into one row, in two piles — `Staged` and `Changes` —
so one path can be two rows with each side's own counts. Counts are
`git diff --numstat`; untracked files are read under a cap. A row opens the
project's **one diff tab**; a new directory opens in `All files` instead.

### Staging, discarding, and where this stops

Stage, unstage and discard are on the row, on a pile's heading and on the
right-click menu. **Discard means back to `HEAD`**; a file `HEAD` lacks goes to
the **trash**, never `unlink`, and a rename is restored whole. Every write is
gated twice (`ipc.ts` and `main/git.ts`) and ends by re-reading git.

### Commits

The checked-out branch's commits, twenty at a time with `Show 20 more`
(`log`, one extra row asked to know whether more exist). Read-only and flat — no
graph, no other branches, no commit diff. Re-read off the same git signal as
`Changes`, so a commit in the dock's shell lands without Refresh.

### Who last changed a line

The caret line's blame is drawn faintly after it, with a card on hover:
author, date, summary, hash and forge links (`lib/editor-git-blame.ts`,
`main/git.ts`'s `blame`). One `git blame --porcelain` per file with the buffer
on stdin, laid over the line rather than in it. No avatars, no forge API, no
diff. `Ask in chat` types the commit into the composer, unsent.

### Committing

A message box above the piles while something is staged; `⌘⏎` commits with
`git commit -m` (an argument, hooks left to run). **`Draft`** asks the
read-only one-turn `claude` (`draftCommitMessage`) for a message off the staged
diff and the last ten subjects — a button pressed, its output text in a box
somebody still has to commit, which is why it passes the rule against helper
turns. A failed commit **rejects** and keeps the message. No amend, branch,
push or stash: the dock's shell is the git client.

### Resolving a conflict in the file

Each `<<<<<<<` block gets **Accept Current | Incoming | Both** in the file
editor (`lib/editor-conflicts.ts`, parsing tested). It is an edit to the buffer,
read off the text, and a conflicted row opens on the editor rather than the
diff.

### The diff pane

CodeMirror's merge view, **read-only on both sides**; the right side is the
file's shared buffer (so unsaved edits show) and the left is `HEAD`. The changed
ranges come from **git** (`git diff HEAD --unified=0` through
`DiffConfig.override`), so the pane and the row's counts are one algorithm — and
the patch is checked against both texts and dropped whole if it does not match.
Inline or side by side, and whitespace, are settings. The diff is the one
editor **unmounted** rather than hidden, since a live one painted through other
panes.

### The editor

**Every editor is CodeMirror**, set up in `lib/editor.ts` and always behind a
`lazy`. A language is a dynamic import (`lib/editor-languages.ts`, 143 via
`@codemirror/language-data`, plus `.env` and Makefile grammars of our own). One
copy of `@codemirror/view` is enforced twice — see `CLAUDE.md`.
`lib/files/documents.ts` lets several views share one path's buffer. `⌘S` saves;
closing a tab writes rather than asks. The cost of leaving Monaco: `.ts` files
get no syntax squiggles.

### Hover and go-to-definition

A real **`tsserver`** per root, using that root's own `typescript` and nothing
if it has none, started with automatic typing acquisition off and fed the
editor's buffer. Spoken to directly rather than through an LSP layer
(`test/tsserver.ts` runs it for real).

## The block editor

BlockNote, behind a `.note` or (by choice) a `.md`. A `.note` is indented JSON
so it can be reviewed; one that is not JSON is read as markdown rather than
replaced. A `.md` is printed back lossily, so it is never the default:
frontmatter is set aside and restored byte for byte, and drawings and uploads
are switched off for it.

### Images

A dropped, pasted or uploaded picture becomes a file under
`workspace/note-files/` named by UUID, addressed as `note-file://workspace/<name>`
and served by `main/protocol.ts` (with `Range` for media). One type table in
`shared/note-files.ts` serves both directions. Nothing deletes one. The upload
panel is the studio's own.

### Drawings

`/drawing` is **Excalidraw**, edited in a dialog and shown in the document as an
SVG. The scene is `workspace/drawings/<id>.excalidraw`; the document holds only
the id in a ```drawing fence. Shapes default to straight (roughness 0, Nunito).
Excalidraw and its fonts are loaded on demand and served by this app. Numbered
**badges** are a group (circle + digit) so they resize as one, numbered from the
scene's `customData`, with their button portalled into Excalidraw's toolbar.

## The system bar

CPU and memory for the machine and this app, polled every two seconds by one
poller (each figure is a delta). Available memory includes reclaimable cache;
CPU is a share of all cores. The dock's shells are not counted as the app's.

### The usage dashboard counts tokens, not dollars

The rail's `Usage` dialog groups **tokens** (prompt on both sides of the cache,
plus output) by day, project, model and chat (`spendRows`,
`lib/worktree-chat/spend.ts`). On a subscription, a dollar estimate is a price
nobody pays.

## Updating

A pill in the status bar when GitHub has a newer release. **Not
`electron-updater`**: Squirrel.Mac will not replace an unsigned bundle. Instead,
`main/updater.ts` checks `releases/latest` (at launch, then every six hours),
downloads the `.dmg` itself with a progress bar, and runs the bundled
`install.sh` **detached**, since the script quits the app. `isNewer` is numeric
and strictly newer (`test/updates.ts`). Nothing pops up; skipping is per
version. Off macOS it links to the release page.

## The name

The app was **Yasuo**. The first run moves `~/.yasuo` to `~/.vsclaude`
(`migrateLegacyDataDir`) — except `workspace/worktrees`, which stays where its
absolute paths point — re-points profile directories, and renames Electron's
`userData`. Old `yasuo/untitled-…` branches still count as untitled. An update
from a build still called Yasuo installs beside it and has to be opened by hand
once.

## The launch screen

`splash.tsx` draws the studio assembling in miniature, held for
`SPLASH_ASSEMBLE_MS` and crossfaded into the workbench. Animation is CSS, in
`styles/motion.css`, by three rules: a movement says where a thing came from,
anything a click waits on is over in 250ms, and only opacity and transform are
animated. Under reduced motion the entrances go; the loops stay, so the launch
does not look hung.

## Removed

Removing a feature means deleting it — store, channels, types, tests — not
hiding it. What it left on disk stays (see The workspace). Kept here so a
reference to it still lands somewhere; the full argument for each is in git.

### Tasks, removed

A layer of named tasks gathering members from every panel. Deleted when the
column became projects.

### Board, removed

A kanban per project. A backlog is the one thing this studio cannot read off the
repository, so it was a duplicate of the team's tracker or its stale half.

### Watching ClickUp tasks, removed

A poll of watched tasks with agents assignable to them. A second account of
somebody else's tracker, with a key on the machine and a poll always running.

### Worktrees, removed

A layer between project and chat (`worktreeId` everywhere). The isolation was
paid for on every chat and wanted on few. The checkout came back as a project —
§ Worktrees, as projects.

### Distilling learnings, removed

A read-only turn proposing skills and `CLAUDE.md` lines from a chat. Unused; the
CLI's own `#` and a chat in `Edits` do the same.

### Run, removed

A `Run` tab with one command per folder. A second shell does it better.

### Preview, removed

A `<webview>` of the project's dev server in the dock. Unused; a page is read in
the user's own browser.

### Vertical tabs, removed

The strip as a column beside the pane. Nine `vertical` branches in one component
for a layout that took width from the pane.

### Grouped tabs, removed

A setting gathering a panel's tabs under one tab per folder, with a second strip
inside it. The strip is already per project, so the folder a tab would fold
under was nearly always the one on screen; what replaced it is the choice
between that and every project's tabs at once (§ One project's tabs, or every
project's). `orderWhere`, the in-place reorder
that keeps another project's tabs from closing on a drag, moved to `lib/tabs.ts`.
A stored `groupTabs` key is ignored.

### The assistant, removed

A workspace-wide read-only chat in the dock. Replaced by the project's chat.

### Comments, removed

Threads pinned to diff lines, a `Comments` tab and badges. Heavy for a gesture
that ended as a prompt; remarks go in the composer.

### Whose work this is, removed

Per-chat filter chips on `Changes`. Always incomplete — a `Bash` write named no
chat.

### Conversations, removed

A list of every CLI transcript on disk. Nothing reads `~/.claude/projects/` any
more except `retitle` and `chat-fork.ts`, for this app's own chats.

### Terminal sessions, removed

A Terminal panel whose chat view tailed the CLI transcript. Split into the
project's hosted chat and the dock's shells.

### Database and API, removed

Postgres/MySQL and an HTTP client. They worked, but nobody would choose this app
for them over TablePlus and Postman. Their panel windows went with them.

### Mail, removed

An SMTP sink (and before it a webhook catcher).

### Notes, removed

A Notes panel with its own tree and preview server. The block editor stayed, as
the Explorer's `.note` / `.md` viewer.

### The Env editor, removed

A `.env` as a table. Replaced by highlighting in the text editor.

### What the chats have cost, removed

A lifetime spend total in the system bar. A number that only grows answers no
question in the moment; the usage dashboard does.

### A chat's budget, removed

A per-chat dollar cap that warned. Unused.

### Snapshots and chat blame, removed

A per-turn snapshot commit chain under `refs/vsclaude/snapshots/` and a gutter
naming which chat wrote each line. Never wired: no handler was registered.

### Pipelines, removed

Chats chained into stages. Never wired into the UI.

### Claude config, removed

A read-only listing of `.claude.json`, `settings.json` and `remote-settings.json`
in Settings, with the user / project / local / managed levels folded into
effective settings. The one place this app read the CLI's files instead of
asking it, for an answer `/status` and `/config` already give.

### The browser build, removed

The same renderer served over HTTP on `127.0.0.1` by `src/server/`. A second
host with its own security surface, for a tab that did less than the window.
`main/host.ts` stays, so `createIpc` remains free of `electron` for the tests.

## Development

```sh
bun run dev       # Vite, then Electron against it; the renderer hot reloads
bun run test      # every test/*.ts, plain bun scripts (see test/harness.ts)
bun run build     # bundle main/preload/daemon and the renderer
bun run package   # ...then an installer with electron-builder
```

Changes under `src/main/`, `src/preload/` or `src/shared/` need `bun run dev`
restarted. Tests that touch the world do it for real — `test/files.ts` makes
real files, `test/git-changes.ts` drives a real repository — because a fixture
only checks the code against a memory of the format.

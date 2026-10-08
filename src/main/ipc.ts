import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import {
  CHAT_NOTIFICATIONS_KEY,
  CHAT_TRAY_KEY,
  IPC,
  type ChatImage,
  type ChatPlace,
  type ChatSeed,
  type ClaudeProfile,
  type FileDiff,
  type FileIndexEntry,
  type SearchOptions,
  type WorkspaceSearch,
  type WorktreeChatAnswer,
  type WorktreeChatOptions,
} from "../shared/api"
import { agentCommands } from "./agent-commands"
import { agentModels } from "./agent-models"
import { claudeAccount } from "./claude-auth"
import { claudeBinary } from "./claude-bin"
import { WorktreeChats } from "./worktree-chat"
import * as files from "./files"
import { MAX_INDEXED_FILES } from "./files"
import { matcherOf, MAX_SEARCH_MATCHES, searchFiles } from "./content-search"
import {
  changes,
  log,
  commit,
  currentBranch,
  discard,
  discardAll,
  blame,
  fileAtHead,
  fileDiff,
  stage,
  unstage,
  workingTree,
} from "./git"
import { ChatNotices, noticeText, type ChatNotice } from "./notify"
import { installedMcpServers, removeMcpServer } from "./mcp-servers"
import { planUsage } from "./plan-usage"
import { draftCommitMessage } from "./one-turn-agent"
import type { Host } from "./host"
import { expandHome, quote } from "./shell-env"
import { systemUsage } from "./system-usage"
import { Store } from "./store"
import { TerminalManager } from "./terminal"
import { TsServers } from "./tsserver"
import { checkForUpdate, downloadUpdate, startInstaller } from "./updater"
import { DirectoryWatchers, RootWatchers } from "./watch"
import {
  addWorktree,
  branchFromTitle,
  isUntitledBranch,
  removeWorktree,
  renameBranch,
  untitledBranch,
  worktreeDir,
  worktreeRepo,
} from "./worktrees"

/** What `readImageDataUrl` will actually recognize — the same extensions
 * `pickImages`'s dialog filter offers. */
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
}

/** A thumbnail is all this is for — never worth holding a huge image whole
 * in memory just to preview it. */
const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024

/** The most commits one `git:log` call answers with — see that handler. The
 * `Commits` view re-reads everything it has shown on every commit, in one call,
 * so this is also how far it can be paged before a re-read stops covering it. */
const MAX_LOG_PAGE = 1000

/**
 * Where `install.sh` puts the app, and so the bundle the updater reopens.
 *
 * Deliberately not this process's own `app.getPath("exe")`: the script installs
 * into `/Applications` whatever directory the running copy was launched from,
 * so reopening where *this* one lives could open the build that was just
 * replaced — or, from a dev run, an Electron binary in `node_modules`.
 */
const APP_DIR = "/Applications/Yasuo.app"

/**
 * An image on disk as a data URL.
 *
 * Shared by the two handlers that need one — the composer's attachments, which
 * name a file anywhere, and the Spec panel's screenshots, which name one inside
 * a folder — so that "too large" and "which types are pictures" are answered
 * once. The renderer's origin is not `file://` and Chromium will not load a
 * `file://` subresource from any other origin, which is why either of them
 * needs bytes rather than a path.
 */
async function imageDataUrl(filePath: string): Promise<string> {
  const stats = await stat(filePath)
  if (stats.size > MAX_IMAGE_PREVIEW_BYTES) {
    const megabytes = (stats.size / (1024 * 1024)).toFixed(1)
    throw new Error(
      `${path.basename(filePath)} is too large to preview (${megabytes} MB).`
    )
  }
  const mime = IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()]
  const data = await readFile(filePath)
  return `data:${mime ?? "application/octet-stream"};base64,${data.toString("base64")}`
}

/**
 * The clipboard's image spilled to a file, so a terminal can paste a path.
 *
 * `tmpdir()` rather than anywhere under `~/.yasuo`: this is a scratch copy of
 * something the user still holds in their clipboard, the OS already knows to
 * clean the directory out, and it is where the system terminals put the same
 * file — the `/var/folders/…` path a pasted screenshot turns into there.
 *
 * PNG whatever came in, because that is the one encoding `NativeImage` can be
 * asked for without knowing what the clipboard's own format was.
 *
 * The bytes come either from the host's own clipboard or, from a browser tab,
 * from the caller: a page can read the clipboard it was pasted into, and a
 * server on the same machine reading the system one behind its back would be
 * reading something nobody pasted.
 */
async function clipboardImagePath(
  png: Uint8Array | null
): Promise<string | null> {
  if (!png || png.length === 0) return null

  const file = path.join(tmpdir(), `yasuo-paste-${Date.now()}.png`)
  await writeFile(file, png)
  return file
}

/** One handler: the transport's own idea of the caller first (an Electron
 * `IpcMainInvokeEvent`, or nothing from the server), then the call's
 * arguments as the renderer passed them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (caller: unknown, ...args: any[]) => unknown

/**
 * Every renderer-callable method, as one table keyed by `IPC` channel.
 *
 * Built once for the whole app rather than per window, and handed to whichever
 * transport is carrying it: `electron-ipc.ts` puts each entry on `ipcMain`, and
 * `src/server/` answers the same entries over HTTP for the web build. What the
 * two hosts genuinely do differently — a dialog, a window, the menu bar — comes
 * in through `host` and is nowhere else in this file.
 */
export function createIpc(host: Host): {
  handlers: Map<string, Handler>
  /** Exposed so a turn in flight can be killed on quit. */
  worktreeChats: WorktreeChats
  terminals: TerminalManager
  tsServers: TsServers
  /** Both kinds of `fs.watch` — the tree's and the `Changes` list's. */
  watchers: { closeAll: () => void }
  startTray: () => Promise<void>
  noteFilePath: (fileName: string) => string
} {
  const store = new Store()

  const handlers = new Map<string, Handler>()
  const handle = (channel: string, handler: Handler): void => {
    handlers.set(channel, handler)
  }

  /*
   * Every window, not only the studio's: a chat popped out into a window of
   * its own is the same conversation and has to see the same lines. A window
   * that holds no terminal ignores a `terminal:data` it is sent, which is
   * cheaper than a table of who wants what.
   */
  const send = host.send

  const terminals = new TerminalManager({
    data: (event) => send(IPC.terminalData, event),
    exit: (event) => send(IPC.terminalExit, event),
  })

  /**
   * A picked `profileId` as a `CLAUDE_CONFIG_DIR`, for a one-turn agent.
   *
   * The same resolve `worktree-chat.ts` does at send time (`profileConfigDir`
   * there), asked here instead because a drafted message has no chat and no
   * `WorktreeChats` record to resolve it on. Looked up by id
   * rather than trusted from the renderer, same reason: a profile can be
   * renamed or deleted between the picker being drawn and the button being
   * pressed.
   */
  const configDirOf = async (
    profileId: string | null
  ): Promise<string | null> => {
    if (!profileId) return null
    const profile = (await store.listClaudeProfiles()).find(
      (entry) => entry.id === profileId
    )
    return profile ? expandHome(profile.configDir) : null
  }

  /*
   * A project's chats: one agent turn at a time, in that project's directory.
   *
   * The larger of the two `claude`s this app spawns, and the only one that is a
   * conversation. What the old "no second one" rule was about is still refused —
   * a feature calling the CLI as a helper, an AI filter or an import button —
   * because a helper turn is a turn nobody asked for. `draftCommitMessage`
   * below is the turn beside these, and is not one of those: it is a button
   * pressed by the person who reads its answer. See the top of
   * `one-turn-agent.ts`.
   */
  const worktreeChats = new WorktreeChats(
    {
      // Null rather than a throw for a folder that has left the workspace: the
      // caller turns "nowhere to run" into a line in the chat, and one path
      // through that is easier to be sure of than two.
      folderDir: (folderId) =>
        store.resolveFolderDir(folderId).catch(() => null),
      // Asked per turn rather than held — Settings can add, rename or delete a
      // profile between two messages in the same chat.
      claudeProfiles: () => store.listClaudeProfiles(),
      chats: () => store.listWorktreeChats(),
      saveChats: (chats) => store.saveWorktreeChats(chats),
      readChat: (id) => store.readWorktreeChat(id),
      writeChat: (id, messages) => store.writeWorktreeChat(id, messages),
      deleteChat: (id) => store.deleteWorktreeChat(id),
    },
    (event) => {
      send(IPC.worktreeChatEvent, event)
      const notice = notices.read(event)
      void announce(notice)
      // Every event, not just the ones worth a banner: the count in the menu
      // bar is a state and not an interruption, so a `busy` that rings nothing
      // still moves it.
      void refreshTray()
    }
  )

  const notices = new ChatNotices()

  /**
   * The count in the menu bar, off the same watcher the notifications are.
   *
   * See `tray.ts` for what it is for. The host builds it — it is Electron's, and
   * the web build has no menu bar to put it in — but it is fed from here,
   * because this is where the events are. It cannot be *shown* until the app is
   * ready — a `Tray` before then throws — which is what `startTray` below is
   * for.
   */
  const tray = host.tray

  /**
   * Which draw of the tray is the current one.
   *
   * The listing is read from disk, so two events a few milliseconds apart are
   * two awaits that can land in either order — and the one that lands second
   * wins the icon. Without this the count sticks on whatever the slower read
   * was counting, which looks exactly like a chat that never finished.
   */
  let trayDraw = 0

  /** Redraws the tray, if it is in the strip at all. */
  const refreshTray = async (): Promise<void> => {
    if (!tray?.shown) return
    const draw = ++trayDraw
    const pending = notices.pending()
    // Only for the names in the menu, so an idle machine reads no files.
    const running = pending.working.length + pending.waiting.length > 0
    const chats = running ? await worktreeChats.list() : []
    if (draw !== trayDraw) return
    tray.update(pending, chats)
  }

  /**
   * Puts the icon in the strip, or takes it out, to match the setting.
   *
   * Called once the app is ready and again whenever that setting changes. Off
   * by default is the wrong default here for the reason it is wrong for
   * notifications — see `CHAT_TRAY_KEY` — so an unset key reads as on.
   */
  const applyTraySetting = async (): Promise<void> => {
    if (!tray) return
    tray.setShown((await store.getSetting(CHAT_TRAY_KEY)) !== "off")
    await refreshTray()
  }

  /**
   * Rings the OS notification a chat's event turned out to deserve.
   *
   * **Only while the studio window is unfocused**, which is the whole point of
   * the feature rather than a courtesy: several chats answering at once is what
   * this app is for, and the cost of that is walking away from a window with
   * three turns running in it. Somebody looking at the window can see the row
   * spinning, and a banner over the composer they are typing into is noise.
   *
   * The title is read out of the listing at the moment the notice is due rather
   * than tracked alongside it: a chat is named by its first message and renamed
   * by `retitle` partway through that same turn, so a name captured when the
   * turn started is the wrong one exactly on the turn somebody is least likely
   * to recognise by id.
   */
  const announce = async (notice: ChatNotice | null): Promise<void> => {
    if (!notice) return
    // Off by default is the wrong default for the one feature that says "your
    // agent finished"; an unset key reads as on.
    if ((await store.getSetting(CHAT_NOTIFICATIONS_KEY)) === "off") return

    // Any window of this app's, not only the studio's: a chat popped out into
    // its own window and being read there is one nobody needs calling back to.
    if (host.focused()) return

    const chats = await worktreeChats.list()
    const chat = chats.find((entry) => entry.id === notice.chatId)
    // A chat with no row is one the `+` opened and nobody has spoken into, so
    // there is nothing to call it and nothing to call somebody back to.
    if (!chat) return

    // Clicking it is the way back to the chat it is about — a notification that
    // only tells you something happened leaves you hunting for the row.
    host.notify({ ...noticeText(notice, chat.title), chatId: notice.chatId })
  }

  // Asked of the user's own `claude` and held for the run — see
  // `agent-models.ts`. Not a handler that touches any of the managers above,
  // which is why it takes no argument and keeps no state here.
  handle(IPC.agentModels, () => agentModels())

  /*
   * The slash commands that `claude` has, asked in a project's directory — see
   * `agent-commands.ts`. The directory is resolved here for the reason every
   * other `folderId` call resolves it here: a project is an id in the manifest,
   * and the path behind it is the store's to say.
   */
  handle(IPC.agentCommands, async (_event, folderId: unknown) =>
    agentCommands(await folderDirOf(folderId))
  )

  /*
   * The MCP servers that same `claude` has, asked in a project's directory —
   * see `mcp-servers.ts`.
   *
   * The directory is resolved here rather than in the renderer for the reason
   * every other `folderId` call is: a project is an id in the manifest, and the
   * path behind it is the store's to say. A project that has left the workspace
   * reads as null, which asks in the user's home directory — the user-scope
   * servers and nothing repository-specific, which is the honest answer for a
   * project that is no longer there.
   */
  handle(IPC.installedMcpServers, async (_event, folderId: unknown) =>
    installedMcpServers(await folderDirOf(folderId))
  )

  // The profile resolved here rather than a path trusted from the renderer —
  // the same `configDirOf` the commit draft goes through.
  handle(
    IPC.planUsage,
    async (_event, profileId: string | null, fresh: boolean) =>
      planUsage(await configDirOf(profileId), fresh === true)
  )

  // The CLI's own `mcp remove`, in the same directory the listing was asked in —
  // a `project`-scope server is in that repository's file and nowhere else. The
  // renderer confirms first and re-asks for the listing afterwards; this only
  // does it, and lets the CLI's own error through.
  handle(
    IPC.removeMcpServer,
    async (
      _event,
      input: { name: string; scope: string | null; folderId: string | null }
    ) =>
      removeMcpServer({
        name: input.name,
        scope: input.scope,
        cwd: await folderDirOf(input.folderId),
      })
  )

  /** A project's directory, or null for one that has left the workspace —
   * shared by the two MCP handlers above, which both run `claude` somewhere. */
  async function folderDirOf(folderId: unknown): Promise<string | null> {
    return typeof folderId === "string"
      ? await store.resolveFolderDir(folderId).catch(() => null)
      : null
  }

  handle(IPC.listClaudeProfiles, () => store.listClaudeProfiles())

  handle(IPC.saveClaudeProfiles, (_event, profiles: ClaudeProfile[]) =>
    // `~` expanded here, like `addFolder`'s path field: the SDK spawns
    // `claude` directly rather than through a shell, so nothing else would
    // ever turn a `~/.claude-group/hung` into an absolute path before it
    // became `CLAUDE_CONFIG_DIR` — and a literal `~` in that variable is a
    // directory named `~` relative to the turn's cwd, not the user's home.
    // Nothing types one any more (the store names the directory itself), but
    // the profiles that field wrote are on people's disks.
    store.saveClaudeProfiles(
      profiles.map((profile) => ({
        ...profile,
        configDir: expandHome(profile.configDir),
      }))
    )
  )

  handle(IPC.claudeAccount, (_event, configDir: string) =>
    claudeAccount(configDir)
  )

  /**
   * `claude auth login` for one profile's directory, in a pty of its own.
   *
   * The one place this app runs a `claude` the user could not have run
   * themselves in a shell — and it runs exactly that, through the same login
   * shell every other pty is started in, so a CLI installed by an alias or a
   * shell function is found the way `locate` finds one.
   */
  handle(
    IPC.claudeLogin,
    async (_event, configDir: string, cols: number, rows: number) => {
      const dir = configDir.trim() ? expandHome(configDir.trim()) : ""

      // Made here rather than left to the CLI, which is the opposite of what
      // `claudeAccount` does with the same path: that one probes something
      // somebody may still be typing, and a directory conjured out of a typo is
      // the failure it is written against. This is a directory somebody asked
      // for by name, so the only thing the pty can then fail at is the login.
      if (dir) await mkdir(dir, { recursive: true })

      const binary = claudeBinary()
      // Quoted only when it is a path: `CLAUDE_BIN` can name a file with a
      // space in it, while a bare `claude` is often an alias or a shell
      // function, and quoting one stops the shell expanding it at all.
      const command = `${binary.includes("/") ? quote(binary) : binary} auth login`

      return terminals.create(
        {
          // The user's home rather than a project, for `claudeAccount`'s
          // reason: a login is about the config directory, and a repository's
          // own settings have no say in whose account it holds.
          cwd: homedir(),
          // On the command line as well as in the environment, because the pty
          // is a *login* shell: somebody already running several identities is
          // exactly the person whose own `.zshrc` exports `CLAUDE_CONFIG_DIR`,
          // and that export runs after this env is handed over — it would win,
          // and sign the wrong directory in.
          command: dir ? `CLAUDE_CONFIG_DIR=${quote(dir)} ${command}` : command,
          env: dir ? { CLAUDE_CONFIG_DIR: dir } : {},
        },
        cols,
        rows
      )
    }
  )

  handle(IPC.listWorktreeChats, () => worktreeChats.list())

  handle(IPC.createWorktreeChat, (_event, place: ChatPlace, seed?: ChatSeed) =>
    worktreeChats.create(place, seed)
  )

  handle(IPC.readWorktreeChat, (_event, id: string) => worktreeChats.read(id))

  handle(IPC.chatDigests, () => worktreeChats.digests())

  handle(IPC.chatSpend, () => worktreeChats.spend())

  /*
   * A file the user names, which is the one write allowed outside the
   * workspace's roots: the save dialog is the gate, the way the open dialog is
   * for `addFolder`. Nothing is written when it is cancelled.
   */
  handle(
    IPC.saveTextFile,
    (
      caller,
      input: {
        defaultName: string
        text: string
        filters?: { name: string; extensions: string[] }[]
      }
    ): Promise<string | null> => host.saveTextFile(caller, input)
  )

  handle(IPC.openChatWindow, (_event, chatId: string) => {
    host.openChatWindow(chatId)
  })

  // On the *calling* window: the studio has no reason to pin itself, and a
  // popped-out chat is the one that wants to stay over another editor.
  handle(IPC.setAlwaysOnTop, (caller, on: boolean) => {
    host.setAlwaysOnTop(caller, on)
  })

  handle(IPC.isAlwaysOnTop, (caller) => host.isAlwaysOnTop(caller))

  /*
   * The left column's Search. `searching` is the generation: each call takes
   * the next one, and an older call still walking sees it has moved and stops,
   * so typing a word is one search finishing rather than one per letter.
   *
   * Chats before files, because they are the cheaper read and the rows that
   * this app alone can answer — an editor's search already finds the files.
   */
  let searching = 0
  handle(
    IPC.searchWorkspace,
    async (
      _event,
      query: string,
      options: SearchOptions
    ): Promise<WorkspaceSearch> => {
      const generation = (searching += 1)
      const stale = () => generation !== searching
      const none: WorkspaceSearch = {
        files: [],
        chats: [],
        truncated: false,
        error: null,
      }

      const built = matcherOf(query, options)
      if (!built) return none
      if ("error" in built) return { ...none, error: built.error }

      const chats = await worktreeChats.search(
        built.matcher,
        MAX_SEARCH_MATCHES,
        stale
      )
      const found = await searchFiles(await fileRoots(), built.matcher, {
        limit: MAX_SEARCH_MATCHES - chats.matches,
        stale,
      })
      return {
        files: found.files,
        chats: chats.chats,
        truncated: found.truncated || chats.matches >= MAX_SEARCH_MATCHES,
        error: null,
      }
    }
  )

  handle(IPC.deleteWorktreeChat, (_event, id: string) => {
    // Before the delete rather than after: a chat killed mid-turn emits no
    // `busy: false`, so the watcher would keep it as working for the rest of
    // the run and swallow the first quiet of whatever reused the id.
    notices.forget(id)
    // The deleted chat may have been the one the strip was counting.
    void refreshTray()
    return worktreeChats.delete(id)
  })

  handle(IPC.clearWorktreeChat, (_event, id: string) => worktreeChats.clear(id))

  handle(IPC.renameWorktreeChat, (_event, id: string, title: string) =>
    worktreeChats.rename(id, title)
  )

  handle(
    IPC.setWorktreeChatOptions,
    (_event, id: string, options: WorktreeChatOptions) =>
      worktreeChats.setOptions(id, options)
  )

  handle(
    IPC.answerWorktreeChatAsk,
    (_event, askId: string, answer: WorktreeChatAnswer) => {
      worktreeChats.answer(askId, answer)
    }
  )

  handle(
    IPC.sendWorktreeChat,
    (_event, id: string, prompt: string, images?: ChatImage[]) =>
      worktreeChats.send(id, prompt, images ?? [])
  )

  handle(IPC.stopWorktreeChat, (_event, id: string) => {
    worktreeChats.stop(id)
  })

  handle(IPC.getWorkspace, () => store.getWorkspace())

  handle(IPC.pickDirectory, () => host.pickDirectory())

  handle(IPC.pickImages, () =>
    host.pickFiles({ title: "Attach images", images: true })
  )

  handle(IPC.pickFiles, (_event, directory?: string) =>
    host.pickFiles({
      title: "Attach files",
      images: false,
      // Where it opens, not what it may return: the paths come back from the
      // user's own click, and reading one is still an ordinary `files:*` call
      // through `insideAny`.
      ...(directory ? { directory: expandHome(directory) } : {}),
    })
  )

  handle(IPC.readImageDataUrl, (_event, filePath: string) =>
    imageDataUrl(filePath)
  )

  handle(IPC.clipboardImagePath, async (_event, png?: Uint8Array | null) =>
    clipboardImagePath(png ?? (await host.clipboardImage()))
  )

  handle(IPC.addFolder, (_event, input: { path: string; name: string }) =>
    store.addFolder({ ...input, path: expandHome(input.path) })
  )

  handle(IPC.renameFolder, (_event, id: string, name: string) =>
    store.renameFolder(id, name)
  )

  handle(IPC.removeFolder, (_event, id: string) => store.removeFolder(id))

  /*
   * A second checkout of a project, which becomes a project.
   *
   * Two calls in one handler because half of it is not the studio's to undo: a
   * `git worktree add` that lands and an `addFolder` that then refuses would
   * leave a directory on disk that nothing in the app knows about. So the
   * directory is named here, git makes it, and the folder record is the same
   * `addFolder` the dialog uses — which is also the check that this checkout is
   * not already open as a project.
   */
  handle(
    IPC.addWorktree,
    async (
      _event,
      input: { folderId: string; branch: string; name: string }
    ) => {
      // An empty field is deliberate and is the interesting case: the checkout
      // goes on a placeholder branch and is named after the first chat that runs
      // in it — see `nameWorktree` below.
      const branch = input.branch.trim() || untitledBranch()

      const repo = await store.resolveFolderDir(input.folderId)
      const dir = worktreeDir(store.workspaceFilesDir, input.folderId, branch)

      const made = await addWorktree({ repo, dir, branch })
      if ("error" in made) throw new Error(made.error)

      // The branch, when the field was left empty: a project row reading
      // `yasuo/untitled-a1b2c3` for the minute before the first turn names it
      // says what is happening, where the repository's own name said nothing.
      return store.addFolder({
        path: made.dir,
        name: input.name.trim() || branch,
      })
    }
  )

  /*
   * The name a checkout gets from the chat running in it.
   *
   * Three things have to be true and the first two are cheap, which is what
   * makes this affordable on every chat that is ever titled: the folder is a
   * checkout at all, and the branch it is on is still one this app minted. Only
   * then does anything get written — and what is written is `git branch -m` in
   * that checkout plus the folder's own name, which is the **title** rather
   * than the slug: the branch is for git and the row is for reading.
   */
  handle(IPC.nameWorktree, async (_event, folderId: string, title: string) => {
    const named = title.trim()
    const wanted = named ? branchFromTitle(named) : null
    if (!wanted) return null

    const dir = await store.resolveFolderDir(folderId)
    const branch = await currentBranch(dir)
    if (!isUntitledBranch(branch) || !branch) return null
    // Last, because it is the one that shells out twice.
    if (!(await worktreeRepo(dir))) return null

    // A rename git refused leaves the placeholder, and the project keeps the
    // name it had: half of this landing would be worse than none of it.
    if (!(await renameBranch(dir, branch, wanted))) return null

    return store.renameFolder(folderId, named)
  })

  /*
   * And back out: the checkout removed, then the project dropped.
   *
   * In that order, so a `git worktree remove` that refuses leaves the project
   * where it is rather than hiding a directory somebody now has to find. The
   * repository is asked for rather than remembered — see `worktreeRepo`.
   */
  handle(IPC.removeWorktree, async (_event, folderId: string) => {
    const dir = await store.resolveFolderDir(folderId)
    const repo = await worktreeRepo(dir)
    if (!repo) throw new Error(`${dir} is not a git worktree checkout.`)

    const failed = await removeWorktree(repo, dir)
    if (failed) throw new Error(failed.error)

    return store.removeFolder(folderId)
  })

  handle(IPC.gitBranch, async (_event, folderId: string) =>
    currentBranch(await store.resolveFolderDir(folderId))
  )

  handle(IPC.gitWorktreeRepo, async (_event, folderId: string) =>
    worktreeRepo(await store.resolveFolderDir(folderId))
  )

  handle(IPC.gitStatus, async (_event, folderId: string) =>
    workingTree(await store.resolveFolderDir(folderId))
  )

  handle(IPC.gitChanges, async (_event, folderId: string) =>
    changes(await store.resolveFolderDir(folderId))
  )

  // A page of history rather than all of it: a repository's whole log is tens
  // of thousands of rows. Clamped here, since the numbers are the renderer's
  // and a page of `Infinity` is the whole log by another name.
  handle(
    IPC.gitLog,
    async (_event, folderId: string, limit: number, skip = 0) =>
      log(
        await store.resolveFolderDir(folderId),
        Math.max(1, Math.min(MAX_LOG_PAGE, Math.floor(limit) || 1)),
        Math.max(0, Math.floor(skip) || 0)
      )
  )

  /*
   * The Changes list's three writes.
   *
   * Two gates, not one, and neither is redundant. `inWorkspace` is the same
   * check the eight `files:*` handlers pass through — an absolute path from the
   * renderer can name anything on the machine — and `git.ts` then refuses
   * anything that is not under the folder it was handed, so a path inside
   * *another* of the workspace's folders cannot be staged into this one's
   * repository.
   *
   * What comes back from a discard is the paths git had nothing to restore —
   * new files — and those are trashed here rather than in `git.ts`, which stays
   * free of `electron` so the tests can import it.
   */
  handle(IPC.gitStage, async (_event, folderId: string, paths: string[]) =>
    stage(
      await store.resolveFolderDir(folderId),
      await Promise.all(paths.map(inWorkspace))
    )
  )

  handle(IPC.gitUnstage, async (_event, folderId: string, paths: string[]) =>
    unstage(
      await store.resolveFolderDir(folderId),
      await Promise.all(paths.map(inWorkspace))
    )
  )

  handle(IPC.gitDiscard, async (_event, folderId: string, paths: string[]) => {
    const trash = await discard(
      await store.resolveFolderDir(folderId),
      await Promise.all(paths.map(inWorkspace))
    )
    await trashAll(trash)
  })

  handle(IPC.gitDiscardAll, async (_event, folderId: string) => {
    await trashAll(await discardAll(await store.resolveFolderDir(folderId)))
  })

  /*
   * The staged work, committed — the fourth git write, and the argument for it
   * is on `commit` in `git.ts` and in `docs/design.md` § Committing.
   *
   * The message is not touched on the way through: it is whatever the box held,
   * and `commit` refuses an empty one. Git's own error comes back as the
   * rejection, hooks included — a `pre-commit` that refused has said something
   * worth reading, and a sentence of this app's own in front of it would hide
   * it.
   */
  handle(IPC.gitCommit, async (_event, folderId: string, message: string) =>
    commit(await store.resolveFolderDir(folderId), message)
  )

  /*
   * A commit message drafted from the staged diff by the read-only `claude`.
   *
   * Settings › Claude's three, `profileId` resolved through `configDirOf`.
   * Answers rather than throws: a draft that did not arrive leaves the box exactly as it was, which is a message somebody
   * types themselves.
   */
  handle(
    IPC.draftCommitMessage,
    async (
      _event,
      folderId: string,
      model: string | null,
      effort: string | null,
      profileId: string | null
    ) =>
      draftCommitMessage({
        cwd: await store.resolveFolderDir(folderId),
        model,
        effort,
        configDir: await configDirOf(profileId),
      })
  )

  /**
   * The new files a discard could not restore, moved to the trash.
   *
   * One at a time and each failure swallowed: the trash refuses on a
   * volume with no trash, and a discard that restored eleven files and then
   * threw on the twelfth would leave the list saying nothing about the ten it
   * did. The row that is still there afterwards is the report.
   */
  async function trashAll(paths: string[]): Promise<void> {
    for (const target of paths) {
      await host.trash(target).catch((error: unknown) => {
        console.error(`Could not trash ${target}`, error)
      })
    }
  }

  /**
   * The committed side of a diff, and git's own patch for it.
   *
   * Through the same gate as every other read of a file, and then run in the
   * root that holds it: `HEAD:` is a path in one repository, so the folder the
   * path lives under is the one to ask.
   *
   * The two run together rather than one after the other — they are two
   * independent `git` processes and the pane waits for both before it draws
   * anything, so serialising them would be a second round trip's wait for the
   * same paint.
   */
  handle(IPC.fileDiff, async (_event, filePath: string): Promise<FileDiff> => {
    const target = await inWorkspace(filePath)
    const roots = await fileRoots()

    // The narrowest root that holds it, since one folder can be added inside
    // another — the same rule `rootOf` follows in the renderer.
    const root = roots
      .filter((candidate) => files.insideAny([candidate.path], target))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!root) return { head: null, patch: null }

    const [head, patch] = await Promise.all([
      fileAtHead(root.path, target),
      fileDiff(root.path, target),
    ])
    return { head, patch }
  })

  // The narrowest root again, for the same reason as above.
  handle(IPC.gitBlame, async (_event, filePath: string, text: string) => {
    const target = await inWorkspace(filePath)
    const root = (await fileRoots())
      .filter((candidate) => files.insideAny([candidate.path], target))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!root || typeof text !== "string") return null
    return blame(root.path, target, text)
  })

  /**
   * Every directory the Explorer may read: the workspace's folders.
   *
   * Read fresh on every call, like the workspace itself: a folder removed
   * between one read and the next has to stop being readable at once.
   *
   * Still its own function rather than a `getWorkspace()` at each call site
   * because it is the one list four things are answered from — the gate below,
   * the watchers, the palette's walk and the tsservers.
   */
  async function fileRoots(): Promise<{ path: string; folderId: string }[]> {
    const { folders } = await store.getWorkspace()
    return folders.map((folder) => ({ path: folder.path, folderId: folder.id }))
  }

  /**
   * The one gate in front of the Explorer's reads and writes.
   *
   * Every `files:*` handler goes through this before it touches anything: the
   * renderer sends an absolute path, and an absolute path can name anything on
   * the machine. The workspace's folders are what the user pointed the studio
   * at, so they are what the studio is allowed to open — a rule the renderer
   * cannot be trusted to keep for itself, since the whole point of the check is
   * the case where the renderer is wrong.
   *
   * Read fresh each time rather than cached: a folder removed from the
   * workspace has to stop being writable at once, and the manifest read is a
   * small file behind a queue.
   */
  async function inWorkspace(target: string): Promise<string> {
    if (
      !files.insideAny(
        (await fileRoots()).map((root) => root.path),
        target
      )
    ) {
      throw new Error(
        `${path.basename(target)} is outside the workspace's folders.`
      )
    }
    return target
  }

  handle(IPC.listDirectory, async (_event, dirPath: string) =>
    files.listDirectory(await inWorkspace(dirPath))
  )

  handle(IPC.readTextFile, async (_event, filePath: string) =>
    files.readTextFile(await inWorkspace(filePath))
  )

  handle(IPC.writeTextFile, async (_event, filePath: string, text: string) =>
    files.writeTextFile(await inWorkspace(filePath), text)
  )

  handle(IPC.createFile, async (_event, dir: string, name: string) =>
    files.createFile(await inWorkspace(dir), name)
  )

  handle(IPC.createDirectory, async (_event, dir: string, name: string) =>
    files.createDirectory(await inWorkspace(dir), name)
  )

  handle(IPC.renamePath, async (_event, target: string, name: string) =>
    files.renamePath(await inWorkspace(target), name)
  )

  handle(IPC.trashPath, async (_event, target: string) => {
    // The OS trash rather than `unlink`: this is somebody's source file, the
    // studio has no undo of its own, and every desktop already has one.
    await host.trash(await inWorkspace(target))
  })

  handle(IPC.revealPath, async (_event, target: string) => {
    await host.reveal(await inWorkspace(target))
  })

  handle(IPC.readImageFile, async (_event, filePath: string) =>
    // The same reader the composer's attachments use — including its size
    // ceiling, which is what keeps a 40MP photograph from being turned into a
    // base64 string and posted across the bridge.
    imageDataUrl(await inWorkspace(filePath))
  )

  handle(IPC.readImageRelative, async (_event, dir: string, relative: string) =>
    // The markdown preview's local pictures: `./logo.png` resolved against
    // the document's own directory — the renderer never joins paths — and
    // read under the same ceiling and the same folders' gate as any other
    // file the studio shows.
    imageDataUrl(await inWorkspace(path.resolve(dir, relative)))
  )

  handle(
    IPC.resolveRelativePath,
    async (_event, dir: string, relative: string) => {
      // The markdown preview's links. A miss is an answer rather than a throw:
      // a README linking to a file that was never committed is ordinary.
      try {
        const target = await inWorkspace(path.resolve(dir, relative))
        return { path: target, directory: (await stat(target)).isDirectory() }
      } catch {
        return null
      }
    }
  )

  /*
   * One TypeScript server per workspace folder, started the first time a file
   * in that folder is opened — see `main/tsserver.ts`. It is handed a reader
   * for the folders rather than the store, since where the workspace points is
   * the only thing it needs to know.
   *
   * Every path is checked the same way the reads and writes above are: a hover
   * is a file being sent to a process, which is exactly the kind of call the
   * gate exists for.
   */
  // One server per root, since a root has its own `node_modules` and
  // `tsconfig.json` and resolving one folder's imports against another's copy
  // is how a hover ends up pointing at the wrong source. `serverFor` takes the
  // longest match, and each server is started only when a file in it is opened.
  const tsServers = new TsServers(async () =>
    (await fileRoots()).map((root) => root.path)
  )

  handle(IPC.tsOpen, async (_event, filePath: string, text: string) =>
    tsServers.open(await inWorkspace(filePath), text)
  )

  handle(IPC.tsChange, async (_event, filePath: string, text: string) =>
    tsServers.change(await inWorkspace(filePath), text)
  )

  handle(IPC.tsClose, async (_event, filePath: string) =>
    tsServers.close(await inWorkspace(filePath))
  )

  handle(
    IPC.tsHover,
    async (_event, filePath: string, line: number, column: number) =>
      tsServers.hover(await inWorkspace(filePath), line, column)
  )

  handle(
    IPC.tsDefinition,
    async (_event, filePath: string, line: number, column: number) =>
      // Definitions are deliberately *not* filtered to the workspace on the way
      // back: a symbol imported from a package is declared under
      // `node_modules`, which is inside the folder, but one from a linked
      // package may not be. The renderer opens what it is given through
      // `readTextFile`, which is checked in its own right — so a definition
      // outside the workspace is a tab that refuses to open rather than a read
      // that slipped through.
      tsServers.definition(await inWorkspace(filePath), line, column)
  )

  /*
   * The tree follows the disk while it is open — see `main/watch.ts` for why
   * this watches the expanded directories and nothing above or below them.
   */
  const directoryWatchers = new DirectoryWatchers((dir) =>
    send(IPC.directoryChanged, { dir })
  )
  // And each root as a whole, so a write into a folder nobody has expanded
  // still reaches the `Changes` list — see `RootWatchers`.
  const rootWatchers = new RootWatchers((root, paths, overflow) =>
    send(IPC.treeChanged, { root, paths, overflow })
  )
  const watchers = {
    closeAll() {
      directoryWatchers.closeAll()
      rootWatchers.closeAll()
    },
  }

  handle(IPC.watchDirectories, async (_event, dirs: string[]) => {
    const roots = (await fileRoots()).map((root) => root.path)
    // Re-set on every call, and the renderer sends one when the folders
    // change as well as when the tree does.
    rootWatchers.set(roots)
    directoryWatchers.set([
      // Filtered rather than refused: this call carries a whole set, and one
      // directory belonging to a folder removed while the message was in
      // flight would otherwise cost the tree every other watcher it asked for.
      ...dirs.filter((dir) => files.insideAny(roots, dir)),
      // Each root's own `.git`, whatever the renderer asked for. A commit or a
      // checkout in the dock's shell changes the colour of every row and the
      // branch beside the folder, while touching no directory the tree is
      // watching. Added here rather than sent from the renderer because this
      // side is the one that joins a name to a path.
      ...roots.map((root) => path.join(root, ".git")),
    ])
  })

  handle(IPC.listWorkspaceFiles, async () => {
    // Sequential rather than `Promise.all`, so the budget is shared: two roots
    // walked at once would each take the whole cap and hand back twice what
    // the renderer agreed to hold.
    const found: FileIndexEntry[] = []
    for (const root of await fileRoots()) {
      if (found.length >= MAX_INDEXED_FILES) break
      found.push(
        ...(await files.indexFiles(
          root.path,
          root.folderId,
          MAX_INDEXED_FILES - found.length
        ))
      )
    }
    return found
  })

  handle(IPC.getSetting, (_event, key: string) => store.getSetting(key))

  handle(IPC.setSetting, async (_event, key: string, value: string) => {
    await store.setSetting(key, value)
    // The one setting with something of this process' own hanging off it: the
    // switch has to put the icon in the menu bar or take it out there and then,
    // since nothing else here re-reads it.
    if (key === CHAT_TRAY_KEY) await applyTraySetting()
  })

  handle(IPC.readDrawing, (_event, id: string) => store.readDrawing(id))

  handle(IPC.writeDrawing, (_event, id: string, scene: string) =>
    store.writeDrawing(id, scene)
  )

  handle(IPC.writeDrawingSvg, (_event, id: string, svg: string) =>
    store.writeDrawingSvg(id, svg)
  )

  handle(
    IPC.writeNoteFile,
    // A `Uint8Array` on the way in whatever the renderer built it from: an
    // `ArrayBuffer` survives structured clone as one, and writing it as-is
    // would put the string "[object ArrayBuffer]" in the file.
    (_event, fileName: string, bytes: Uint8Array | ArrayBuffer) =>
      store.writeNoteFile(
        fileName,
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      )
  )

  handle(
    IPC.terminalCreate,
    async (_event, folderId: string, cols: number, rows: number) => {
      const cwd = await store.resolveFolderDir(folderId)
      // No command: the user's own login shell, which is the only thing a pty
      // is started for now. The agent CLIs used to be started here too, with
      // their flags built alongside — what runs one is the agent SDK in
      // `worktree-chat.ts`, which spawns its own process and needs no pty.
      return terminals.create({ cwd }, cols, rows)
    }
  )

  handle(IPC.terminalWrite, (_event, terminalId: string, data: string) =>
    terminals.write(terminalId, data)
  )

  handle(
    IPC.terminalResize,
    (_event, terminalId: string, cols: number, rows: number) =>
      terminals.resize(terminalId, cols, rows)
  )

  handle(IPC.terminalKill, (_event, terminalId: string) =>
    terminals.kill(terminalId)
  )

  handle(IPC.terminalCwd, (_event, terminalId: string) =>
    terminals.cwd(terminalId)
  )

  handle(IPC.systemUsage, () => systemUsage(host.appShare))

  handle(IPC.checkForUpdate, () =>
    checkForUpdate(host.version, process.platform)
  )

  handle(IPC.installUpdate, async (_event, version: string) => {
    if (process.platform !== "darwin") {
      throw new Error(
        "install.sh is a macOS script — open the release page instead."
      )
    }
    const script = host.installerScript
    if (!script) {
      throw new Error(
        "This build updates from its checkout — pull and restart instead."
      )
    }
    // A version reaching a command line, from the renderer, off the network:
    // checked here rather than trusted, even though the only thing that ever
    // sends one is the answer `checkForUpdate` just gave.
    if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) {
      throw new Error(`Not a version: ${version}`)
    }
    // Downloaded here rather than by the script, so the wait has a percentage
    // on it: this is the long phase and the only one with a window left to draw
    // in. A failure throws, and the renderer is still there to show it.
    const dmg = await downloadUpdate({
      version,
      arch: process.arch,
      onProgress: (received, total) =>
        send(IPC.updateProgress, {
          stage: "downloading",
          version,
          received,
          total,
        }),
    })
    send(IPC.updateProgress, { stage: "installing", version })
    await startInstaller({
      script,
      version,
      appPath: APP_DIR,
      dmg,
    })
  })

  return {
    handlers,
    worktreeChats,
    terminals,
    tsServers,
    watchers,
    /** Shows the menu bar's icon if the setting has not switched it off.
     * Separate from building it because `registerIpc` runs at module scope and
     * a `Tray` constructed before `whenReady` throws. */
    startTray: () => applyTraySetting(),
    /** For the `note-file://` handler, which is not an IPC call and so cannot
     * reach the store any other way — see `serveNoteFiles`. */
    noteFilePath: (fileName: string) => store.noteFilePath(fileName),
  }
}

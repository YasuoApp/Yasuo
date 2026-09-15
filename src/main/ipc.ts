import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
  type BrowserWindow,
  type OpenDialogOptions,
} from "electron"

import {
  CHAT_NOTIFICATIONS_KEY,
  CHAT_TRAY_KEY,
  IPC,
  MCP_DISABLED_TOOLS_KEY,
  type BoardCard,
  type BoardColumn,
  type ChatPlace,
  type ChatSeed,
  type ClaudeProfile,
  type FileDiff,
  type FileIndexEntry,
  type ReviewThread,
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
import {
  changes,
  commit,
  currentBranch,
  discard,
  discardAll,
  fileAtHead,
  fileDiff,
  stage,
  unstage,
  workingTree,
} from "./git"
import { ChatNotices, noticeText, type ChatNotice } from "./notify"
import { installedMcpServers, removeMcpServer } from "./mcp-servers"
import { ProcessManager } from "./process"
import { transcriptOf, type LearningProposal } from "../shared/learnings"
import { saveLearning } from "./learnings"
import { distillLearnings, draftCommitMessage } from "./one-turn-agent"
import { expandHome, quote } from "./shell-env"
import { systemUsage } from "./system-usage"
import { Store } from "./store"
import { TerminalManager } from "./terminal"
import { ChatTray } from "./tray"
import { TsServers } from "./tsserver"
import { checkForUpdate, downloadUpdate, startInstaller } from "./updater"
import { DirectoryWatchers } from "./watch"

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

/**
 * Where `install.sh` puts the app, and so the bundle the updater reopens.
 *
 * Deliberately not this process's own `app.getPath("exe")`: the script installs
 * into `/Applications` whatever directory the running copy was launched from,
 * so reopening where *this* one lives could open the build that was just
 * replaced — or, from a dev run, an Electron binary in `node_modules`.
 */
const APP_DIR = "/Applications/Yasuo.app"

/** The installer, shipped in the bundle (`extraResources`) rather than fetched:
 * a button that runs a script downloaded at the moment it is pressed is a
 * different thing to agree to than one that runs the app's own. */
function installerScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "install.sh")
    : path.join(app.getAppPath(), "install.sh")
}

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
 */
async function clipboardImagePath(): Promise<string | null> {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null

  const file = path.join(tmpdir(), `yasuo-paste-${Date.now()}.png`)
  await writeFile(file, image.toPNG())
  return file
}

/**
 * Wires every renderer-callable method onto `ipcMain`.
 *
 * Handlers are registered once for the whole app rather than per window, and
 * every push event goes to the **studio** window — the one `getWindow` answers
 * with, and now the only one there is. It was not always: the Database and API
 * panels each had a window of their own, which was affordable precisely because
 * neither was ever *pushed* anything. Both panels are gone; see
 * `docs/design.md` § Database and API, removed.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): {
  processes: ProcessManager
  /** Exposed so a turn in flight can be killed on quit. */
  worktreeChats: WorktreeChats
  terminals: TerminalManager
  tsServers: TsServers
  watchers: DirectoryWatchers
  /** Exposed so the icon leaves the menu bar with the app rather than after
   * it. */
  tray: ChatTray
  startTray: () => Promise<void>
  noteFilePath: (fileName: string) => string
} {
  const store = new Store()

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    // The window is gone during shutdown; its last output has nowhere to go.
    if (!window || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }

  const processes = new ProcessManager({
    output: (event) => send(IPC.processOutput, event),
    exit: (event) => send(IPC.processExit, event),
  })

  const terminals = new TerminalManager({
    data: (event) => send(IPC.terminalData, event),
    exit: (event) => send(IPC.terminalExit, event),
  })

  /**
   * Settings › MCP's switched-off tools.
   *
   * A malformed or absent setting reads as "nothing switched off" rather than
   * throwing: this decides what a turn may call, and a parse error is not a
   * reason to refuse every MCP tool the user has — nor to refuse none silently,
   * which is why it is logged.
   *
   * Hoisted out of the source object below because the one-turn agent needs the
   * same list (`one-turn-agent.ts`): a tool the workspace turned off has no
   * business being in that model's list either.
   */
  const disabledTools = async (): Promise<string[]> => {
    const raw = await store.getSetting(MCP_DISABLED_TOOLS_KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : []
    } catch (error) {
      console.error(`Could not read ${MCP_DISABLED_TOOLS_KEY}`, error)
      return []
    }
  }

  /**
   * A picked `profileId` as a `CLAUDE_CONFIG_DIR`, for a one-turn agent.
   *
   * The same resolve `worktree-chat.ts` does at send time (`profileConfigDir`
   * there), asked here instead because a drafted message and a distilled chat
   * have no chat and no `WorktreeChats` record to resolve it on. Looked up by id
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
   * because a helper turn is a turn nobody asked for. `draftCommitMessage` and
   * `distillLearnings` below are the turns beside these, and neither is one of
   * those: each is a button pressed by the person who reads its answer. See the
   * top of `one-turn-agent.ts`.
   */
  const worktreeChats = new WorktreeChats(
    {
      // Null rather than a throw for a folder that has left the workspace: the
      // caller turns "nowhere to run" into a line in the chat, and one path
      // through that is easier to be sure of than two.
      folderDir: (folderId) =>
        store.resolveFolderDir(folderId).catch(() => null),
      // Asked per turn rather than held — Settings can add, rename or delete a
      // profile between two messages in the same chat. The same is true of
      // `disabledTools`, which is why both are functions rather than lists.
      claudeProfiles: () => store.listClaudeProfiles(),
      disabledTools,
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
   * See `tray.ts` for what it is for. It is created here rather than in
   * `main.ts` because this is where the events are, but it cannot be *shown*
   * until the app is ready — a `Tray` before then throws — which is what
   * `startTray` below is for.
   */
  const tray = new ChatTray({
    reveal: (chatId) => revealChat(chatId),
    show: () => showWindow(),
  })

  /** Brings the studio up: from the dock, from behind another app, or from
   * minimised, which are three different states and only the last has a name. */
  const showWindow = (): BrowserWindow | null => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return null
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return window
  }

  /** The studio, scrolled to one chat. Shared by the notification's click and
   * the tray's menu, which are the same errand arriving two ways. */
  const revealChat = (chatId: string): void => {
    showWindow()?.webContents.send(IPC.revealWorktreeChat, chatId)
  }

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
    if (!tray.shown) return
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
    if (!Notification.isSupported()) return
    // Off by default is the wrong default for the one feature that says "your
    // agent finished"; an unset key reads as on.
    if ((await store.getSetting(CHAT_NOTIFICATIONS_KEY)) === "off") return

    const window = getWindow()
    if (window && !window.isDestroyed() && window.isFocused()) return

    const chats = await worktreeChats.list()
    const chat = chats.find((entry) => entry.id === notice.chatId)
    // A chat with no row is one the `+` opened and nobody has spoken into, so
    // there is nothing to call it and nothing to call somebody back to.
    if (!chat) return

    const text = noticeText(notice, chat.title)
    const banner = new Notification({ title: text.title, body: text.body })
    // Clicking it is the way back to the chat it is about — a notification that
    // only tells you something happened leaves you hunting for the row.
    banner.on("click", () => revealChat(notice.chatId))
    banner.show()
  }

  // Asked of the user's own `claude` and held for the run — see
  // `agent-models.ts`. Not a handler that touches any of the managers above,
  // which is why it takes no argument and keeps no state here.
  ipcMain.handle(IPC.agentModels, () => agentModels())

  /*
   * The slash commands that `claude` has, asked in a project's directory — see
   * `agent-commands.ts`. The directory is resolved here for the reason every
   * other `folderId` call resolves it here: a project is an id in the manifest,
   * and the path behind it is the store's to say.
   */
  ipcMain.handle(IPC.agentCommands, async (_event, folderId: unknown) =>
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
  ipcMain.handle(IPC.installedMcpServers, async (_event, folderId: unknown) =>
    installedMcpServers(await folderDirOf(folderId))
  )

  // The CLI's own `mcp remove`, in the same directory the listing was asked in —
  // a `project`-scope server is in that repository's file and nowhere else. The
  // renderer confirms first and re-asks for the listing afterwards; this only
  // does it, and lets the CLI's own error through.
  ipcMain.handle(
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

  ipcMain.handle(IPC.listClaudeProfiles, () => store.listClaudeProfiles())

  ipcMain.handle(IPC.saveClaudeProfiles, (_event, profiles: ClaudeProfile[]) =>
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

  ipcMain.handle(IPC.claudeAccount, (_event, configDir: string) =>
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
  ipcMain.handle(
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
          cwd: app.getPath("home"),
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

  ipcMain.handle(IPC.listWorktreeChats, () => worktreeChats.list())

  ipcMain.handle(
    IPC.createWorktreeChat,
    (_event, place: ChatPlace, seed?: ChatSeed) =>
      worktreeChats.create(place, seed)
  )

  ipcMain.handle(IPC.readWorktreeChat, (_event, id: string) =>
    worktreeChats.read(id)
  )

  ipcMain.handle(IPC.chatDigests, () => worktreeChats.digests())

  ipcMain.handle(IPC.deleteWorktreeChat, (_event, id: string) => {
    // Before the delete rather than after: a chat killed mid-turn emits no
    // `busy: false`, so the watcher would keep it as working for the rest of
    // the run and swallow the first quiet of whatever reused the id.
    notices.forget(id)
    // The deleted chat may have been the one the strip was counting.
    void refreshTray()
    return worktreeChats.delete(id)
  })

  ipcMain.handle(IPC.clearWorktreeChat, (_event, id: string) =>
    worktreeChats.clear(id)
  )

  ipcMain.handle(IPC.renameWorktreeChat, (_event, id: string, title: string) =>
    worktreeChats.rename(id, title)
  )

  ipcMain.handle(
    IPC.setWorktreeChatOptions,
    (_event, id: string, options: WorktreeChatOptions) =>
      worktreeChats.setOptions(id, options)
  )

  ipcMain.handle(
    IPC.answerWorktreeChatAsk,
    (_event, askId: string, answer: WorktreeChatAnswer) => {
      worktreeChats.answer(askId, answer)
    }
  )

  ipcMain.handle(IPC.sendWorktreeChat, (_event, id: string, prompt: string) =>
    worktreeChats.send(id, prompt)
  )

  ipcMain.handle(IPC.stopWorktreeChat, (_event, id: string) => {
    worktreeChats.stop(id)
  })

  ipcMain.handle(IPC.getWorkspace, () => store.getWorkspace())

  ipcMain.handle(IPC.pickDirectory, async () => {
    const options: OpenDialogOptions = {
      title: "Add a folder",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Add",
    }

    // Parented to the window when there is one, so the picker is modal to the
    // studio rather than a sheet the user can lose behind it.
    const window = getWindow()
    const result = await (window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options))

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.pickImages, async () => {
    const options: OpenDialogOptions = {
      title: "Attach images",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
        },
      ],
    }

    const window = getWindow()
    const result = await (window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options))

    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.pickFiles, async (_event, directory?: string) => {
    const options: OpenDialogOptions = {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      // Where it opens, not what it may return: the paths come back from the
      // user's own click, and reading one is still an ordinary `files:*` call
      // through `insideAny`.
      ...(directory ? { defaultPath: expandHome(directory) } : {}),
    }

    const window = getWindow()
    const result = await (window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options))

    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.readImageDataUrl, (_event, filePath: string) =>
    imageDataUrl(filePath)
  )

  ipcMain.handle(IPC.clipboardImagePath, () => clipboardImagePath())

  ipcMain.handle(
    IPC.addFolder,
    (_event, input: { path: string; name: string }) =>
      store.addFolder({ ...input, path: expandHome(input.path) })
  )

  ipcMain.handle(IPC.renameFolder, (_event, id: string, name: string) =>
    store.renameFolder(id, name)
  )

  ipcMain.handle(IPC.removeFolder, (_event, id: string) =>
    store.removeFolder(id)
  )

  ipcMain.handle(IPC.gitBranch, async (_event, folderId: string) =>
    currentBranch(await store.resolveFolderDir(folderId))
  )

  ipcMain.handle(IPC.gitStatus, async (_event, folderId: string) =>
    workingTree(await store.resolveFolderDir(folderId))
  )

  ipcMain.handle(IPC.gitChanges, async (_event, folderId: string) =>
    changes(await store.resolveFolderDir(folderId))
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
  ipcMain.handle(
    IPC.gitStage,
    async (_event, folderId: string, paths: string[]) =>
      stage(
        await store.resolveFolderDir(folderId),
        await Promise.all(paths.map(inWorkspace))
      )
  )

  ipcMain.handle(
    IPC.gitUnstage,
    async (_event, folderId: string, paths: string[]) =>
      unstage(
        await store.resolveFolderDir(folderId),
        await Promise.all(paths.map(inWorkspace))
      )
  )

  ipcMain.handle(
    IPC.gitDiscard,
    async (_event, folderId: string, paths: string[]) => {
      const trash = await discard(
        await store.resolveFolderDir(folderId),
        await Promise.all(paths.map(inWorkspace))
      )
      await trashAll(trash)
    }
  )

  ipcMain.handle(IPC.gitDiscardAll, async (_event, folderId: string) => {
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
  ipcMain.handle(
    IPC.gitCommit,
    async (_event, folderId: string, message: string) =>
      commit(await store.resolveFolderDir(folderId), message)
  )

  /*
   * A commit message drafted from the staged diff by the read-only `claude`.
   *
   * The same three settings the distilling turn takes, resolved the same way —
   * it is the same second CLI, billed to the same profile. Answers rather than
   * throws, like the other call into `one-turn-agent.ts`: a draft that did
   * not arrive leaves the box exactly as it was, which is a message somebody
   * types themselves.
   */
  ipcMain.handle(
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
        disabledTools: await disabledTools(),
      })
  )

  /**
   * The new files a discard could not restore, moved to the trash.
   *
   * One at a time and each failure swallowed: `shell.trashItem` refuses on a
   * volume with no trash, and a discard that restored eleven files and then
   * threw on the twelfth would leave the list saying nothing about the ten it
   * did. The row that is still there afterwards is the report.
   */
  async function trashAll(paths: string[]): Promise<void> {
    for (const target of paths) {
      await shell.trashItem(target).catch((error: unknown) => {
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
  ipcMain.handle(
    IPC.fileDiff,
    async (_event, filePath: string): Promise<FileDiff> => {
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
    }
  )

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

  ipcMain.handle(IPC.listDirectory, async (_event, dirPath: string) =>
    files.listDirectory(await inWorkspace(dirPath))
  )

  ipcMain.handle(IPC.readTextFile, async (_event, filePath: string) =>
    files.readTextFile(await inWorkspace(filePath))
  )

  ipcMain.handle(
    IPC.writeTextFile,
    async (_event, filePath: string, text: string) =>
      files.writeTextFile(await inWorkspace(filePath), text)
  )

  ipcMain.handle(IPC.createFile, async (_event, dir: string, name: string) =>
    files.createFile(await inWorkspace(dir), name)
  )

  ipcMain.handle(
    IPC.createDirectory,
    async (_event, dir: string, name: string) =>
      files.createDirectory(await inWorkspace(dir), name)
  )

  ipcMain.handle(IPC.renamePath, async (_event, target: string, name: string) =>
    files.renamePath(await inWorkspace(target), name)
  )

  ipcMain.handle(IPC.trashPath, async (_event, target: string) => {
    // The OS trash rather than `unlink`: this is somebody's source file, the
    // studio has no undo of its own, and every desktop already has one.
    await shell.trashItem(await inWorkspace(target))
  })

  ipcMain.handle(IPC.revealPath, async (_event, target: string) => {
    shell.showItemInFolder(await inWorkspace(target))
  })

  ipcMain.handle(IPC.readImageFile, async (_event, filePath: string) =>
    // The same reader the composer's attachments use — including its size
    // ceiling, which is what keeps a 40MP photograph from being turned into a
    // base64 string and posted across the bridge.
    imageDataUrl(await inWorkspace(filePath))
  )

  ipcMain.handle(
    IPC.readImageRelative,
    async (_event, dir: string, relative: string) =>
      // The markdown preview's local pictures: `./logo.png` resolved against
      // the document's own directory — the renderer never joins paths — and
      // read under the same ceiling and the same folders' gate as any other
      // file the studio shows.
      imageDataUrl(await inWorkspace(path.resolve(dir, relative)))
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

  ipcMain.handle(IPC.tsOpen, async (_event, filePath: string, text: string) =>
    tsServers.open(await inWorkspace(filePath), text)
  )

  ipcMain.handle(IPC.tsChange, async (_event, filePath: string, text: string) =>
    tsServers.change(await inWorkspace(filePath), text)
  )

  ipcMain.handle(IPC.tsClose, async (_event, filePath: string) =>
    tsServers.close(await inWorkspace(filePath))
  )

  ipcMain.handle(
    IPC.tsHover,
    async (_event, filePath: string, line: number, column: number) =>
      tsServers.hover(await inWorkspace(filePath), line, column)
  )

  ipcMain.handle(
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
  const watchers = new DirectoryWatchers((dir) =>
    send(IPC.directoryChanged, { dir })
  )

  ipcMain.handle(IPC.watchDirectories, async (_event, dirs: string[]) => {
    const roots = (await fileRoots()).map((root) => root.path)
    watchers.set([
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

  ipcMain.handle(IPC.listWorkspaceFiles, async () => {
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

  ipcMain.handle(IPC.getSetting, (_event, key: string) => store.getSetting(key))

  ipcMain.handle(IPC.setSetting, async (_event, key: string, value: string) => {
    await store.setSetting(key, value)
    // The one setting with something of this process' own hanging off it: the
    // switch has to put the icon in the menu bar or take it out there and then,
    // since nothing else here re-reads it.
    if (key === CHAT_TRAY_KEY) await applyTraySetting()
  })

  ipcMain.handle(
    IPC.startProcess,
    async (_event, folderId: string, command: string, args: string[]) =>
      processes.start(await store.resolveFolderDir(folderId), command, args)
  )

  ipcMain.handle(IPC.stopProcess, (_event, processId: string) => {
    processes.stop(processId)
  })

  /**
   * What one chat taught, distilled by the same read-only `claude` the drafted
   * commit message runs on. The transcript is read here and handed over as text: a chat's
   * file lives under `~/.yasuo`, which the turn — running in the project's own
   * directory — has no business reaching into. `model`, `effort` and
   * `profileId` are the draft's three, resolved the same way.
   */
  ipcMain.handle(
    IPC.distillLearnings,
    async (
      _event,
      chatId: string,
      folderId: string,
      model: string | null,
      effort: string | null,
      profileId: string | null
    ) =>
      distillLearnings({
        cwd: await store.resolveFolderDir(folderId),
        transcript: transcriptOf(await worktreeChats.read(chatId)),
        model,
        effort,
        configDir: await configDirOf(profileId),
        disabledTools: await disabledTools(),
      })
  )

  /** One approved proposal written into the project — see `main/learnings.ts`.
   * The folder id is resolved here for the reason every write is: a path
   * built in main is a path gated in main. */
  ipcMain.handle(
    IPC.saveLearning,
    async (_event, folderId: string, proposal: LearningProposal) =>
      saveLearning(await store.resolveFolderDir(folderId), proposal)
  )

  ipcMain.handle(IPC.listReviewThreads, () => store.listReviewThreads())

  ipcMain.handle(IPC.saveReviewThreads, (_event, threads: ReviewThread[]) =>
    store.saveReviewThreads(threads)
  )

  ipcMain.handle(IPC.listBoardCards, () => store.listBoardCards())

  ipcMain.handle(IPC.saveBoardCards, (_event, cards: BoardCard[]) =>
    store.saveBoardCards(cards)
  )

  ipcMain.handle(IPC.listBoardColumns, () => store.listBoardColumns())

  ipcMain.handle(IPC.saveBoardColumns, (_event, columns: BoardColumn[]) =>
    store.saveBoardColumns(columns)
  )

  ipcMain.handle(IPC.readDrawing, (_event, id: string) => store.readDrawing(id))

  ipcMain.handle(IPC.writeDrawing, (_event, id: string, scene: string) =>
    store.writeDrawing(id, scene)
  )

  ipcMain.handle(IPC.writeDrawingSvg, (_event, id: string, svg: string) =>
    store.writeDrawingSvg(id, svg)
  )

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
    IPC.terminalWrite,
    (_event, terminalId: string, data: string) =>
      terminals.write(terminalId, data)
  )

  ipcMain.handle(
    IPC.terminalResize,
    (_event, terminalId: string, cols: number, rows: number) =>
      terminals.resize(terminalId, cols, rows)
  )

  ipcMain.handle(IPC.terminalKill, (_event, terminalId: string) =>
    terminals.kill(terminalId)
  )

  ipcMain.handle(IPC.systemUsage, () => systemUsage())

  ipcMain.handle(IPC.checkForUpdate, () =>
    checkForUpdate(app.getVersion(), process.platform)
  )

  ipcMain.handle(IPC.installUpdate, async (_event, version: string) => {
    if (process.platform !== "darwin") {
      throw new Error(
        "install.sh is a macOS script — open the release page instead."
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
      script: installerScript(),
      version,
      appPath: APP_DIR,
      dmg,
    })
  })

  return {
    processes,
    worktreeChats,
    terminals,
    tsServers,
    watchers,
    tray,
    /** Shows the menu bar's icon if the setting has not switched it off.
     * Separate from building it because `registerIpc` runs at module scope and
     * a `Tray` constructed before `whenReady` throws. */
    startTray: () => applyTraySetting(),
    /** For the `note-file://` handler, which is not an IPC call and so cannot
     * reach the store any other way — see `serveNoteFiles`. */
    noteFilePath: (fileName: string) => store.noteFilePath(fileName),
  }
}

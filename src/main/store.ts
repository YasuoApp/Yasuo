import { randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import type {
  AssistantMessage,
  BoardCard,
  BoardColumn,
  ReviewThread,
  ClaudeProfile,
  WorktreeChat,
  WorkspaceFolder,
  WorkspaceRecord,
} from "../shared/api"
import { withConfigDirs } from "./claude-profiles"
import { dataDir } from "./data-dir"

/**
 * The id of the workspace every install starts with.
 *
 * A constant rather than a generated id because there is exactly one until
 * sign-in exists: a record whose id nothing can predict would mean reading the
 * manifest to answer "which workspace", for a question with one answer.
 */
export const DEFAULT_WORKSPACE_ID = "default"

/**
 * Where the workspace's own data lives, beside the manifest rather than inside
 * any of the folders it points at.
 *
 * That separation is the whole rule: a folder is somebody's repository, and the
 * studio writes nothing into it that the user did not ask for. A chat's lines,
 * a board's cards and a Claude profile's config directory are the studio's, so
 * they live here.
 *
 * A workspace that ran an older build still has `requests.json`,
 * `environments.json`, `folders.json`, `cookies.json` and a `db/` directory
 * under here from the Database and API panels. Nothing reads them and nothing
 * deletes them, for the reason `mail.json` outlived its own panel.
 */
export const WORKSPACE_DIR = "workspace"

/** The workspace's `CLAUDE_CONFIG_DIR` profiles — see `ClaudeProfile`. */
export const CLAUDE_PROFILES_FILE = "claude-profiles.json"

/**
 * And the directories those profiles point at, one per profile: the CLI's own
 * login, settings and history, written by `claude` and read by nobody here.
 *
 * Beside the list rather than at the top of `~/.yasuo`, because a profile is a
 * record **of the workspace** — the same reason its list is a workspace file.
 * A second workspace will have profiles of its own, and two of them named
 * `Personal` must not be one login.
 */
export const CLAUDE_PROFILES_DIR = "claude-profiles"

/**
 * The chats held in the workspace's projects — their listing; each chat's lines
 * are a file of its own, the split the notes have and for the same reason: a
 * turn rewrites one chat rather than all of them.
 *
 * The file is still called `worktree-chats.json`: chats lived in `git worktree`
 * checkouts once, and renaming the file would lose every chat already written.
 */
export const WORKTREE_CHATS_FILE = "worktree-chats.json"

/** Where each of those chats' lines live, one `<id>.json` per chat. */
export const WORKTREE_CHATS_DIR = "worktree-chats"

/**
 * Every project's board cards, in one file.
 *
 * Not split per project, unlike the chats' lines: a card is a title and a line,
 * so the whole workspace's boards are one small list, and one file is one read
 * at startup rather than one per folder. Its order is the order within each
 * column — see `BoardCard`.
 */
export const BOARD_FILE = "board.json"

/** The columns those cards are filed in, per project — renamed, recoloured and
 * reordered without a card changing, which is why they are not on one. */
export const BOARD_COLUMNS_FILE = "board-columns.json"

/**
 * The review's own threads, across every project.
 *
 * One file for the workspace rather than one per project, the way the board's
 * cards are: a thread carries the `rootId` it belongs to, and the pane reads the
 * lot once at boot to know a review exists in a file nobody has opened.
 *
 * This exists at all because a review stopped being a sitting — see
 * `docs/design.md` § Changes. What it holds is not only line numbers: the lines
 * themselves are in each thread, which is what lets a comment be put back where
 * it belongs after the file has moved under it.
 */
export const REVIEW_FILE = "review.json"

/**
 * Where drawings are kept, one `<id>.excalidraw` per drawing.
 *
 * Flat rather than filed under the document that holds one: the file is
 * Excalidraw's own format, a flat directory of them is something the editor's
 * own app can open, and the document keeps only the id, in a fenced block.
 *
 * `notes.json`, `note-folders.json` and `notes/` were beside these until the
 * Notes panel was deleted. Nothing here reads them any more and nothing deletes
 * them either — see `docs/design.md` § Notes, removed.
 */
export const DRAWINGS_DIR = "drawings"

/**
 * Where the pictures dropped into notes are kept, one file per upload.
 *
 * Flat and named by id rather than filed under the note that holds one: a
 * picture can be cut from one note and pasted into another, and a directory per
 * note would leave the file under a note that no longer mentions it. What owns a
 * file is the document that points at it — see `shared/note-files.ts`.
 */
export const NOTE_FILES_DIR = "note-files"

/**
 * A note file's name, checked before it becomes a filename.
 *
 * The same guard `ownId` is, and it has to be its own because this name carries
 * an extension: the renderer makes it out of a UUID and the type of the file
 * that was dropped, and the extension is the one part derived from something the
 * user's filesystem named. So it is spelled out — a UUID, a dot, and a short run
 * of letters and digits — and anything else is refused rather than sanitised.
 */
function noteFileName(name: string): string {
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(name)) {
    throw new Error(`Not a note file: ${name}`)
  }
  return name
}

/**
 * A renderer-generated id, checked before it becomes a filename.
 *
 * Notes and drawings are both created with `crypto.randomUUID()`, and anything
 * that is not that shape is refused — which is what keeps a `../` in an id from
 * naming a file outside the workspace. An id is not a name the user typed, and
 * it must not be able to become one.
 */
function ownId(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Not an id: ${id}`)
  return id
}

type Manifest = {
  workspace: WorkspaceRecord
  settings: Record<string, string>
  /**
   * The Database panel's records, carried through untouched.
   *
   * The panel is gone (`docs/design.md` § Database and API, removed) and
   * nothing here reads this any more — but a manifest is **rewritten whole** on
   * every settings change and every folder added, so dropping the key would
   * delete somebody's saved connections, encrypted passwords and all, the first
   * time they changed a preference. That is the difference between this and
   * `mail.json` or `tasks.json`, which survive by being files nobody opens.
   *
   * `unknown` on purpose: this is data to preserve, not data to understand.
   */
  databases?: unknown
}

function emptyWorkspace(): WorkspaceRecord {
  return { id: DEFAULT_WORKSPACE_ID, name: "Workspace", folders: [] }
}

/**
 * Everything the studio keeps on disk: `manifest.json` for the workspace, its
 * databases and its settings, and a `workspace/` directory beside it for the
 * panels' own files.
 *
 * The folders the workspace points at are *not* under here. They are the user's
 * own repositories, recorded by absolute path and read where they are, which is
 * why there is no per-folder directory of ours to go looking for.
 *
 * Writes are serialised through a promise chain because a manifest update is a
 * read-modify-write: two concurrent `saveFile` calls racing on it would lose
 * one of the two updates.
 */
export class Store {
  private readonly root = dataDir()
  private queue: Promise<unknown> = Promise.resolve()

  /** Serialises a task against every other task on this store. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    // Keep the chain alive: a rejected task must not poison later ones.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private get workspaceDir(): string {
    return path.join(this.root, WORKSPACE_DIR)
  }

  private get manifestPath(): string {
    return path.join(this.root, "manifest.json")
  }

  /** One of the workspace's folders, by id. */
  private async folderOf(id: string): Promise<WorkspaceFolder> {
    const { workspace } = await this.readManifest()
    const folder = workspace.folders.find((candidate) => candidate.id === id)
    if (!folder) throw new Error(`No such folder: ${id}`)
    return folder
  }

  private async readManifest(): Promise<Manifest> {
    let raw: string
    try {
      raw = await readFile(this.manifestPath, "utf8")
    } catch (error) {
      if (isNotFound(error)) {
        return { workspace: emptyWorkspace(), settings: {} }
      }
      throw error
    }

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("manifest.json is not an object")
    }
    const manifest = parsed as Partial<Manifest>
    const workspace = manifest.workspace
    // Never hand back a nullish collection: the renderer maps over these
    // directly, and `null.map` is a crash rather than an empty studio.
    return {
      workspace: {
        id: workspace?.id ?? DEFAULT_WORKSPACE_ID,
        name: workspace?.name ?? "Workspace",
        folders: workspace?.folders ?? [],
      },
      settings: manifest.settings ?? {},
      // Only when it is there, so a manifest written since keeps its shape
      // rather than growing a `"databases": undefined` back.
      ...(manifest.databases === undefined
        ? {}
        : { databases: manifest.databases }),
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    // The data directory is created here rather than in the constructor so
    // that merely constructing a Store needs no filesystem access.
    await mkdir(this.root, { recursive: true })
    await writeFile(
      this.manifestPath,
      JSON.stringify(manifest, null, 2),
      "utf8"
    )
  }

  /** The workspace and its folders. */
  getWorkspace(): Promise<WorkspaceRecord> {
    return this.enqueue(async () => (await this.readManifest()).workspace)
  }

  /**
   * Records an existing folder in the workspace, worked on where it is.
   *
   * Nothing is copied and nothing is written into it. The path is resolved
   * through symlinks first, so the duplicate check below sees what will
   * actually be opened.
   */
  addFolder(input: { path: string; name: string }): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      let resolved: string
      try {
        resolved = await realpath(input.path)
      } catch {
        throw new Error(`There is no folder at ${input.path}.`)
      }

      const stats = await stat(resolved)
      if (!stats.isDirectory()) {
        throw new Error(`${resolved} is a file, not a folder.`)
      }

      const manifest = await this.readManifest()
      const clash = manifest.workspace.folders.find(
        (folder) => path.resolve(folder.path) === resolved
      )
      if (clash) {
        throw new Error(`This folder is already open as “${clash.name}”.`)
      }

      manifest.workspace.folders.push({
        id: randomUUID(),
        name: input.name.trim() || path.basename(resolved),
        path: resolved,
        addedAt: new Date().toISOString(),
      })
      await this.writeManifest(manifest)
      return manifest.workspace
    })
  }

  renameFolder(id: string, name: string): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const manifest = await this.readManifest()
      const folder = manifest.workspace.folders.find(
        (candidate) => candidate.id === id
      )
      if (!folder) throw new Error(`No such folder: ${id}`)

      folder.name = name
      await this.writeManifest(manifest)
      return manifest.workspace
    })
  }

  /**
   * Drops a folder from the workspace.
   *
   * The directory itself is never touched — the studio only ever held a path to
   * it. Nothing else in the manifest is filed under a folder either, which is
   * the point of keeping databases and requests at the workspace level: closing
   * the frontend does not take the database both halves were using with it.
   */
  removeFolder(id: string): Promise<WorkspaceRecord> {
    return this.enqueue(async () => {
      const manifest = await this.readManifest()
      manifest.workspace.folders = manifest.workspace.folders.filter(
        (folder) => folder.id !== id
      )
      await this.writeManifest(manifest)
      return manifest.workspace
    })
  }

  /** A studio-wide setting, or `null` when unset. */
  getSetting(key: string): Promise<string | null> {
    return this.enqueue(async () => {
      const { settings } = await this.readManifest()
      return settings[key] ?? null
    })
  }

  setSetting(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      const manifest = await this.readManifest()
      manifest.settings[key] = value
      await this.writeManifest(manifest)
    })
  }

  /**
   * Reads one of the workspace's own JSON files. Missing or unreadable reads
   * as none — a panel that lost its file is empty, not broken.
   */
  private readList<T>(file: string): Promise<T[]> {
    return this.enqueue(async () => {
      let raw: string
      try {
        raw = await readFile(path.join(this.workspaceDir, file), "utf8")
      } catch (error) {
        if (isNotFound(error)) return []
        throw error
      }
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    })
  }

  /** Replaces one of those files wholesale — the renderer holds the list it is
   * editing, so a merge here would only be a second opinion about it. */
  private writeList<T>(file: string, items: T[], pretty = true): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.workspaceDir, { recursive: true })
      await writeFile(
        path.join(this.workspaceDir, file),
        pretty ? JSON.stringify(items, null, 2) : JSON.stringify(items),
        "utf8"
      )
    })
  }

  /**
   * The profiles, each with a directory of its own — see `withConfigDirs`.
   *
   * A row written before the path was the app's to choose has an empty field
   * and no field left to type into, so one is filled in here and the file
   * rewritten: a migration, run once, rather than a profile that can never be
   * signed in.
   */
  async listClaudeProfiles(): Promise<ClaudeProfile[]> {
    const stored = await this.readList<ClaudeProfile>(CLAUDE_PROFILES_FILE)
    const profiles = withConfigDirs(stored, this.claudeProfilesDir)
    if (profiles !== stored) {
      await this.writeList(CLAUDE_PROFILES_FILE, profiles)
    }
    return profiles
  }

  /** Answers with what was stored, since a profile arrives with nothing but a
   * name and leaves with a directory the caller has to draw. */
  async saveClaudeProfiles(
    profiles: ClaudeProfile[]
  ): Promise<ClaudeProfile[]> {
    const filled = withConfigDirs(profiles, this.claudeProfilesDir)
    await this.writeList(CLAUDE_PROFILES_FILE, filled)
    return filled
  }

  /** Where a profile's own `CLAUDE_CONFIG_DIR` goes. Not created here: the
   * login that first needs it makes it (`IPC.claudeLogin`), and a profile
   * nobody signed in should leave nothing behind. */
  private get claudeProfilesDir(): string {
    return path.join(this.workspaceDir, CLAUDE_PROFILES_DIR)
  }

  listWorktreeChats(): Promise<WorktreeChat[]> {
    return this.readList(WORKTREE_CHATS_FILE)
  }

  saveWorktreeChats(chats: WorktreeChat[]): Promise<void> {
    return this.writeList(WORKTREE_CHATS_FILE, chats)
  }

  /** Empty for a chat with nothing said in it, and for a half-written file: a
   * chat is a log, not a document, so a broken one is worth an empty pane
   * rather than an error in front of every other chat. */
  async readWorktreeChat(id: string): Promise<AssistantMessage[]> {
    const raw = await this.readOwnFile(this.worktreeChatPath(id))
    if (!raw.trim()) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as AssistantMessage[]) : []
    } catch {
      return []
    }
  }

  writeWorktreeChat(id: string, messages: AssistantMessage[]): Promise<void> {
    return this.writeOwnFile(
      this.worktreeChatPath(id),
      JSON.stringify(messages)
    )
  }

  deleteWorktreeChat(id: string): Promise<void> {
    return this.deleteOwnFiles([this.worktreeChatPath(id)])
  }

  private worktreeChatPath(id: string): string {
    return path.join(this.workspaceDir, WORKTREE_CHATS_DIR, `${ownId(id)}.json`)
  }

  listBoardCards(): Promise<BoardCard[]> {
    return this.readList(BOARD_FILE)
  }

  saveBoardCards(cards: BoardCard[]): Promise<void> {
    return this.writeList(BOARD_FILE, cards)
  }

  listReviewThreads(): Promise<ReviewThread[]> {
    return this.readList(REVIEW_FILE)
  }

  saveReviewThreads(threads: ReviewThread[]): Promise<void> {
    return this.writeList(REVIEW_FILE, threads)
  }

  listBoardColumns(): Promise<BoardColumn[]> {
    return this.readList(BOARD_COLUMNS_FILE)
  }

  saveBoardColumns(columns: BoardColumn[]): Promise<void> {
    return this.writeList(BOARD_COLUMNS_FILE, columns)
  }

  /** A drawing's scene, or "" for one that has never been saved. */
  readDrawing(id: string): Promise<string> {
    return this.readOwnFile(this.drawingPath(id))
  }

  writeDrawing(id: string, scene: string): Promise<void> {
    return this.writeOwnFile(this.drawingPath(id), scene)
  }

  /** The drawing as a picture, written beside the scene it is an export of. */
  writeDrawingSvg(id: string, svg: string): Promise<void> {
    return this.writeOwnFile(this.drawingSvgPath(id), svg)
  }

  /**
   * Where one of a note's files is, for the protocol handler that serves it.
   *
   * Public, and the only path this class hands out, because the handler is not
   * IPC: it answers Chromium's own request for an `img` src and so runs outside
   * everything in `ipc.ts`. It is a name being turned into a path, which is
   * exactly what `noteFileName` is there to refuse — so the check happens here
   * rather than at the one call site.
   */
  noteFilePath(fileName: string): string {
    return path.join(this.workspaceDir, NOTE_FILES_DIR, noteFileName(fileName))
  }

  /** One note file's bytes, or null for a name nothing was written under —
   * a note pointing at a file somebody removed from the workspace by hand. */
  readNoteFile(fileName: string): Promise<Buffer | null> {
    const file = this.noteFilePath(fileName)
    return this.enqueue(async () => {
      try {
        return await readFile(file)
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    })
  }

  writeNoteFile(fileName: string, bytes: Uint8Array): Promise<void> {
    const file = this.noteFilePath(fileName)
    return this.enqueue(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, bytes)
    })
  }

  /** One drawing's scene, in Excalidraw's own file format. */
  private drawingPath(id: string): string {
    return path.join(this.workspaceDir, DRAWINGS_DIR, `${ownId(id)}.excalidraw`)
  }

  /** The same drawing as a picture, beside its scene. Written by the renderer,
   * which is the only side with an Excalidraw to export from, and read by the
   * preview server, which has none — see `preview.ts`. */
  private drawingSvgPath(id: string): string {
    return path.join(this.workspaceDir, DRAWINGS_DIR, `${ownId(id)}.svg`)
  }

  /** One of the workspace's own per-record files, or "" when it does not
   * exist yet — which is every one of them until something is written. */
  private readOwnFile(file: string): Promise<string> {
    return this.enqueue(async () => {
      try {
        return await readFile(file, "utf8")
      } catch (error) {
        if (isNotFound(error)) return ""
        throw error
      }
    })
  }

  private writeOwnFile(file: string, contents: string): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, contents, "utf8")
    })
  }

  /** A file that was never written is not an error — a note deleted before
   * anything was typed into it has none. */
  private deleteOwnFiles(files: string[]): Promise<void> {
    return this.enqueue(async () => {
      await Promise.all(
        files.map(async (file) => {
          try {
            await rm(file)
          } catch (error) {
            if (!isNotFound(error)) throw error
          }
        })
      )
    })
  }

  /** Where a folder's commands and sessions run. */
  resolveFolderDir(folderId: string): Promise<string> {
    return this.enqueue(async () => (await this.folderOf(folderId)).path)
  }

  /**
   * Where this workspace's own files live, for the one caller that has to build
   * a path under it rather than ask for a named file: an agent's `git worktree`
   * checkout (`main/worktrees.ts`).
   *
   * Public where every other path here is private, and that is the exception it
   * looks like: a checkout is a **directory this app creates and then hands to
   * git**, so there is no read or write here to route it through. The gate that
   * matters is elsewhere — the folder it becomes goes through `addFolder`, and
   * everything read out of it afterwards through `insideAny`.
   */
  get workspaceFilesDir(): string {
    return this.workspaceDir
  }
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  return (error as { code?: string }).code ?? null
}

import { create } from "zustand"

import type { FileEntry, FileIndexEntry, GitFileState } from "@shared/api"
import { useStudio } from "../store"
import { useProjects } from "../projects"
import { fileRoots, rootOf } from "./roots"
import { isRememberedTabs, recall, remember } from "../tab-memory"
import { resetDoc } from "./documents"
import { isInside, movedPath, parentOf } from "./paths"
import { defaultViewer, type Viewer } from "./viewers"

/** Which files were open in the strip, and which was on screen. */
const OPEN_TABS_KEY = "files.tabs"

/**
 * A file as the pane holds it.
 *
 * `saved` is what is on disk as far as this app knows, and `text` is what the
 * editor has: the difference between them is the dirty dot, and there is no
 * third place recording it. Reading them apart is also what makes an undo back
 * to the original mark the tab clean again, the way an editor does.
 *
 * The two refusals and the failure are documents too, so the pane always has
 * something to draw for a tab that is open — the alternative was a tab whose
 * pane was blank while a read failed.
 */
export type FileDoc =
  | { kind: "loading" }
  | { kind: "text"; text: string; saved: string }
  | { kind: "binary" }
  | { kind: "too-large"; size: number }
  | { kind: "error"; message: string }

/**
 * A file being shown as a picture.
 *
 * Its own record rather than another `FileDoc` kind, because an SVG can be
 * both at once: switching an open SVG to the text editor and back must not
 * re-read either half, and one slot per path could only hold whichever was
 * asked for last.
 */
export type ImageDoc =
  | { kind: "loading" }
  | { kind: "image"; src: string }
  | { kind: "error"; message: string }

export function isDirty(doc: FileDoc | undefined): boolean {
  return doc?.kind === "text" && doc.text !== doc.saved
}

/**
 * Whether a file with a tab open is no longer on disk.
 *
 * Answered from the listing the tree already holds rather than by asking about
 * the file: the directory it was in is re-read whenever it changes, so a file
 * that has gone is one the listing no longer mentions. A directory nothing has
 * read says nothing either way, which is why "not deleted" is the answer for a
 * path whose folder has never been expanded — a tab must not be labelled gone
 * on the strength of never having been looked for.
 *
 * The other half of the answer is git's, which knows a tracked file has been
 * deleted even where the tree has not read the folder. The tab takes either.
 */
export function isMissing(
  state: { entries: Record<string, FileEntry[]> },
  filePath: string
): boolean {
  const listing = state.entries[parentOf(filePath)]
  return (
    listing !== undefined && !listing.some((entry) => entry.path === filePath)
  )
}

/**
 * Whether a tab is all that is left of its file.
 *
 * Two sources, and deliberately **not** either-or. Git knows a tracked file was
 * deleted. The tree's listing is the only thing that knows an *untracked* one
 * was, since git stops mentioning it the moment it is gone. But a listing can be
 * stale — it is re-read from a watcher, and Refresh exists precisely because
 * `fs.watch` is quiet on some filesystems — so a file git is currently calling
 * untracked, added or modified is a file that **exists**, whatever a listing read
 * before it was written still says. Only where git has nothing to say at all does
 * the listing get the last word.
 *
 * Written for a bug that shipped: a file an agent had just created was opened
 * from the Changes list, where git had it as `U`, and its tab said `deleted`.
 *
 * A function of its own rather than two lines in `tab-items.tsx` because it is
 * the whole of the reasoning and none of the drawing.
 */
export function isDeleted(
  git: GitFileState | null,
  state: { entries: Record<string, FileEntry[]> },
  filePath: string
): boolean {
  if (git === "deleted") return true
  if (git !== null) return false
  return isMissing(state, filePath)
}

/**
 * How a file was reached, which is what decides whether its tab is kept.
 *
 * A single click in the tree is somebody *looking* at a file — the common case,
 * and the one that used to leave twenty tabs behind after ten minutes of
 * reading. Everything else — a double click, the palette, a definition jumped
 * to, a file just created — is somebody opening one, and opens a tab of its own.
 */
export type OpenOptions = { preview?: boolean }

/**
 * Where a file lands in the strip, and whether its tab is the preview one.
 *
 * The rule is the editors' own: **one** preview tab, holding whatever was last
 * only looked at, and the next look takes its place rather than adding a tab
 * beside it. A file that already has a tab is left exactly as it is — a kept tab
 * stays kept and a preview stays a preview, so clicking around the tree cannot
 * quietly demote a file somebody is editing.
 *
 * `replaced` is the tab that has to be flushed and forgotten, and is handed back
 * rather than acted on here: this is the arithmetic, and writing a file is not.
 *
 * In place rather than appended, so the tab somebody is reading through stays
 * where their eye left it — the strip's own order is `tabOrder` on the studio
 * store, and it takes this slot as the position the panel gave the tab.
 */
export function opening(
  state: { openIds: string[]; previewId: string | null },
  filePath: string,
  preview: boolean
): { openIds: string[]; previewId: string | null; replaced: string | null } {
  const { openIds, previewId } = state
  if (openIds.includes(filePath)) return { openIds, previewId, replaced: null }

  if (!preview)
    return { openIds: [...openIds, filePath], previewId, replaced: null }

  const slot = previewId === null ? -1 : openIds.indexOf(previewId)
  if (slot === -1) {
    return {
      openIds: [...openIds, filePath],
      previewId: filePath,
      replaced: null,
    }
  }

  const next = [...openIds]
  next[slot] = filePath
  return { openIds: next, previewId: filePath, replaced: previewId }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type FilesState = {
  /**
   * Each directory that has been expanded, and what was in it when it was last
   * read.
   *
   * The tree is a cache of one `readdir` per open folder rather than a walk of
   * the workspace: a repository holds more files than anybody wants listed, and
   * the ones under a folded folder are ones nobody has asked about. Each of
   * these is watched for exactly as long as it is expanded (`syncDirs`, and
   * `main/watch.ts` for what that costs); Refresh remains the answer for a
   * filesystem whose watcher stays quiet, and for the palette's index.
   */
  entries: Record<string, FileEntry[]>
  /** Directories drawn open, whether or not their listing has arrived. */
  expanded: string[]
  /** Directories with a read in flight, for the spinner on the row. */
  loading: string[]
  /** Why a directory could not be read — a permissions error, or a folder that
   * has been moved out from under the workspace. */
  errors: Record<string, string>

  docs: Record<string, FileDoc>
  /** Images read for the pane, keyed by path — see `ImageDoc`. */
  images: Record<string, ImageDoc>
  /**
   * How a file is being shown, where that is not what its extension implies.
   *
   * Only the paths somebody has actually changed: everything else follows
   * `defaultViewer`, so a workspace nobody has right-clicked in carries no
   * state at all. Kept for the run rather than written to disk — which viewer
   * an SVG was last opened with is a smaller thing than a tab, and the strip
   * already restores those.
   */
  views: Record<string, Viewer>
  /** Files with a tab open, oldest first. Ids here are absolute paths. */
  openIds: string[]
  selectedId: string | null
  /**
   * The one tab holding a file somebody has only looked at, or null.
   *
   * Drawn in italics and replaced by the next single click, which is the
   * editors' own preview tab: reading through a repository is what fills a strip
   * with tabs nobody asked for, and the fix everyone already knows is that a
   * look is not an open. `keep` is what promotes one, and typing in it does the
   * same — an edit is the point at which somebody plainly means to stay.
   *
   * Not remembered across a launch, unlike `openIds` and the selection: a tab
   * that survived a restart is one the workspace kept, and coming back to find
   * it evicted by the first click in the tree would be the memory doing less
   * than nothing.
   */
  previewId: string | null

  /**
   * Every file in the workspace, for the search palette — empty until it is
   * asked for.
   *
   * The one thing this store holds that is not about a directory somebody
   * opened. `⌘P` has to answer for files no folder in the tree has been
   * expanded to, and nothing else here can: the tree is what has been looked
   * at, and this is what is there.
   */
  index: FileIndexEntry[]
  indexing: boolean

  /**
   * Walks the workspace for the palette, once per run.
   *
   * `force` re-walks: the Explorer's Refresh uses it, since a file created in
   * a terminal since the last walk is exactly the file somebody then cannot
   * find in the palette.
   */
  loadIndex: (force?: boolean) => Promise<void>

  /** Opens every folder above `filePath`, so a file reached from the palette
   * is also where the tree says it is. */
  reveal: (filePath: string) => Promise<void>

  /** Reads a directory and keeps it. Safe to call for one already read — it is
   * also the refresh. */
  read: (dir: string) => Promise<void>
  toggle: (dir: string) => void
  /** Re-reads every directory currently open, and every open file that has no
   * unsaved edits. */
  refresh: () => Promise<void>
  /**
   * The same re-read, for directories a watcher has reported — see
   * `lib/files/watch.ts`, which is what feeds this.
   *
   * One `readdir` of the directory, and a re-read of the files in it that are
   * on screen. Nothing above or below it: the event says which folder changed,
   * and the folders around it did not.
   */
  syncDirs: (dirs: string[]) => Promise<void>
  /**
   * The same re-read again, for named paths — what a `claude` session's own
   * transcript says it wrote (`lib/terminal/touched.ts`).
   *
   * Kept alongside the watchers rather than replaced by them: the transcript
   * names the file the moment the tool call is recorded, without the watcher's
   * debounce, and it is the one path that still works on a filesystem
   * `fs.watch` says nothing about — a folder mounted into a container, or over
   * a network.
   */
  syncPaths: (paths: string[]) => Promise<void>
  /**
   * One file, re-read on demand — the same bargain as the two above, an unsaved
   * edit included.
   *
   * For a pane showing a file that has **no tab**: the `Changes` diff reads a
   * file through this store without putting it in `openIds`, which is exactly
   * what the two re-reads above follow, so nothing was re-reading it. See the
   * effect in `FilePane` for which signal calls this.
   */
  reload: (filePath: string) => Promise<void>
  collapseAll: () => void

  /** Opens a file into the pane, reading it the first time. `preview` is a
   * single click in the tree — see `opening`. */
  open: (filePath: string, options?: OpenOptions) => Promise<void>
  /** Shows an open file another way — the tree's "open with". Reads whichever
   * half of it has not been read yet. */
  setView: (filePath: string, viewer: Viewer) => Promise<void>
  /**
   * Reads what a viewer needs, if it has not been read already.
   *
   * For the pane, which is the one thing that knows what it is about to draw.
   * A tab can reach the screen without having gone through `open` — restored
   * from the last run, or picked up by `close` as the neighbour of the tab that
   * went — and before this, such a tab drew "Reading…" until something else
   * happened to load it.
   */
  ensureLoaded: (filePath: string, viewer: Viewer) => Promise<void>
  select: (filePath: string, options?: OpenOptions) => void
  /**
   * Keeps the preview tab: a double click, or the first keystroke in it.
   *
   * By path rather than "whatever is previewing", so a double click on a row
   * that is not the preview is a no-op rather than a promotion of some other
   * file's tab.
   */
  keep: (filePath: string) => void
  close: (filePath: string) => void
  closeOthers: (filePath: string) => void
  closeAll: () => void
  reorder: (paths: string[]) => void

  /** What the editor typed. Not written until `save`. */
  setText: (filePath: string, text: string) => void
  /** Writes one file back, resolving to why it could not be written, or null. */
  save: (filePath: string) => Promise<string | null>

  /**
   * The row being renamed in place, by path, or null.
   *
   * Here rather than in the tree's own `useState` because the row that draws the
   * field is at the bottom of a recursion, and the menu that starts the rename is
   * at the top: threading it down would give `Directory` a prop it does nothing
   * with, and every row in every open directory a re-render each time a rename
   * starts. From the store, the two rows that change are the two that re-render.
   */
  renaming: string | null
  beginRename: (target: string) => void
  endRename: () => void

  create: (dir: string, name: string) => Promise<string>
  createFolder: (dir: string, name: string) => Promise<string>
  rename: (target: string, name: string) => Promise<string>
  /** To the system trash, and closes whatever tabs it took with it. */
  trash: (target: string) => Promise<void>

  /** Restores the strip. Idempotent: Strict Mode mounts twice. */
  restore: () => Promise<void>
}

export const useFiles = create<FilesState>((set, get) => {
  let restorePromise: Promise<void> | null = null
  /** The walk in flight, so two panels asking at once share one. */
  let indexPromise: Promise<void> | null = null
  /**
   * The folder list that walk was over, so a folder added or removed is told
   * apart from any other change to the studio.
   */
  let indexedRoots: string | null = null

  function rememberTabs() {
    const { openIds, selectedId } = get()
    remember(OPEN_TABS_KEY, { openIds, selectedId })
  }

  /** Adds or replaces one document. */
  function setDoc(filePath: string, doc: FileDoc) {
    set((state) => ({ docs: { ...state.docs, [filePath]: doc } }))
  }

  function setImage(filePath: string, image: ImageDoc) {
    set((state) => ({ images: { ...state.images, [filePath]: image } }))
  }

  /**
   * Reads whichever half a viewer needs, once.
   *
   * Both halves are kept: an SVG switched to the text editor and back is not
   * re-read, and neither is a picture whose tab has been away and come back.
   */
  async function load(filePath: string, viewer: Viewer): Promise<void> {
    if (viewer === "image") {
      if (get().images[filePath] !== undefined) return
      setImage(filePath, { kind: "loading" })
      setImage(filePath, await readImage(filePath))
      return
    }

    if (get().docs[filePath] !== undefined) return
    setDoc(filePath, { kind: "loading" })
    setDoc(filePath, await readDoc(filePath))
  }

  /**
   * Re-reads one open file from disk, in whichever halves have been read.
   *
   * The one place the three re-reads agree — Refresh, a watcher's event, and a
   * session's own writes — because they make the same bargain: an unsaved edit
   * is what somebody typed, and neither a button nor a write on disk gets to
   * discard it. The dirty dot is what says the two have diverged.
   *
   * Checked twice, before the read and after it, because the read is awaited: a
   * keystroke landing while it was in flight would otherwise be replaced by the
   * disk's older version of the same file.
   */
  async function reloadOpen(filePath: string): Promise<void> {
    if (isDirty(get().docs[filePath])) return

    if (get().docs[filePath] !== undefined) {
      const doc = await readDoc(filePath)
      if (!isDirty(get().docs[filePath])) {
        setDoc(filePath, doc)
        // And into the buffer the editors are actually drawing, which is the
        // registry's rather than this store's — see `resetDoc`.
        if (doc.kind === "text") resetDoc(filePath, doc.text)
      }
    }

    // The picture too: an icon regenerated by a build is the case this is
    // actually for. Dropped rather than replaced, since `load` is what reads
    // one and it keeps whatever it already has.
    if (get().images[filePath] !== undefined) {
      set((state) => ({
        images: Object.fromEntries(
          Object.entries(state.images).filter(([entry]) => entry !== filePath)
        ),
      }))
      await load(filePath, "image")
    }
  }

  /**
   * Writes a file if it has unsaved edits, and does nothing otherwise.
   *
   * Closing a tab flushes rather than prompting. The reason is that the edit
   * was deliberate, and a
   * three-button "save / discard / cancel" is a dialog in the way of the common
   * case — but the file here is somebody's source, so ⌘S is still the way it is
   * normally written and the dot says when it has not been.
   */
  function flush(filePath: string) {
    if (!isDirty(get().docs[filePath])) return
    void get().save(filePath)
  }

  /** Forgets everything read for paths that are no longer in the workspace. */
  function prune(roots: string[]) {
    const inside = (target: string) =>
      roots.some((root) => isInside(root, target))

    const {
      entries,
      expanded,
      openIds,
      selectedId,
      previewId,
      docs,
      images,
      views,
    } = get()
    const keptOpen = openIds.filter(inside)
    if (
      keptOpen.length === openIds.length &&
      expanded.every(inside) &&
      Object.keys(entries).every(inside)
    ) {
      return
    }

    set({
      entries: Object.fromEntries(
        Object.entries(entries).filter(([dir]) => inside(dir))
      ),
      expanded: expanded.filter(inside),
      docs: Object.fromEntries(
        Object.entries(docs).filter(([filePath]) => inside(filePath))
      ),
      images: Object.fromEntries(
        Object.entries(images).filter(([filePath]) => inside(filePath))
      ),
      views: Object.fromEntries(
        Object.entries(views).filter(([filePath]) => inside(filePath))
      ),
      openIds: keptOpen,
      selectedId:
        selectedId && keptOpen.includes(selectedId)
          ? selectedId
          : (keptOpen[0] ?? null),
      previewId: previewId && keptOpen.includes(previewId) ? previewId : null,
    })
    rememberTabs()
  }

  // A folder dropped from the workspace takes its files' tabs with it: the
  // panel is not allowed to read there any more, so a tab onto it could only
  // fail.
  function followRoots() {
    // Not before the list has been read: there is a moment during `init` where
    // the studio is `loaded` and its folders have not arrived, and pruning
    // against an empty list there would close every tab this store had just
    // restored.
    if (!useStudio.getState().loaded) return

    const roots = fileRoots().map((root) => root.path)
    prune(roots)

    // The index is a walk of that same list, so adding a root does not make it
    // stale, it makes it wrong: `loadIndex` hands back the walk it already has,
    // and the palette would go on missing the new root's files until the app
    // was restarted. Dropped here, and re-walked straight away only if somebody
    // has opened the palette already — the same rule `refresh` keeps.
    const key = roots.join("\n")
    if (indexedRoots !== null && indexedRoots !== key) {
      indexPromise = null
      indexedRoots = null
      if (get().index.length > 0) void get().loadIndex(true)
    }
  }

  useStudio.subscribe(followRoots)

  return {
    entries: {},
    expanded: [],
    loading: [],
    errors: {},
    docs: {},
    images: {},
    views: {},

    openIds: [],
    selectedId: null,
    previewId: null,
    renaming: null,
    index: [],
    indexing: false,

    beginRename(target) {
      set({ renaming: target })
    },

    endRename() {
      set({ renaming: null })
    },

    loadIndex(force = false) {
      if (force) indexPromise = null
      indexPromise ??= (async () => {
        set({ indexing: true })
        indexedRoots = fileRoots()
          .map((root) => root.path)
          .join("\n")
        try {
          set({ index: await window.desktop.listWorkspaceFiles() })
        } catch (error) {
          // Nothing on screen: the palette still lists everything else, and a
          // walk that failed is a palette missing a group rather than a broken
          // one.
          console.error("Could not index the workspace's files", error)
          indexPromise = null
        } finally {
          set({ indexing: false })
        }
      })()
      return indexPromise
    },

    async reveal(filePath) {
      const owner = rootOf(filePath)
      if (owner === null) return
      const root = owner.path

      // From the file up to the root, then opened from the root down, so each
      // level is drawn under the one that holds it.
      const chain: string[] = []
      let dir = parentOf(filePath)
      while (isInside(root, dir)) {
        chain.unshift(dir)
        if (dir === root) break
        const above = parentOf(dir)
        // A path that is its own parent has nowhere left to go — the guard
        // that keeps a malformed path from spinning here forever.
        if (above === dir) break
        dir = above
      }

      // Explorer draws one project, so revealing a file from anywhere else
      // has to move that selection first — otherwise the chain would be opened
      // under a root the tree is not drawing. `⌘P` indexes every root, which is
      // what makes this reachable at all.
      useProjects.getState().setActive(owner.folderId)

      // Only the folders that were shut, and only their listings: revealing
      // runs on every tab click, and re-reading a chain that is already open
      // would be a `readdir` per level per click.
      const shut = chain.filter((entry) => !get().expanded.includes(entry))
      if (shut.length > 0)
        set((state) => ({ expanded: [...state.expanded, ...shut] }))

      for (const entry of chain) {
        if (get().entries[entry] === undefined) await get().read(entry)
      }
    },

    async read(dir) {
      set((state) => ({
        loading: state.loading.includes(dir)
          ? state.loading
          : [...state.loading, dir],
      }))

      try {
        const listing = await window.desktop.listDirectory(dir)
        set((state) => ({
          entries: { ...state.entries, [dir]: listing },
          errors: Object.fromEntries(
            Object.entries(state.errors).filter(([key]) => key !== dir)
          ),
        }))
      } catch (error) {
        set((state) => ({
          errors: { ...state.errors, [dir]: messageOf(error) },
        }))
      } finally {
        set((state) => ({
          loading: state.loading.filter((entry) => entry !== dir),
        }))
      }
    },

    toggle(dir) {
      const { expanded } = get()
      if (expanded.includes(dir)) {
        set({ expanded: expanded.filter((entry) => entry !== dir) })
        return
      }

      // Drawn at once from whatever was read last time and re-read behind it,
      // so a folder opened a second time never blinks through an empty row.
      set({ expanded: [...expanded, dir] })
      void get().read(dir)
    },

    async refresh() {
      const { expanded, openIds } = get()
      await Promise.all([
        // The palette's index goes stale the same way the tree does, and by
        // the same button — but only once there is one. Refresh keeps what has
        // been read up to date; it does not walk the workspace for a palette
        // nobody has opened yet. Nothing watches it either: the watchers follow
        // the folders somebody opened, and the index is everything else.
        ...(get().index.length > 0 ? [get().loadIndex(true)] : []),
        ...expanded.map((dir) => get().read(dir)),
        ...openIds.map(reloadOpen),
      ])
    },

    async syncDirs(dirs) {
      const { expanded, openIds } = get()

      // Only directories the tree still has open. A watcher is closed on the
      // way out of `expanded`, but an event already in flight arrives after
      // that, and re-reading for it would fill a cache for a row nobody is
      // looking at.
      const open = new Set(dirs.filter((dir) => expanded.includes(dir)))
      if (open.size === 0) return

      await Promise.all([
        ...[...open].map((dir) => get().read(dir)),
        // The files in it that are on screen, so an editor showing what a
        // build or an agent has just rewritten is showing the new one.
        ...openIds
          .filter((filePath) => open.has(parentOf(filePath)))
          .map(reloadOpen),
      ])
    },

    async syncPaths(paths) {
      const { expanded, openIds } = get()

      // Only directories the tree already has open, for the same reason as
      // above: a folder opened later reads itself anyway.
      const dirs = new Set<string>()
      for (const filePath of paths) {
        const dir = parentOf(filePath)
        if (expanded.includes(dir)) dirs.add(dir)
      }

      await Promise.all([
        ...[...dirs].map((dir) => get().read(dir)),
        ...paths
          .filter((filePath) => openIds.includes(filePath))
          .map(reloadOpen),
      ])
    },

    reload(filePath) {
      return reloadOpen(filePath)
    },

    collapseAll() {
      set({ expanded: [] })
    },

    async open(filePath, options) {
      get().select(filePath, options)
      await load(filePath, viewOf(get(), filePath))
    },

    ensureLoaded(filePath, viewer) {
      return load(filePath, viewer)
    },

    async setView(filePath, viewer) {
      set((state) => ({ views: { ...state.views, [filePath]: viewer } }))
      await load(filePath, viewer)
    },

    select(filePath, options) {
      useStudio.getState().showPane("files")
      // The tree follows whatever lands in the pane, wherever it was picked —
      // a tab in the strip, the palette, a definition jumped to. `SideRow`
      // scrolls the row into view once the folders holding it are open, which
      // is what this is for.
      void get().reveal(filePath)

      const { openIds, previewId, replaced } = opening(
        get(),
        filePath,
        options?.preview === true
      )
      // The evicted tab's editor unmounts with it, so this is the last moment
      // its edits can be written — the same bargain `close` makes, and it is
      // why a preview tab that has been typed into is not a preview any more.
      if (replaced !== null) flush(replaced)

      set({ selectedId: filePath, openIds, previewId })
      rememberTabs()
    },

    keep(filePath) {
      if (get().previewId !== filePath) return
      set({ previewId: null })
    },

    close(filePath) {
      const { openIds, selectedId } = get()
      const index = openIds.indexOf(filePath)
      if (index === -1) return

      // Before the tab goes: the editor unmounts with it, and an unsaved edit
      // would have nowhere left to be written from.
      flush(filePath)

      const remaining = openIds.filter((_, position) => position !== index)
      set({
        openIds: remaining,
        selectedId:
          selectedId === filePath
            ? (remaining[index] ?? remaining[index - 1] ?? null)
            : selectedId,
        // The slot is empty again rather than handed to the neighbour that took
        // the selection: that tab was opened on its own terms, and the next
        // single click has to add a preview rather than evict it.
        previewId: get().previewId === filePath ? null : get().previewId,
      })
      rememberTabs()
    },

    closeOthers(filePath) {
      for (const openId of get().openIds) {
        if (openId !== filePath) flush(openId)
      }
      set({
        openIds: [filePath],
        selectedId: filePath,
        previewId: get().previewId === filePath ? filePath : null,
      })
      rememberTabs()
    },

    closeAll() {
      for (const openId of get().openIds) flush(openId)
      set({ openIds: [], selectedId: null, previewId: null })
      rememberTabs()
    },

    reorder(paths) {
      const { openIds } = get()
      const reordered = paths.filter((filePath) => openIds.includes(filePath))
      if (reordered.length !== openIds.length) return
      set({ openIds: reordered })
      rememberTabs()
    },

    setText(filePath, text) {
      const doc = get().docs[filePath]
      if (doc?.kind !== "text" || doc.text === text) return
      setDoc(filePath, { ...doc, text })
      // Typed in, so it is no longer a file somebody is only looking at. Here
      // rather than in the editor, because every route to a change — a
      // keystroke, a paste, a format on save — goes through this one.
      get().keep(filePath)
    },

    async save(filePath) {
      const doc = get().docs[filePath]
      if (doc?.kind !== "text") return null

      const { text } = doc
      try {
        await window.desktop.writeTextFile(filePath, text)
      } catch (error) {
        return messageOf(error)
      }

      // Against what was written rather than what the editor holds now: typing
      // continued while the write was in flight is still unsaved, and marking
      // the tab clean would lose it silently.
      const current = get().docs[filePath]
      if (current?.kind === "text") {
        setDoc(filePath, { ...current, saved: text })
      }
      return null
    },

    async create(dir, name) {
      const created = await window.desktop.createFile(dir, name)
      await get().read(dir)
      await get().open(created)
      return created
    },

    async createFolder(dir, name) {
      const created = await window.desktop.createDirectory(dir, name)
      await get().read(dir)
      // Opened, because somebody who just made a folder is about to put
      // something in it.
      if (!get().expanded.includes(created)) get().toggle(created)
      return created
    },

    async rename(target, name) {
      const renamed = await window.desktop.renamePath(target, name)
      await get().read(parentOf(target))

      // The path is the identity here, so a rename is a different file as far
      // as every other part of this store is concerned: the tab, the document
      // and any listing under it are moved across by hand.
      const {
        openIds,
        selectedId,
        previewId,
        docs,
        images,
        views,
        expanded,
        entries,
      } = get()
      const moved = (filePath: string) => movedPath(filePath, target, renamed)

      set({
        openIds: openIds.map(moved),
        selectedId: selectedId === null ? null : moved(selectedId),
        // Moved rather than dropped: renaming a file is not opening it, and the
        // tab that was a preview before the rename is the same tab after it.
        previewId: previewId === null ? null : moved(previewId),
        expanded: expanded.map(moved),
        docs: Object.fromEntries(
          Object.entries(docs).map(([filePath, doc]) => [moved(filePath), doc])
        ),
        images: Object.fromEntries(
          Object.entries(images).map(([filePath, image]) => [
            moved(filePath),
            image,
          ])
        ),
        // A rename can change the extension, and with it what the file is by
        // default — but not what the user asked for it, which is why the
        // choice travels rather than being dropped.
        views: Object.fromEntries(
          Object.entries(views).map(([filePath, viewer]) => [
            moved(filePath),
            viewer,
          ])
        ),
        entries: Object.fromEntries(
          Object.entries(entries).map(([dir, listing]) => [
            moved(dir),
            listing.map((entry) => ({ ...entry, path: moved(entry.path) })),
          ])
        ),
      })
      rememberTabs()
      return renamed
    },

    async trash(target) {
      await window.desktop.trashPath(target)
      await get().read(parentOf(target))

      // Everything under it goes too — a directory takes its files' tabs with
      // it, and none of them can be saved back to a path that is now in the
      // trash. Closed without flushing, deliberately: the file is gone, and a
      // write would put half of it back.
      const {
        openIds,
        selectedId,
        previewId,
        expanded,
        docs,
        images,
        views,
        entries,
      } = get()
      const gone = (filePath: string) => isInside(target, filePath)

      const remaining = openIds.filter((filePath) => !gone(filePath))
      set({
        openIds: remaining,
        selectedId:
          selectedId && gone(selectedId) ? (remaining[0] ?? null) : selectedId,
        previewId: previewId && gone(previewId) ? null : previewId,
        expanded: expanded.filter((dir) => !gone(dir)),
        docs: Object.fromEntries(
          Object.entries(docs).filter(([filePath]) => !gone(filePath))
        ),
        images: Object.fromEntries(
          Object.entries(images).filter(([filePath]) => !gone(filePath))
        ),
        views: Object.fromEntries(
          Object.entries(views).filter(([filePath]) => !gone(filePath))
        ),
        entries: Object.fromEntries(
          Object.entries(entries).filter(([dir]) => !gone(dir))
        ),
      })
      rememberTabs()
    },

    restore() {
      restorePromise ??= (async () => {
        const stored = await recall(OPEN_TABS_KEY, isRememberedTabs)
        if (!stored || get().openIds.length > 0) return

        /*
         * Every remembered tab is read back: a file deleted or renamed since
         * the last launch is a path that names nothing, and it is the read
         * that says so rather than anything this app kept.
         *
         * Read by the viewer each one will be shown with, not always as text.
         * A restored picture read as text came back "binary" — enough to keep
         * the tab, and nothing the image view could draw, so it sat on
         * "Reading…" until something else went through `open`.
         */
        const read = await Promise.all(
          stored.openIds.map(async (filePath) => {
            const viewer = defaultViewer(filePath)
            return [
              filePath,
              viewer,
              viewer === "image"
                ? await readImage(filePath)
                : await readDoc(filePath),
            ] as const
          })
        )

        const kept = read.filter(([, , result]) => result.kind !== "error")
        const openIds = kept.map(([filePath]) => filePath)
        if (openIds.length === 0) return

        set((state) => ({
          docs: {
            ...state.docs,
            ...Object.fromEntries(
              kept
                // Everything that is not a picture was read as text — the
                // markdown preview draws the same `docs` entry the editor does.
                .filter(([, viewer]) => viewer !== "image")
                .map(([filePath, , result]) => [filePath, result as FileDoc])
            ),
          },
          images: {
            ...state.images,
            ...Object.fromEntries(
              kept
                .filter(([, viewer]) => viewer === "image")
                .map(([filePath, , result]) => [filePath, result as ImageDoc])
            ),
          },
          openIds,
          selectedId:
            stored.selectedId && openIds.includes(stored.selectedId)
              ? stored.selectedId
              : (openIds[0] ?? null),
        }))
      })()
      return restorePromise
    },
  }
})

/** How a file is being shown: what the user chose for it, or what its
 * extension implies. */
export function viewOf(
  state: { views: Record<string, Viewer> },
  filePath: string,
  /** What the pane asking would rather draw, for a file the reader has not
   * chosen a viewer for — the `Changes` tab, where a file is a diff. Below the
   * reader's own choice and above the extension's default, which is the order
   * those three were always in; it is a parameter because "what is this file
   * shown as" is per pane, and `views` is per path. */
  preferred?: Viewer
): Viewer {
  return state.views[filePath] ?? preferred ?? defaultViewer(filePath)
}

/** One image read into the shape the image view draws — a failure is a
 * document too, for the same reason a failed text read is. */
async function readImage(filePath: string): Promise<ImageDoc> {
  try {
    return { kind: "image", src: await window.desktop.readImageFile(filePath) }
  } catch (error) {
    return { kind: "error", message: messageOf(error) }
  }
}

/** One file read into the shape the pane draws — including the two refusals and
 * the failure, which are documents rather than exceptions here. */
async function readDoc(filePath: string): Promise<FileDoc> {
  try {
    const content = await window.desktop.readTextFile(filePath)
    return content.kind === "text"
      ? { kind: "text", text: content.text, saved: content.text }
      : content
  } catch (error) {
    return { kind: "error", message: messageOf(error) }
  }
}

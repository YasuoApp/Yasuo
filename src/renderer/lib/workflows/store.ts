import { create } from "zustand"

import type { Workflow, WorkflowGraph, WorkflowRun } from "@shared/workflows"
import { useStudio } from "../store"
import { isRememberedTabs, recall, remember } from "../tab-memory"
import { emptyGraph, parseGraph, serializeGraph, untitledName } from "./graph"

/** Which workflow tabs were open, and which was showing — restored at launch
 * the way the Explorer's file tabs are, since these are the workspace's. */
const TABS_KEY = "workflows.tabs"

/**
 * How long a graph sits in memory after an edit before it is written.
 *
 * A drag is a position change per frame, and writing a file per frame is
 * what a file-per-change would be. Long enough to swallow a drag, short enough
 * that closing the window a moment after one loses nothing anybody notices.
 */
const WRITE_DELAY_MS = 400

/**
 * The Workflows panel: the listing in the left column, and the tab each one
 * opens in the pane.
 *
 * The listing is read once and held; the graphs are read **one at a time**,
 * when a tab opens, and kept for as long as the app runs — `graphs` is the
 * only copy the canvas edits, and the file is written behind it rather than
 * read back. A graph a tab was opened for and never edited is never written.
 */
type WorkflowsState = {
  workflows: Workflow[]
  loaded: boolean

  /** Which workflows have a tab, oldest first — the strip's membership. */
  openIds: string[]
  selectedId: string | null

  /** Each opened workflow's graph, by id. Absent until `readGraph` lands. */
  graphs: Record<string, WorkflowGraph>

  /** Reads the listing and the remembered tabs. Idempotent. */
  load: () => Promise<void>

  /** Makes a workflow, puts it in the list and opens it. Resolves to its id. */
  create: () => Promise<string>
  rename: (id: string, name: string) => Promise<void>
  /** Takes a workflow out of the list, closes its tab and deletes its file. */
  remove: (id: string) => Promise<void>

  /** The last run of each workflow this process has seen, by workflow id. */
  runs: Record<string, WorkflowRun>
  /** Subscribes to main's run events for as long as the studio is up. */
  listen: () => () => void
  /**
   * Runs a workflow in a chat, with the graph as last drawn — called by a
   * message starting `@<slug>` (`invoke.ts`). Rejects with main's sentence —
   * already running, the chat busy — which the chat shows as its error.
   */
  run: (
    id: string,
    call: { chatId: string; message: string; input: string }
  ) => Promise<void>
  stop: (id: string) => Promise<void>

  open: (id: string) => void
  select: (id: string) => void
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeAll: () => void
  reorder: (ids: string[]) => void

  /** Reads one workflow's graph into `graphs`, once. */
  readGraph: (id: string) => Promise<void>
  /** The canvas's every change: held in memory at once, written soon after. */
  setGraph: (id: string, graph: WorkflowGraph) => void
}

export const useWorkflows = create<WorkflowsState>((set, get) => {
  let loadPromise: Promise<void> | null = null
  const reads = new Map<string, Promise<void>>()
  const writes = new Map<string, ReturnType<typeof setTimeout>>()

  function rememberTabs() {
    const { openIds, selectedId } = get()
    remember(TABS_KEY, { openIds, selectedId })
  }

  async function saveList(workflows: Workflow[]) {
    set({ workflows })
    await window.desktop.saveWorkflows(workflows)
  }

  /** Writes a graph now, and stamps the row so the column can say when. */
  async function flush(id: string) {
    writes.delete(id)
    const graph = get().graphs[id]
    if (!graph) return
    await window.desktop.writeWorkflow(id, serializeGraph(graph))
    const at = new Date().toISOString()
    const { workflows } = get()
    if (!workflows.some((workflow) => workflow.id === id)) return
    await saveList(
      workflows.map((workflow) =>
        workflow.id === id ? { ...workflow, updatedAt: at } : workflow
      )
    )
  }

  return {
    workflows: [],
    loaded: false,
    openIds: [],
    selectedId: null,
    graphs: {},

    load() {
      loadPromise ??= (async () => {
        const [workflows, tabs] = await Promise.all([
          window.desktop.listWorkflows(),
          recall(TABS_KEY, isRememberedTabs),
        ])
        const ids = new Set(workflows.map((workflow) => workflow.id))
        // A tab remembered for a workflow deleted since — by another window,
        // or by hand under `~/.yasuo` — is a tab on nothing.
        const openIds = (tabs?.openIds ?? []).filter((id) => ids.has(id))
        const selectedId =
          tabs?.selectedId && openIds.includes(tabs.selectedId)
            ? tabs.selectedId
            : null
        set({ workflows, loaded: true, openIds, selectedId })
      })()
      return loadPromise
    },

    async create() {
      const at = new Date().toISOString()
      const workflow: Workflow = {
        id: crypto.randomUUID(),
        name: untitledName(get().workflows),
        createdAt: at,
        updatedAt: at,
      }
      // The graph before the row: `open` reads the graph of anything it does
      // not hold, and a file that is not there yet reads back as the same
      // `Start` box this puts in — but this way the row and its file land
      // together rather than the file waiting on the first edit.
      const graph = emptyGraph()
      set((state) => ({ graphs: { ...state.graphs, [workflow.id]: graph } }))
      await window.desktop.writeWorkflow(workflow.id, serializeGraph(graph))
      await saveList([...get().workflows, workflow])
      get().open(workflow.id)
      return workflow.id
    },

    async rename(id, name) {
      const trimmed = name.trim()
      if (!trimmed) return
      await saveList(
        get().workflows.map((workflow) =>
          workflow.id === id ? { ...workflow, name: trimmed } : workflow
        )
      )
    },

    runs: {},

    listen() {
      return window.desktop.onWorkflowRunEvent((run) => {
        set((state) => ({ runs: { ...state.runs, [run.workflowId]: run } }))
      })
    },

    async run(id, call) {
      await get().readGraph(id)
      const graph = get().graphs[id]
      if (!graph) throw new Error("That workflow could not be read.")
      // Written before it runs, so the file and the run agree about what ran.
      const pending = writes.get(id)
      if (pending) {
        clearTimeout(pending)
        await flush(id)
      }
      await window.desktop.runWorkflow(id, graph, call)
    },

    async stop(id) {
      await window.desktop.stopWorkflow(id)
    },

    async remove(id) {
      const pending = writes.get(id)
      if (pending) {
        clearTimeout(pending)
        writes.delete(id)
      }
      get().close(id)
      set((state) => {
        const graphs = { ...state.graphs }
        delete graphs[id]
        return { graphs }
      })
      await saveList(get().workflows.filter((workflow) => workflow.id !== id))
      await window.desktop.deleteWorkflow(id)
    },

    open(id) {
      get().select(id)
    },

    select(id) {
      const { openIds } = get()
      set({
        openIds: openIds.includes(id) ? openIds : [...openIds, id],
        selectedId: id,
      })
      useStudio.getState().showPane("workflows")
      rememberTabs()
      void get().readGraph(id)
      // A run that began before this pane was looking — or before this
      // window existed — is asked for once, and events carry it from there.
      if (!get().runs[id]) {
        void window.desktop.workflowRun(id).then((run) => {
          if (run && !get().runs[id])
            set((state) => ({ runs: { ...state.runs, [id]: run } }))
        })
      }
    },

    close(id) {
      const openIds = get().openIds.filter((entry) => entry !== id)
      set({
        openIds,
        selectedId:
          get().selectedId === id ? (openIds.at(-1) ?? null) : get().selectedId,
      })
      rememberTabs()
    },

    closeOthers(id) {
      set({ openIds: [id], selectedId: id })
      rememberTabs()
    },

    closeAll() {
      set({ openIds: [], selectedId: null })
      rememberTabs()
    },

    reorder(ids) {
      const open = new Set(get().openIds)
      set({ openIds: ids.filter((id) => open.has(id)) })
      rememberTabs()
    },

    readGraph(id) {
      if (get().graphs[id]) return Promise.resolve()
      const pending = reads.get(id)
      if (pending) return pending
      const read = (async () => {
        const text = await window.desktop.readWorkflow(id)
        // Unreadable reads as new rather than as an error in the pane: the
        // file is the user's to edit, and a workflow with a broken file is
        // still a workflow somebody can draw in. The next edit overwrites it.
        const graph = parseGraph(text) ?? emptyGraph()
        set((state) => ({ graphs: { ...state.graphs, [id]: graph } }))
        reads.delete(id)
      })()
      reads.set(id, read)
      return read
    },

    setGraph(id, graph) {
      set((state) => ({ graphs: { ...state.graphs, [id]: graph } }))
      const pending = writes.get(id)
      if (pending) clearTimeout(pending)
      writes.set(
        id,
        setTimeout(() => void flush(id), WRITE_DELAY_MS)
      )
    },
  }
})

/** The workflow a tab names, or undefined between its deletion and the tab
 * closing. */
export function workflowOf(
  workflows: Workflow[],
  id: string
): Workflow | undefined {
  return workflows.find((workflow) => workflow.id === id)
}

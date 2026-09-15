import { useEffect, useLayoutEffect, useState } from "react"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

import { useFiles } from "@/lib/files/store"
import { watchExpandedDirectories } from "@/lib/files/watch"
import { reconcileScope, useActiveTabId, useHasOpenTabs } from "@/lib/panels"
import {
  isEditingRichText,
  isStudioShortcut,
  isTerminalShortcut,
} from "@/lib/shortcuts"
import { useSettings } from "@/lib/settings"
import { useDock, DOCK_STRIP_HEIGHT } from "@/lib/dock"
import { useStudio, RAIL_WIDTH, type Pane } from "@/lib/store"
import { useRun } from "@/lib/run/store"
import { useProjects } from "@/lib/projects"
import { useClaudeProfiles } from "@/lib/worktree-chat/claude-profiles"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import { useBoard } from "@/lib/board/store"
import { useReview } from "@/lib/files/review"
import { Dock } from "./dock"
import { ProjectCrumbs } from "./project/project-crumbs"
import { ProjectRail } from "./project/project-rail"
import { WorkspaceSidebar } from "./workspace-sidebar"
import { WorktreeChatPane } from "./worktree/chat-pane"
import { FileTree } from "./files/file-tree"
import { ExplorerRail } from "./files/explorer-rail"
import { ChangesPane } from "./files/changes-pane"
import { BoardPane } from "./board/board-pane"
import { FileWorkspace } from "./files/file-workspace"
import { AddFolderDialog } from "./add-folder-dialog"
import { CommandPalette } from "./command-palette"
import { NothingOpen } from "./nothing-open"
import { SettingsDialog } from "./settings-dialog"
import { SystemBar } from "./system-bar"
import {
  Splash,
  splashElapsed,
  SPLASH_ASSEMBLE_MS,
  SPLASH_FADE_MS,
} from "./splash"
import { IS_MAC, TitleBarDragStrip } from "./title-bar"
import { GroupTabs } from "./group-tabs"
import { WorkspaceTabs } from "./workspace-tabs"

/** What each pane on the rail shows. Built here rather than inline so the
 * stack below is a list of panes and nothing else. */
function paneView(pane: Pane) {
  switch (pane) {
    case "files":
      return <FileWorkspace />
    case "changes":
      return <ChangesPane />
    case "worktree":
      return <WorktreeChatPane />
    case "board":
      return <BoardPane />
  }
}

/** How far the launch screen has got: still assembling, fading out over the
 * workbench, or gone. */
type Launch = "splash" | "closing" | "done"

export function Studio() {
  const workspaceLoaded = useStudio((state) => state.loaded)
  const storageError = useStudio((state) => state.storageError)
  const loaded = workspaceLoaded

  const [launch, setLaunch] = useState<Launch>("splash")

  // Everything the studio holds belongs to the one workspace, so this is the
  // only moment it is read. The ones here rather than in their own panels are
  // the ones that matter before the panel is opened: a file is the kind of
  // thing whose *tab* can be restored onto a pane whose list is not the one
  // showing — the strip cannot draw a tab for something it has never read.
  //
  // The databases used to be read here too, for the tree the app started on.
  // Nothing in this window lists them any more, and reading them put the
  // Database panel's remembered tabs back into a strip that no longer draws
  // them (`PANES`); `DatabaseWindow` does its own read.
  useEffect(() => {
    void useStudio.getState().init()
    void useSettings.getState().restore()
    void useFiles.getState().restore()
    void useProjects.getState().restore()
    void useRun.getState().restore()
    void useWorktreeChats.getState().refresh()
    void useClaudeProfiles.getState().refresh()
    // Before any board is opened: a project's tab carries how many cards it has
    // waiting, and the chat pane's chip asks which card a chat is the work of.
    void useBoard.getState().refresh()
    // Before any diff is opened, for the same reason: the `Comments` tab counts
    // threads in files nobody has looked at yet. Each is put back on its lines
    // the first time its own file is shown — see `showing`.
    void useReview.getState().load()
  }, [])

  // A run outlives the dock being closed and the tab being switched away from,
  // so its output is subscribed to here rather than in the panel.
  useEffect(() => useRun.getState().listen(), [])

  // A chat's turn runs in the main process and outlives the
  // pane being switched away from, so its lines are subscribed to here.
  useEffect(() => useWorktreeChats.getState().listen(), [])

  /*
   * The manifest is a small file on a local disk and usually lands well inside
   * the time the launch screen takes to draw itself, so the wait here is the
   * opposite of the usual one: the workbench is held to the end of the
   * sequence rather than the sequence being held open for the workbench. A
   * splash cut off a third of the way through does not read as a fast app, it
   * reads as a glitch.
   *
   * Two states rather than one because this is a crossfade and not a cut: the
   * workbench mounts when the fade starts and is on screen behind the last of
   * it.
   *
   * **`loaded` and nothing else.** Both timers are set once here, and `launch`
   * must stay out of the dependencies: it is what the first timer changes, so an
   * effect watching it re-ran on its own `setLaunch("closing")`, cleared the
   * `done` timer it had just been holding, and then returned early because
   * `launch` was no longer `"splash"`. The app sat in `"closing"` for the rest of
   * the run — invisibly, since the splash is transparent by then, except that its
   * drag region stayed over the whole title bar and every button up there stopped
   * taking clicks. Watching the thing you are about to set is the whole of the
   * bug.
   */
  useEffect(() => {
    if (!loaded) return

    const left = Math.max(0, SPLASH_ASSEMBLE_MS - splashElapsed())
    const toClosing = setTimeout(() => setLaunch("closing"), left)
    const toDone = setTimeout(() => setLaunch("done"), left + SPLASH_FADE_MS)
    return () => {
      clearTimeout(toClosing)
      clearTimeout(toDone)
    }
  }, [loaded])

  // A failure has nothing to wait for and nothing to celebrate: it replaces
  // the launch screen outright rather than fading in behind it.
  if (storageError) return <StorageError message={storageError} />

  return (
    <>
      {launch !== "splash" && <Workbench />}
      {launch !== "done" && <Splash closing={launch === "closing"} />}
      {/* The launch screen has nothing clickable, so the top of the window is
          its drag handle. Owned here rather than by the splash because it has to
          outlive it: unmounting a drag region leaves macOS holding it, over the
          crumb bar the workbench draws in the same place — see
          `TitleBarDragStrip`. */}
      <TitleBarDragStrip active={launch !== "done"} />
    </>
  )
}

function Workbench() {
  const pane = useStudio((state) => state.pane)
  const hasOpenTabs = useHasOpenTabs()
  const activeTabId = useActiveTabId(pane)

  const [adding, setAdding] = useState(false)
  /** The Settings dialog — the application menu's ⌘, and nothing else, since
   * a preference is not a thing the workspace holds a row for. */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Whether the dock — `Run` and `Terminal` — is on screen: the button in the
   * header, and the chevron in the dock's own strip. */
  const dockOpen = useDock((state) => state.open)
  const toggleDockTab = useDock((state) => state.toggleTab)
  /** The left column, and its toggle in the title bar. */
  const projectSidebar = useProjects((state) => state.sidebar)
  const toggleProjectSidebar = useProjects((state) => state.toggleSidebar)
  /** Whether the Explorer panel is showing at all — `⌘B`, the View menu, or
   * dragging its handle shut. */
  const sidebar = useStudio((state) => state.sidebar)
  const toggleSidebar = useStudio((state) => state.toggleSidebar)
  /** The panels built so far, in the order they were first shown; see the
   * stack below. */
  const [mounted, setMounted] = useState<Pane[]>([])

  // The panel on screen — or none, which `NothingOpen` answers for the pane
  // whose tab went.
  //
  // A panel is drawn only when it has a tab to draw: each one used to answer
  // "nothing selected" for itself, which meant whoever opened the app to read
  // a request was told to pick a table, because `database` is the pane a fresh
  // launch starts on. Now the workbench says it once, in terms of the strip,
  // which is what the user is actually looking at.
  const shown = hasOpenTabs && activeTabId ? pane : null

  // Adjusted during the render that first shows a panel rather than in an
  // effect afterwards: an effect would leave one painted frame with the pane
  // empty, and this is the list that mounts what belongs in it.
  if (shown && !mounted.includes(shown)) setMounted([...mounted, shown])

  // The File menu is a second way to reach the same dialog — and the only one
  // left when Explorer is taken off the rail. It runs in the main process and
  // cannot open a dialog itself, so it names the command instead.
  useEffect(
    () =>
      window.desktop.onMenuCommand((command) => {
        if (command === "add-folder") setAdding(true)
        if (command === "open-settings") setSettingsOpen(true)
        if (command === "toggle-sidebar") toggleSidebar()
        if (command === "toggle-terminal") toggleDockTab("terminal")
      }),
    [toggleSidebar, toggleDockTab]
  )

  // The tree follows the disk for as long as the workbench is up — here rather
  // than in the Explorer panel, which the rail unmounts every time somebody
  // reads another one.
  useEffect(() => watchExpandedDirectories(), [])

  /*
   * The strip is per checkout, so moving the checkout may leave the pane drawing
   * something the strip no longer holds — see `reconcileScope`.
   *
   * Here rather than inside `setActive`, which is where it belongs by rights: a
   * store that reached into `lib/panels.ts` would be a cycle, since that module
   * reads this one's context to work out what is in scope at all. So the
   * workbench watches the field instead, which is the same thing one frame
   * later and in the layer that is allowed to know about both.
   */
  const activeFolderId = useProjects((state) => state.activeFolderId)
  useEffect(() => {
    reconcileScope()
  }, [activeFolderId])

  /*
   * The sidebar's own panel, collapsed rather than unmounted.
   *
   * `collapse()` is the only way to take a `ResizablePanel`'s space back — it
   * has no `collapsed` prop — and it is the right one here anyway: the panel
   * remembers the width it was dragged to and gives it back on `expand()`,
   * where a sidebar taken out of the group would come back at its default. The
   * sidebar it holds is one of five lists, and unmounting is the rail's
   * business, not this.
   *
   * **`useLayoutEffect`, and that is the flicker.** These run off a store the
   * button flips, so the render that hides the column's contents lands one
   * paint *before* the panel is told to narrow — and the browser drew that
   * paint: a frame of an empty column at its full width, then the collapse.
   * Moving the hiding to the panel's own width only turned the flash around,
   * into a frame of contents clipped to 36px behind the rail. There is no
   * order of the two that works, because the two were in different frames at
   * all. A layout effect runs after the DOM is updated and *before* the paint,
   * and the `collapse()` in it re-renders synchronously, so both land in the
   * one frame.
   */
  const sidebarPanel = usePanelRef()
  useLayoutEffect(() => {
    if (sidebar) sidebarPanel.current?.expand()
    else sidebarPanel.current?.collapse()
  }, [sidebar, sidebarPanel])

  /** The same for the left column, which collapses on its own button. */
  const projectPanel = usePanelRef()
  useLayoutEffect(() => {
    if (projectSidebar) projectPanel.current?.expand()
    else projectPanel.current?.collapse()
  }, [projectSidebar, projectPanel])

  /**
   * And the dock, which is collapsed rather than unmounted — the reason being
   * the shell in it. A pty taken out of the tree ends; it does not hide. The
   * dock used to unmount, which was fine while it held a conversation the main
   * process owned and a log, and became a bug the moment closing it would have
   * killed whatever was running in the Terminal tab.
   */
  const dockPanel = usePanelRef()
  useLayoutEffect(() => {
    if (dockOpen) dockPanel.current?.expand()
    else dockPanel.current?.collapse()
  }, [dockOpen, dockPanel])

  /*
   * `⌘B` — the editors' shortcut for the sidebar, and the View menu's item.
   *
   * On the capture phase like the studio's other three, so a focused editor
   * cannot swallow it, with the one exception the letter makes: in a rich-text
   * editor `⌘B` is bold and stays bold (`isEditingRichText`). Nothing else on
   * screen wants the key — the code editor has no binding for it, and off macOS a
   * terminal is refused by `isStudioShortcut` itself, where `Ctrl+B` is tmux's
   * prefix and readline's backward-char.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isStudioShortcut(event, "b")) return
      if (isEditingRichText(event.target)) return

      event.preventDefault()
      toggleSidebar()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [toggleSidebar])

  /*
   * `⌃\`` — the dock's Terminal tab, the editors' key for it, and the View
   * menu's item.
   *
   * On the capture phase for the reason the others are, and one more: this is
   * the only one of them meant to work *inside* the terminal, and xterm would
   * otherwise hand the key to the pty before the page had it. Showing the tab
   * when it is not the one on screen, hiding the dock when it is — that is
   * `toggleTab`, not `toggle`, so the key reaches the terminal from the Run tab
   * in one press rather than two.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isTerminalShortcut(event)) return

      event.preventDefault()
      toggleDockTab("terminal")
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [toggleDockTab])

  /*
   * The panel on screen, and the notice that stands in for it.
   *
   * A value rather than inline JSX, which is what it was when the tab strip had
   * two placements and this had to go in either of two boxes. It is one box now,
   * and what the name still buys is that the reader meets the pane's own
   * question — which panel, or the notice — clear of the panels around it.
   *
   * `overflow-hidden` because the panels below are absolutely positioned and so
   * do not clip: a panel that forgot to scroll its own content would otherwise
   * spill past this box and be scrolled by an ancestor, which takes the tab
   * strip off the edge of the window with it.
   */
  const paneContent = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* The strip inside the tab on screen, when the panel is grouping its
          tabs under the folder each belongs to — between the workbench's own
          strip and the pane. */}
      <GroupTabs pane={pane} />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/*
        Every panel is hidden rather than unmounted, and built the first time it
        is shown — a panel nobody has opened is a connection nobody is reading.

        Everything they hold that their store does not is lost on a switch, and
        a panel switched away from is coming back. Leaving Database for API
        and returning gave a result grid scrolled back to the top, a SQL editor
        with no undo history and the split at its default height.

        `invisible`, not `hidden`: `display: none` destroys the scrolling boxes
        inside, which would put that grid back at the top by another route —
        and it is what the dock stacks its own shells with.
      */}
        {mounted.map((name) => (
          <div
            key={name}
            className={cn("absolute inset-0", name !== shown && "invisible")}
          >
            {paneView(name)}
          </div>
        ))}

        {/* One notice for the whole workbench, rather than each panel's own:
          nothing open at all, or tabs open with none of them on screen. */}
        {!shown && (
          <div className="absolute inset-0">
            <NothingOpen pane={pane} hasOpenTabs={hasOpenTabs} />
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      {/*
        The window is a row, not a column.

        The left column runs the full height, from under the traffic lights to
        the status bar, and the bar carrying the crumb sits above the *work*
        only — the pane and the Explorer — rather than across the whole window.
        Conductor's shape, and the reason is what each of the two is about: the
        column is the workspace and does not change when you switch checkout,
        while everything to the right of it is one checkout's, which is exactly
        what the crumb names. A bar spanning both would be labelling the column
        too, and mislabelling it.

        The cost is that the two strips at the top are two boxes to keep the
        same height (`h-11` in both), and that the traffic lights now land in
        whichever of them is at the window's left edge — see `WindowLeftEdge`.
      */}
      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-w-0 flex-1"
        >
          {/*
            The workspace's own column: its projects, and the branches under
            each. `Database` and `API` are hidden for now — see
            `SIDEBAR_SECTIONS` in `lib/projects.ts`, and the footer's two
            buttons, which open them in a window each.
          */}
          <ResizablePanel
            // The column's own widths, unchanged by the rail: it is positioned
            // rather than laid out, so it costs the panel nothing to arrange.
            defaultSize={228}
            minSize={168}
            maxSize={360}
            collapsible
            // Collapsed to its rail rather than to nothing, so the button that
            // shut it is still where it was — see `RAIL_WIDTH`.
            collapsedSize={RAIL_WIDTH}
            panelRef={projectPanel}
            // The Explorer's panel needs this for the same reason: `Panel`
            // wraps its children in a scroll container (`overflow: auto`,
            // inline), and a collapse to exactly the rail's width lands on a
            // fractional pixel, which shows up as a scrollbar over the rail.
            style={{ overflow: "hidden" }}
            onResize={(size, _id, previous) => {
              // Undefined on mount is the panel reporting the width it was
              // handed, not a drag — read as one, a launch that remembered a
              // closed column would reopen it. Same trap as the panels' below.
              if (previous === undefined) return

              const shown = size.inPixels > RAIL_WIDTH
              if (shown !== useProjects.getState().sidebar) {
                toggleProjectSidebar()
              }
            }}
          >
            <div className="flex h-full min-h-0 flex-col">
              {/* The window's corner, over the rail as well as the column, so
                  the traffic lights sit in one strip whichever of them is on
                  screen. */}
              <WindowLeftEdge />
              <div className="@container relative min-h-0 flex-1">
                {/* Hidden while the column is at its rail, and **hidden by a
                    container query** — see the Explorer's, which carries the
                    argument. Not unmounted: the column holds the folding state
                    and the project the workbench is scoped to. */}
                <div
                  className={cn(
                    "h-full overflow-hidden @max-[100px]:pointer-events-none @max-[100px]:opacity-0",
                    // Two sources for one fact, and each covers what the other
                    // cannot: the store is what a *click* changes, and lands in
                    // the same frame as the collapse now the effect above is a
                    // layout one; the container query is what a *drag* crosses,
                    // where the store only hears about it afterwards, through
                    // `onResize`.
                    !projectSidebar && "pointer-events-none opacity-0"
                  )}
                >
                  <WorkspaceSidebar
                    onOpenSettings={() => setSettingsOpen(true)}
                    onAddFolder={() => setAdding(true)}
                  />
                </div>
                <ProjectRail />
              </div>
            </div>
          </ResizablePanel>

          {/* Left on screen when the column is shut, like the Explorer's: what
              is left is the rail, so the handle still has an edge to be, and
              dragging it is the second way back. */}
          <ResizableHandle />

          {/* Everything about the one checkout: the bar that names it, the pane,
              and the Explorer with the dock under it. Its minimum is the two
              columns inside it added up. */}
          <ResizablePanel minSize={560}>
            <div className="flex h-full min-h-0 flex-col">
              <header className="flex h-11 shrink-0 items-center gap-1 border-b">
                {/* The rest of the traffic lights' clearance when the column
                    is shut: the rail is 36px of the 84 they need, and this bar
                    is what the other 48 have to come out of. */}
                {!projectSidebar && <WindowLeftEdge bare />}

                {/*
                  `project › branch`, and the `…` that acts on it.

                  This bar was deliberately bare for a long while, and the
                  reason was sound: the workspace holds several folders, each on
                  a branch of its own, so one line could only be about one of
                  them. What changed is that one of them *is* the one being
                  worked in — clicking a row in the column moves the tree, the
                  shell and the chat together, and so does selecting a tab from
                  another checkout — and this bar is over exactly the part of
                  the window that follows it. A `Home › task` crumb took this
                  end once before and went with the tasks; this one is about a
                  place rather than a layer that no longer exists.
                */}
                <ProjectCrumbs />

                {/*
                  The drag handle — this part of the bar and not the whole of
                  it. A clickable thing inside a `-webkit-app-region: drag` box
                  has to opt back out with `no-drag`, and on macOS that
                  subtraction is unreliable: the theme toggle that used to sit
                  here took no clicks at all while its `d` shortcut still
                  worked. So the region is what is left over between the
                  controls rather than something punched through them.
                */}
                <div className="drag-region h-full min-w-0 flex-1" />

                {/*
                  There was a dock toggle in this corner, and before that an
                  assistant button — a workspace chat that was the dock's first
                  tab. Both are gone, and the corner is empty: the dock's own
                  strip stays on screen when it is shut (`DOCK_STRIP_HEIGHT`), so
                  the way back is the row that closed it rather than a button
                  three regions away from the thing it showed.
                */}
              </header>

              {/* No screen of its own for an empty workspace. A folder is what
                  Explorer lists and what the dock opens a shell in, and nothing
                  else here is about one — the databases and the requests
                  belong to the workspace — so a studio held shut until one is
                  added would be holding back panels that had nothing to wait
                  for. Adding one is a button in Explorer's own header, and the
                  File menu. */}
              <div className="flex min-h-0 flex-1">
                <ResizablePanelGroup
                  orientation="horizontal"
                  className="min-w-0 flex-1"
                >
                  {/*
                    The pane, with the dock under it and spanning the whole
                    width of it.

                    The dock used to be a panel inside the Explorer column,
                    stacked under the tree the way Conductor stacks its own
                    Run/Terminal under its file list. That was inherited from a
                    window whose file list is on the *left* and as wide as one
                    wants; here the Explorer is on the right and capped at
                    520px, which made a shell 60-odd columns wide — under the 80
                    that virtually every CLI's output is written for — and
                    stole the tree's height every time the dock opened. Both
                    halves of that are about geometry rather than about what the
                    dock *is*, so the dock moved and the Explorer went back to
                    being one full-height list.

                    Under the pane rather than under the whole window because
                    the Explorer is what somebody consults *while* the dock is
                    open — run a command, look at `Changes` — and a dock that
                    shortened the tree to do it would be the coupling that was
                    just removed, pointed the other way.
                  */}
                  <ResizablePanel minSize={280}>
                    <ResizablePanelGroup orientation="vertical">
                      {/* Enough to keep an editor readable when the dock has
                          been dragged tall. */}
                      <ResizablePanel minSize={200}>
                        <div className="flex h-full min-w-0 flex-col">
                          {/* Outside the panel rather than inside one, which is
                              what keeps a table open on screen while the API
                              panel is the one being looked at. */}
                          <WorkspaceTabs pane={pane} />
                          {paneContent}
                        </div>
                      </ResizablePanel>

                      <ResizableHandle className={cn(!dockOpen && "hidden")} />

                      {/* Collapsed rather than unmounted, and that is not
                          tidiness: `ShellView`'s cleanup kills the pty, so a
                          dock taken out of the tree takes the shell's running
                          command with it.

                          Collapsed to its tab strip rather than to nothing, so
                          that shutting the dock leaves the row that reopens it
                          — see `DOCK_STRIP_HEIGHT`. */}
                      <ResizablePanel
                        defaultSize={320}
                        minSize={160}
                        collapsible
                        collapsedSize={DOCK_STRIP_HEIGHT}
                        panelRef={dockPanel}
                        // `Panel` wraps its children in a div that is a scroll
                        // container (`overflow: auto`, inline, so a class will
                        // not reach it), and this panel has nothing to scroll —
                        // the dock's own two panes are `absolute inset-0` and
                        // scroll themselves. Left as `auto` it showed a
                        // scrollbar over the shut dock's strip, because a
                        // collapse to exactly `DOCK_STRIP_HEIGHT` lands on a
                        // fractional pixel once the layout has been through the
                        // library's percentages, and the strip is that height
                        // to the pixel.
                        style={{ overflow: "hidden" }}
                        // The same two-way binding the Explorer column has:
                        // dragging the dock shut past its minimum collapses the
                        // panel, and without this the store would still say open
                        // — a chevron pointing down at a dock that is already
                        // down, and one press of `⌃`` doing nothing.
                        onResize={(size, _id, previous) => {
                          if (previous === undefined) return

                          const shown = size.inPixels > DOCK_STRIP_HEIGHT
                          if (shown !== useDock.getState().open) {
                            useDock.getState().toggle()
                          }
                        }}
                      >
                        <Dock />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </ResizablePanel>

                  {/* Not hidden when the column is shut, unlike the dock's:
                      what is left is the rail rather than nothing, so the
                      handle still has an edge to be — and dragging it is the
                      second way back, beside the rail's own button. */}
                  <ResizableHandle />

                  {/* The Explorer: the contents of the checkout being worked
                      in, and the whole height of the column. */}
                  <ResizablePanel
                    // The tree's own widths, unchanged by the rail: it is
                    // positioned rather than laid out, so it takes none of them.
                    defaultSize={320}
                    minSize={240}
                    maxSize={520}
                    // Dragging the handle past the minimum closes it too, which
                    // is the other half of what `⌘B` does — so the state
                    // follows the panel as well as driving it, or a column
                    // dragged shut would leave `⌘B` needing two presses to
                    // bring it back.
                    //
                    // Collapsed to its rail rather than to nothing, so that
                    // shutting the column leaves the button that reopens it —
                    // see `RAIL_WIDTH`.
                    collapsible
                    collapsedSize={RAIL_WIDTH}
                    panelRef={sidebarPanel}
                    // The dock's panel needs this for the same reason: `Panel`
                    // wraps its children in a scroll container (`overflow:
                    // auto`, inline), and a collapse to exactly the rail's width
                    // lands on a fractional pixel once the library's
                    // percentages have been through the layout, which shows up
                    // as a scrollbar over the shut column.
                    style={{ overflow: "hidden" }}
                    onResize={(size, _id, previous) => {
                      if (previous === undefined) return

                      const shown = size.inPixels > RAIL_WIDTH
                      if (shown !== useStudio.getState().sidebar) {
                        toggleSidebar()
                      }
                    }}
                  >
                    {/* The Explorer, and nothing else — so no tabs above it.
                        The other three lists are sections of the left column
                        (hidden for now), and a strip of four tabs with one tab
                        on it is a row of chrome that answers nothing. */}
                    <div className="@container relative h-full min-h-0">
                      {/*
                        Hidden rather than unmounted while the column is shut:
                        the tree is what watches the checkout's changes for the
                        count on its `Changes` tab, and one taken out of the
                        React tree would stop watching and come back scrolled
                        to the top. Hidden rather than squeezed, too, because
                        the rail is out of flow and clips nothing under it — a
                        column shut to 36px would otherwise show a sliver of the
                        tree behind the button.

                        **`opacity-0` and not `invisible`, and that is the
                        flicker.** The rows here are `Button`s, `Button` carries
                        `transition-all`, and `visibility` is one of the
                        properties `all` covers — it transitions discretely, so
                        `visible → hidden` holds at *visible* for the whole
                        150ms before flipping. Measured off a screen recording:
                        the column collapsed on the frame it was clicked and the
                        rows stayed lit for ten more, then vanished in one step.
                        Nothing about that was a render being a frame late,
                        which is what the two attempts before this assumed.
                        Opacity does not inherit, so the children's own
                        transitions never see it, and this box has none.

                        Two sources for the one fact, each covering what the
                        other cannot: the store is what a *click* changes, and
                        the container query is what a *drag* crosses, since
                        dragging only reaches the store afterwards through
                        `onResize`. `100px` is anywhere between the rail and the
                        panel's `minSize`.
                      */}
                      <div
                        className={cn(
                          "h-full overflow-hidden @max-[100px]:pointer-events-none @max-[100px]:opacity-0",
                          // The store for a click, the query for a drag — see
                          // the left column's, which does the same.
                          !sidebar && "pointer-events-none opacity-0"
                        )}
                      >
                        <FileTree onAddFolder={() => setAdding(true)} />
                      </div>
                      <ExplorerRail />
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <SystemBar />

      {/* Mounted rather than opened from anywhere: the palette is a shortcut
          (⌘P) and owns it, so nothing here has to hold a piece of it. */}
      <CommandPalette />

      {adding && <AddFolderDialog onClose={() => setAdding(false)} />}

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

/**
 * The window's top-left corner: the traffic lights' clearance, and nothing else.
 *
 * It used to hold the left column's toggle as well, and that is why it is drawn
 * in two places — the column's own top row while the column is showing, the
 * crumb bar when it is not, so the button survived the column it collapsed.
 * The button lives in the rail now (`ProjectRail`), which is on screen in both
 * states, and what is left here is what this strip was always for: keeping the
 * lights off whatever the app draws underneath them.
 *
 * There is no `no-drag` hole in it any more either, and that is a relief rather
 * than a detail: macOS drops those holes often enough that the toggle inside
 * one was a control that "worked sometimes".
 *
 * The `5.25rem` is what clears the lights at `x: 18`, since macOS insets its own
 * buttons into whatever the app draws up here (`titleBarStyle` and
 * `trafficLightPosition` in `main/main.ts`). The `bare` variant is `3rem`
 * because the rail is already 36px of that clearance and is to the left of it.
 */
function WindowLeftEdge({
  bare = false,
}: {
  /** In the crumb bar rather than being a row of its own, so it brings no
   * height and no border with it. */
  bare?: boolean
}) {
  if (bare) {
    return IS_MAC ? <div className="drag-region h-full w-12 shrink-0" /> : null
  }

  return (
    <div className="flex h-11 shrink-0 items-center border-b">
      <div className="drag-region h-full flex-1" />
    </div>
  )
}

/**
 * Shown when the workspace could not be read.
 *
 * There is deliberately nothing to click: this means `manifest.json` could not
 * be read, and no button the studio could offer would fix a permissions problem
 * or a corrupt file — while a "reset" that deleted the manifest would throw away
 * the workspace, which is the one thing worth keeping. So it says where to look
 * instead.
 */
function StorageError({ message }: { message: string }) {
  return (
    <div className="grid h-svh place-items-center p-6">
      <TitleBarDragStrip />
      <div className="max-w-md space-y-3 text-center">
        <h1 className="font-heading font-medium">
          Could not open your workspace
        </h1>
        <p className="font-mono text-xs text-destructive">{message}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your workspace is <code className="font-mono">manifest.json</code>{" "}
          under <code className="font-mono">~/.yasuo</code>, listing the folders
          it points at. Those folders are untouched — check that the manifest is
          readable.
        </p>
      </div>
    </div>
  )
}

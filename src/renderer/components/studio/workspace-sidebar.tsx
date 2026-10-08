import { Plus } from "lucide-react"

import {
  SIDEBAR_SECTIONS,
  useProjects,
  type SidebarSection,
} from "@/lib/projects"
import { IconButton } from "./icon-button"
import { PanelHeader, type Fold } from "./panel-header"
import { ProjectsSection } from "./project/projects-section"
import { SearchSection } from "./search-section"
import { WorkflowsSection } from "./workflows/workflows-section"

/**
 * The window's left column: whatever `SIDEBAR_SECTIONS` lists.
 *
 * **Projects, and nothing else.** The column stacked three — `Projects` /
 * `Database` / `API`, each folding — and the other two were hidden behind
 * `SIDEBAR_SECTIONS` for a while before both panels were deleted outright. So
 * this is Conductor's left column: the projects and their chats with the whole
 * height to themselves. `SIDEBAR_SECTIONS` is still the one line saying which
 * sections are drawn, and still worth keeping as a list — the next section to
 * arrive is an entry rather than a rewrite.
 *
 * The Explorer was never one of them, and that is the asymmetry worth stating:
 * a file tree is the contents of the thing being worked on rather than a list of
 * what the workspace holds, so it kept the right-hand panel — which needs no
 * tabs, having one thing in it.
 *
 * Each section is the panel's own component, unchanged, under its own
 * `PanelHeader`. The fold (`open`/`onToggle`) is handed in only while there is
 * more than one of them: a lone section with a chevron is a chevron whose only
 * use is emptying the column.
 */
export function WorkspaceSidebar({
  onAddFolder,
}: {
  /** The same dialog Explorer's tree asks for, and asked for the same way: it
   * is mounted in the workbench, so both columns ask rather than open. */
  onAddFolder: () => void
}) {
  const shut = useProjects((state) => state.shutSections)
  const view = useProjects((state) => state.view)
  /** Whether there is anything to fold *against* — see `Section`. */
  const alone = SIDEBAR_SECTIONS.length === 1

  // Instead of the sections rather than stacked with them — see `SidebarView`.
  // Unmounted while the projects show: what it holds is its store's.
  if (view === "search") {
    return (
      <nav
        aria-label="Search"
        className="flex h-full min-h-0 flex-col overflow-hidden"
      >
        <SearchSection />
      </nav>
    )
  }

  // The workspace's workflows, in the sections' place for the reason Search
  // is: a list worth the whole height. What it holds is its store's.
  if (view === "workflows") {
    return (
      <nav
        aria-label="Workflows"
        className="flex h-full min-h-0 flex-col overflow-hidden"
      >
        <WorkflowsSection />
      </nav>
    )
  }

  return (
    <nav
      aria-label="Workspace"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {/* Search was the first row here, and Settings a footer under the list.
          Both are the window's rather than the workspace's, and moved to the
          title bar's command field and the `NavRail` beside this column. */}

      {/*
        Open sections share what is left over, each scrolling inside itself.

        Even shares rather than sized to their contents: a column cannot both
        fit its contents and fill its height, and of the two answers this is the
        one where a long list of requests cannot push the projects off the
        bottom. A folded section is its header and nothing else, so folding two
        of them gives the third the column — which is also what one section on
        its own gets, for free.
      */}
      <div className="flex min-h-0 flex-1 flex-col">
        {SIDEBAR_SECTIONS.map((section) => (
          <Section
            key={section}
            id={section}
            onAddFolder={onAddFolder}
            // Folding is only meaningful against a neighbour. On its own a
            // section is always open, whatever a previous run left in
            // `shutSections` — a column that came back empty because the one
            // list in it had been folded months ago is a column that reads as
            // broken.
            open={alone || !shut.includes(section)}
            fold={!alone}
          />
        ))}
      </div>
    </nav>
  )
}

/** What each section is called, in the column and in its own header. */
const TITLES: Record<SidebarSection, string> = {
  projects: "Projects",
}

/**
 * One section: its panel, or — folded — the panel's header on its own.
 *
 * The panel is **unmounted** while folded, unlike the dock, and it can be: none
 * of these holds anything a remount would lose — no pty, no turn in flight, no
 * editor. What they hold is a store each, which outlives the component. So a
 * folded section is a header this column draws instead, which is also why the
 * panel's own buttons are not on it: `New request` belongs to the list, and the
 * list is not there.
 *
 * `fold` off is the header without a chevron — the shape every panel's header
 * had before this column stacked them, and the shape it goes back to while
 * `Projects` is the only section drawn.
 */
function Section({
  id,
  open,
  fold: folds,
  onAddFolder,
}: {
  id: SidebarSection
  open: boolean
  fold: boolean
  /** Only `projects` has anything to do with this — see `ProjectsSection`. */
  onAddFolder: () => void
}) {
  const toggleSection = useProjects((state) => state.toggleSection)
  const fold: Fold | undefined = folds
    ? { open, onToggle: () => toggleSection(id) }
    : undefined

  if (!open) return <PanelHeader title={TITLES[id]} {...fold} />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {id === "projects" ? (
        <>
          {/* Projects has no panel component of its own to hand the fold to —
              it is this column's own list — so its header is drawn here. */}
          <PanelHeader title={TITLES.projects} {...fold}>
            {/* The `+` every other section's header carries, doing the same
                thing: `Add a database` opens that panel's dialog, this opens
                the workbench's Add folder one — the same dialog the Explorer's
                tree and the File menu ask for, because a project *is* a folder
                in the workspace and two ways in that behaved differently would
                be two ideas of what adding one means.

                Only on the open header. A folded section is a header this
                column draws instead, and a button that adds to a list nobody
                can see is a button that answers nothing. */}
            <IconButton label="Add project" onClick={onAddFolder}>
              <Plus />
            </IconButton>
          </PanelHeader>
          <div className="min-h-0 flex-1">
            <ProjectsSection />
          </div>
        </>
      ) : null}
    </div>
  )
}

import { useState, type MouseEvent, type ReactNode } from "react"
import { ChevronRight, Copy, Folder, Minus, Plus, Undo2 } from "lucide-react"

import type { GitChange } from "@shared/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  changeTree,
  changesUnder,
  type ChangeTreeNode,
} from "@/lib/files/change-tree"
import { splitChanges, useChanges } from "@/lib/files/changes"
import { GIT_LABELS, GIT_LETTERS, GIT_TONES } from "@/lib/files/git-status"
import { nameOf } from "@/lib/files/paths"
import type { FileRoot } from "@/lib/files/roots"
import { useFiles } from "@/lib/files/store"
import { useStudio } from "@/lib/store"
import { cn } from "@/lib/utils"
import { FileIcon } from "../file-icon"
import { SideRow } from "../side-row"
import { CommitBox } from "./commit-box"

/**
 * The changed files of one checkout — the Explorer's `Changes` tab.
 *
 * The tree answers "what is in this checkout", which is thousands of rows most
 * of which nobody is thinking about; this answers "and what have I done to it",
 * which after an agent has run a turn is the often the only question worth
 * asking.
 *
 * **It is a folder tree, the shape a pull request is read in everywhere else.**
 * It was a flat list of one line each — the directory dimmed ahead of the name
 * — on the argument that a turn's changes are a dozen files scattered through
 * the checkout and a tree of them would be mostly folders. That holds at four
 * rows and stops holding at twenty, where `src/renderer/components/studio/`
 * runs down the column and the thing being scanned for — which *area* was
 * touched — has to be reassembled by eye. `lib/files/change-tree.ts` builds the
 * rows and folds a chain of single-child directories into one, so the tree
 * costs a level of indentation only where the work actually branched.
 *
 * A row opens **the checkout's one diff tab** rather than a tab of its own, so
 * reviewing twelve files is twelve clicks and one tab. That distinction is the
 * whole reason this list is allowed back into the sidebar: the one it replaced
 * opened a file tab per row, and reading a turn's work ended in closing tabs
 * afterwards.
 *
 * It does not read anything either. The list is drawn wherever this is, but the
 * count on the tab above it has to be right while the *tree* is showing, so
 * `useWatchChanges` is called by the panel rather than from here.
 *
 * **Staging and discarding are here.** They are the two sentences somebody says
 * while reading a turn's work — keep this, throw that away — so they belong on
 * the list that work is read in. A directory row does the same to everything
 * under it, which is what the tree buys beyond legibility: `Stage` on one
 * folder rather than on its nine files. Committing is not here at all; the dock
 * has a shell in the same folder, and a commit message is something somebody
 * writes.
 *
 * Two ways to reach them, and the first is the one somebody already knows: the
 * buttons that appear on a row, and on a pile's heading, under the pointer —
 * the Source Control gesture, `+` to stage and `↩` to throw away. They are
 * **siblings** of the row rather than children of it, positioned over its
 * right-hand end, because a `SideRow` is a `<button>` and a button inside a
 * button is dropped by the browser (the same wall the Explorer's rename field
 * ran into). The right-click menu is the second way and the fuller one: it
 * carries `Copy path` and the whole-checkout actions, and it is what a row
 * reached by keyboard has.
 */
export function ChangesList({ root }: { root: FileRoot }) {
  const changes = useChanges((state) => state.byRoot[root.id])
  const loading = useChanges((state) => state.loading.includes(root.id))

  /** Which row the menu is about, or null for the list as a whole — the same
   * shape the tree's one menu uses, and for the same reason: a trigger per row
   * is a trigger inside a trigger. */
  const [target, setTarget] = useState<RowTarget | null>(null)
  const [discarding, setDiscarding] = useState<RowTarget | "all" | null>(null)

  /** Both piles start folded, so a checkout arrives as two counts rather than as
   * however many rows a turn happened to touch. The headings keep their own
   * actions while folded — `Stage all` is the one thing somebody wants without
   * reading the rows first. */
  const [open, setOpen] = useState({ staged: false, unstaged: false })

  /**
   * Which **directory** rows are shut, keyed `<pile>:<tree id>`.
   *
   * The shut ones rather than the open ones, because a tree that arrives
   * collapsed is a tree whose files have to be clicked out of hiding — the
   * files are the point here, unlike in `All files`, where a checkout has
   * thousands of them. A pile that has just been opened shows every change in
   * it. Keyed by pile, since one path can be a row in both.
   */
  const [shut, setShut] = useState<string[]>([])

  if (changes === undefined) {
    // Only before the first answer. A re-read behind a list already on screen
    // says nothing — the rows are still true until they are replaced.
    return loading ? <Note>Reading…</Note> : null
  }

  if (changes.length === 0) {
    return <Note>Nothing has changed in this checkout.</Note>
  }

  const { staged, unstaged } = splitChanges(changes)

  const nodes = (pile: string, rows: GitChange[]) => (
    <ul>
      <Nodes
        nodes={changeTree(rows, root.path)}
        pile={pile}
        root={root}
        indent={0}
        shut={shut}
        onFold={(key) =>
          setShut((state) =>
            state.includes(key)
              ? state.filter((entry) => entry !== key)
              : [...state, key]
          )
        }
        onMenu={setTarget}
        onDiscard={setDiscarding}
      />
    </ul>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            // The full height of the scroller it sits in, so the empty space
            // under the last row belongs to this menu rather than to nothing —
            // that space is where `Stage all` is right-clicked, and a trigger
            // sized to its rows would leave it dead.
            className="min-h-full"
            onContextMenu={(event: MouseEvent) => {
              // Only that empty space: a row has already set the target by the
              // time this is reached.
              if (event.target === event.currentTarget) setTarget(null)
            }}
          />
        }
      >
        {/*
         * A heading per pile that has anything in it, and none for a pile that
         * has not.
         *
         * A `Changes` heading inside the `Changes` tab is the panel's own name
         * said twice, which was the argument for showing these only once
         * something was staged — and it lost to what the heading now carries:
         * the actions for the whole pile, which is where somebody arriving from
         * a Source Control panel reaches for `Stage all`. A heading that
         * appears only in some states is an action that appears only in some
         * states.
         */}
        {/* Above the piles, where a Source Control panel puts it, and only
            while there is something staged for it to commit — see
            `CommitBox`. */}
        {staged.length > 0 && <CommitBox root={root} />}

        {staged.length > 0 && (
          <>
            <Heading
              label="Staged"
              count={staged.length}
              open={open.staged}
              onToggle={() =>
                setOpen((state) => ({ ...state, staged: !state.staged }))
              }
            >
              <RowAction
                label={"Unstage everything"}
                onClick={() => {
                  void useChanges.getState().unstage(
                    root,
                    staged.map((change) => change.path)
                  )
                }}
              >
                <Minus />
              </RowAction>
            </Heading>
            {open.staged && nodes("staged", staged)}
          </>
        )}

        {unstaged.length > 0 && (
          <>
            <Heading
              label="Changes"
              count={unstaged.length}
              open={open.unstaged}
              onToggle={() =>
                setOpen((state) => ({ ...state, unstaged: !state.unstaged }))
              }
            >
              <RowAction
                label={"Discard every change in this checkout"}
                onClick={() => setDiscarding("all")}
              >
                <Undo2 />
              </RowAction>
              <RowAction
                label={"Stage everything"}
                onClick={() => {
                  void useChanges.getState().stage(
                    root,
                    unstaged.map((change) => change.path)
                  )
                }}
              >
                <Plus />
              </RowAction>
            </Heading>
            {open.unstaged && nodes("unstaged", unstaged)}
          </>
        )}
      </ContextMenuTrigger>

      <ContextMenuContent className="w-56">
        {target && (
          <>
            {target.staged ? (
              <ContextMenuItem
                onClick={() => {
                  void useChanges.getState().unstage(root, target.paths)
                }}
              >
                <Minus />
                Unstage
              </ContextMenuItem>
            ) : (
              <ContextMenuItem
                onClick={() => {
                  void useChanges.getState().stage(root, target.paths)
                }}
              >
                <Plus />
                Stage
              </ContextMenuItem>
            )}
            <ContextMenuItem
              variant="destructive"
              onClick={() => setDiscarding(target)}
            >
              <Undo2 />
              Discard changes…
            </ContextMenuItem>
            {/* A directory row has no path to copy: the folders in this tree
                exist because a file's path passed through them, and this
                renderer does not build paths — see `lib/files/paths.ts`. */}
            {target.path && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() =>
                    void navigator.clipboard.writeText(target.path as string)
                  }
                >
                  <Copy />
                  Copy path
                </ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
          </>
        )}

        {/* The whole checkout, and reachable from a row's menu as well: a list
            long enough for `Discard all` to be worth wanting is one with no
            empty space left to right-click. */}
        <ContextMenuItem
          disabled={unstaged.length === 0}
          onClick={() => {
            void useChanges.getState().stage(
              root,
              unstaged.map((change) => change.path)
            )
          }}
        >
          <Plus />
          Stage all
        </ContextMenuItem>
        <ContextMenuItem
          disabled={staged.length === 0}
          onClick={() => {
            void useChanges.getState().unstage(
              root,
              staged.map((change) => change.path)
            )
          }}
        >
          <Minus />
          Unstage all
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onClick={() => setDiscarding("all")}
        >
          <Undo2 />
          Discard all changes…
        </ContextMenuItem>
      </ContextMenuContent>

      <DiscardDialog
        target={discarding}
        root={root}
        count={new Set(changes.map((change) => change.path)).size}
        onClose={() => setDiscarding(null)}
      />
    </ContextMenu>
  )
}

/**
 * What a row's actions and its menu are about — a file, or a folder and
 * everything under it.
 *
 * One shape for both, because staging, unstaging and discarding all take a list
 * of paths already: a directory row is the same three calls with nine paths
 * instead of one. `path` is what only a file has — the thing `Copy path` copies
 * and the name the discard dialog says.
 */
type RowTarget = {
  label: string
  paths: string[]
  staged: boolean
  path: string | null
}

/** One level of the tree. Recursive, and deliberately not flattened first: the
 * fold state is per directory, and a flattened list would have to be rebuilt on
 * every fold. */
function Nodes({
  nodes,
  pile,
  root,
  indent,
  shut,
  onFold,
  onMenu,
  onDiscard,
}: {
  nodes: ChangeTreeNode[]
  pile: string
  root: FileRoot
  indent: number
  shut: string[]
  onFold: (key: string) => void
  onMenu: (target: RowTarget) => void
  onDiscard: (target: RowTarget) => void
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return (
            <ChangeRow
              key={node.id}
              change={node.change}
              root={root}
              indent={indent}
              onMenu={onMenu}
              onDiscard={onDiscard}
            />
          )
        }

        const key = `${pile}:${node.id}`
        const open = !shut.includes(key)

        return (
          <li key={key}>
            <DirRow
              node={node}
              root={root}
              indent={indent}
              open={open}
              staged={pile === "staged"}
              onToggle={() => onFold(key)}
              onMenu={onMenu}
              onDiscard={onDiscard}
            />
            {open && (
              <ul>
                <Nodes
                  nodes={node.children}
                  pile={pile}
                  root={root}
                  indent={indent + 1}
                  shut={shut}
                  onFold={onFold}
                  onMenu={onMenu}
                  onDiscard={onDiscard}
                />
              </ul>
            )}
          </li>
        )
      })}
    </>
  )
}

/**
 * A folder in the tree: the chevron and the collapsed name.
 *
 * **No state letter and no `+`/`−`.** A folder holding an added file and a
 * deleted one has no single state, so picking one would be the row asserting
 * something git did not say. The summed counts were the honest answer to that
 * and were drawn for a while, then removed: down a chain of folders they are a
 * second column of numbers beside the one that answers the question being asked
 * — which *file* changed, and by how much — and the file rows say that already.
 */
function DirRow({
  node,
  root,
  indent,
  open,
  staged,
  onToggle,
  onMenu,
  onDiscard,
}: {
  node: Extract<ChangeTreeNode, { kind: "dir" }>
  root: FileRoot
  indent: number
  open: boolean
  staged: boolean
  onToggle: () => void
  onMenu: (target: RowTarget) => void
  onDiscard: (target: RowTarget) => void
}) {
  const under = changesUnder(node)
  const target: RowTarget = {
    label: node.label,
    paths: under.map((change) => change.path),
    staged,
    path: null,
  }

  return (
    <div className="group/row relative">
      <SideRow
        indent={indent}
        title={`${node.label} — ${under.length} changed ${under.length === 1 ? "file" : "files"}`}
        onContextMenu={() => onMenu(target)}
        onClick={onToggle}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left text-xs">
          {node.label}
        </span>
      </SideRow>

      <RowActions target={target} root={root} onDiscard={onDiscard} />
    </div>
  )
}

/**
 * The one dialog in this panel, because this is the one action here that
 * destroys work.
 *
 * It says where the work goes, and the two halves are genuinely different: what
 * git has a copy of goes back to `HEAD` and can be found again in the
 * repository, while a file that was never committed has no copy anywhere and is
 * moved to the trash — the same promise the Explorer's Delete makes, and the
 * reason neither of them unlinks anything.
 */
function DiscardDialog({
  target,
  root,
  count,
  onClose,
}: {
  target: RowTarget | "all" | null
  root: FileRoot
  count: number
  onClose: () => void
}) {
  const row = target === "all" ? null : target
  const all = target === "all"
  // A folder row, which is the one case that discards many paths at once.
  const one = row !== null && row.paths.length === 1

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next: boolean) => {
        if (!next) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {all
              ? `Discard every change in ${root.label}?`
              : one
                ? `Discard changes to “${row?.label}”?`
                : `Discard ${row?.paths.length} changes in “${row?.label}”?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {all
              ? `All ${count} changed ${count === 1 ? "file" : "files"} go back to the last commit. Files that were never committed are moved to the trash. Nothing staged is kept.`
              : one
                ? "The file goes back to the last commit — the staged copy and the edits on disk both. A file that was never committed is moved to the trash instead, since there is nothing to go back to."
                : "Every changed file in this folder goes back to the last commit — the staged copies and the edits on disk both. Files that were never committed are moved to the trash instead, since there is nothing to go back to."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              const changes = useChanges.getState()
              if (all) void changes.discardAll(root)
              else if (target) void changes.discard(root, target.paths)
              onClose()
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ChangeRow({
  change,
  root,
  indent,
  onMenu,
  onDiscard,
}: {
  change: GitChange
  root: FileRoot
  indent: number
  onMenu: (target: RowTarget) => void
  onDiscard: (target: RowTarget) => void
}) {
  // Both rows of a file that is staged and edited again are marked: the diff on
  // screen is that file, and marking one of the two would be picking a side the
  // pane is not taking.
  const active = useChanges(
    (state) => state.selectedPath[root.id] === change.path
  )

  const target: RowTarget = {
    label: nameOf(change.path),
    paths: [change.path],
    staged: change.staged,
    path: change.path,
  }

  return (
    <li className="group/row relative">
      <SideRow
        active={active}
        indent={indent}
        title={
          change.directory
            ? `${change.path}/ — a ${GIT_LABELS[change.state]} folder, everything in it. Opens in All files.`
            : `${change.path} — ${GIT_LABELS[change.state]}${change.staged ? ", staged" : ""}`
        }
        onContextMenu={() => onMenu(target)}
        onClick={() => {
          /*
           * A folder is not a diff, so it goes to the tree instead.
           *
           * Git reports a wholly untracked directory as one entry, and the row
           * for it used to open the checkout's diff tab on a path that is not a
           * file — an empty pane, with nothing saying why. The tree is where a
           * directory's contents are, so that is where the row leads: the `All
           * files` tab, revealed and opened. It is a leaf of this tree rather
           * than a folder in it for the same reason: git named one path, and
           * what is under it was never listed.
           */
          if (change.directory) {
            useStudio.getState().setExplorerTab("files")
            void useFiles
              .getState()
              .reveal(change.path)
              .then(() => {
                const files = useFiles.getState()
                if (!files.expanded.includes(change.path))
                  files.toggle(change.path)
              })
            return
          }

          // And the tab it opens is the checkout's one diff tab, not a tab of
          // this file's own.
          useChanges.getState().openPath(root.id, change.path)
          // And nothing else: the pane draws a file as a diff by asking for it
          // (`preferred` on `FilePane`), not by this writing `views` on the way
          // past. That write was a frame behind the path — the pane rendered the
          // new file as its own default viewer first, which for a `.md` is the
          // markdown preview — and a click that flickers through another view
          // is the one thing a review list must not do. `Diff | Edit` in the
          // header is still what changes it, and still writes `views`.
        }}
      >
        {/*
         * The name alone — the directory it is in is the row above it now, so
         * there is nothing to truncate from the left any more. `text-left`
         * because a `<button>` centres its text by the browser's own
         * stylesheet, which Tailwind's preflight does not reset; this child
         * grows, so unlike most `SideRow`s there is space for the alignment to
         * distribute.
         */}
        {/* `gap-1.5` and `size-3.5` are `SIDE_ROW_SHAPE`'s own two numbers, so
            a folder-leaf row and a file row put their labels in the same
            place. */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left">
          {/*
           * The file-type icon the tree and the strip draw, so the same `.ts` is
           * the same icon wherever it is listed — and the row is scannable by
           * kind before its name is read, which after a turn touching thirty
           * files is most of what this list is for. It is **not** tinted by the
           * git state: the vendored icons are full colour, the name beside it
           * carries the state, and the `+`/`−` at the end says it a third time.
           *
           * A wholly untracked directory keeps the folder glyph instead, in the
           * git colour: it is the one row here that is not a file, and that is
           * the difference between `public/images/building` read as a file and
           * read as the directory it is. The trailing `/` says it again for
           * anybody reading the text alone.
           */}
          {change.directory ? (
            <Folder
              aria-hidden
              className={cn("size-3.5 shrink-0", GIT_TONES[change.state])}
            />
          ) : (
            <FileIcon filePath={change.path} className="size-3.5" />
          )}
          <span className={cn("truncate text-xs", GIT_TONES[change.state])}>
            {nameOf(change.path)}
            {change.directory && "/"}
          </span>
        </span>

        {/* The letter and the counts travel together at the end, as the tree
            puts its letter at the end of a row — and step aside for the
            actions while the row is hovered, rather than being covered by
            them. `invisible` and not `hidden`: the row's width must not change
            under the pointer, or the name reflows as the cursor arrives. */}
        <span
          aria-hidden
          className={cn(
            "flex shrink-0 items-center gap-1.5 group-focus-within/row:invisible group-hover/row:invisible",
            GIT_TONES[change.state]
          )}
        >
          <span className="text-center font-mono text-[0.65rem]">
            {GIT_LETTERS[change.state]}
          </span>
          <Counts change={change} />
        </span>
      </SideRow>

      <RowActions target={target} root={root} onDiscard={onDiscard} />
    </li>
  )
}

/**
 * The stage and discard buttons that appear on a row under the pointer — the
 * gesture somebody arrives from a Source Control panel already knowing.
 *
 * **Beside the row in the DOM, on top of it on screen.** A `SideRow` is a
 * `<button>`, and a button inside a button is not markup a browser will honour
 * — the inner one is dropped and the click lands on the row. So these are a
 * sibling, positioned over the row's right-hand end, where the letter and the
 * counts have just made room for them. The row underneath keeps its whole
 * width, so clicking anywhere else on it still opens the diff — or folds the
 * directory.
 *
 * `opacity` rather than `hidden`, and `pointer-events-none` with it: a button
 * that is merely transparent would still swallow the click meant for the row
 * beneath it. `group-focus-within` is the same treatment for a keyboard, which
 * has no pointer to hover with — Tab reaches them and they become visible as it
 * does, rather than being a feature only a mouse can find. The right-click menu
 * is still the third way, and the one that carries `Copy path` and the
 * whole-checkout actions.
 */
function RowActions({
  target,
  root,
  onDiscard,
}: {
  target: RowTarget
  root: FileRoot
  onDiscard: (target: RowTarget) => void
}) {
  const what = target.path ? target.label : `everything in ${target.label}`

  return (
    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
      {/* Discard first, stage last: the one that ends nearest the pointer's
          resting place is the one pressed most, and staging is that. The
          destructive one is the one that has to be reached for — and it opens
          the dialog rather than acting, which is the other half of that. */}
      {!target.staged && (
        <RowAction
          label={`Discard changes to ${what}`}
          onClick={() => onDiscard(target)}
        >
          <Undo2 />
        </RowAction>
      )}
      {target.staged ? (
        <RowAction
          label={`Unstage ${what}`}
          onClick={() => {
            void useChanges.getState().unstage(root, target.paths)
          }}
        >
          <Minus />
        </RowAction>
      ) : (
        <RowAction
          label={`Stage ${what}`}
          onClick={() => {
            void useChanges.getState().stage(root, target.paths)
          }}
        >
          <Plus />
        </RowAction>
      )}
    </span>
  )
}

/** One of those buttons. Sized to the row rather than to the icon buttons in
 * the panel's header: this sits inside a 24px row, where the header's are on a
 * 36px bar. */
function RowAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // The row under it is a button too, and a click here is not a click on
      // the row: without this the diff tab opens behind every stage.
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="flex size-4.5 items-center justify-center rounded-sm text-muted-foreground hover:bg-background/80 hover:text-foreground [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

/**
 * `+112 −8`, in the tree's own green and red.
 *
 * Nothing at all when there is no honest number — a binary file, or a new file
 * too large to have counted (see `MAX_COUNTED_NEW_FILES` in `main/git.ts`). A
 * zero is drawn: `+0 −0` is a real answer for a file whose only change is its
 * mode or its line endings, and it is the row that would otherwise look like a
 * bug.
 */
function Counts({ change }: { change: GitChange }) {
  if (change.added === null || change.removed === null) return null

  return (
    <span className="shrink-0 font-mono text-[0.65rem] tabular-nums">
      <span className={GIT_TONES.added}>+{change.added}</span>{" "}
      <span className={GIT_TONES.deleted}>−{change.removed}</span>
    </span>
  )
}

/**
 * A pile's name and how many are in it, with the pile's own actions at the end —
 * and the control that folds the pile away.
 *
 * At the weight of a label rather than of a title: this divides a list, it does
 * not head a panel — the panel's heading is the two tabs above. The actions
 * follow the same rule as a row's and appear under the pointer, so a heading
 * somebody is not using is two words and a number.
 *
 * The whole heading is the toggle, not just the chevron — a 12px target is not
 * one. It is a `<button>`, so the pile's actions stay a positioned **sibling**
 * for the same reason a row's are: a button inside a button is dropped by the
 * browser.
 */
function Heading({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="group/row relative flex h-6 items-center px-3 pt-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="flex-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums group-focus-within/row:invisible group-hover/row:invisible">
          {count}
        </span>
      </button>
      {/* Over the count, on the same terms as a row's actions — see
          `RowActions` for why they are positioned rather than laid out. */}
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
        {children}
      </span>
    </div>
  )
}

function Note({ children }: { children: string }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>
}

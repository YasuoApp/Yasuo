import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import {
  CaseSensitive,
  ChevronRight,
  FolderDot,
  ListCollapse,
  ListFilter,
  MessageSquare,
  Regex,
  ReplaceAll,
  RotateCw,
  WholeWord,
} from "lucide-react"

import type {
  SearchKinds,
  SearchOptions,
  SearchPreview,
  WorkspaceSearch,
} from "@shared/api"
import { matcherOf, previewReplacement } from "@shared/search"
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
import { cn } from "@/lib/utils"
import { nameOf } from "@/lib/files/paths"
import { revealAt } from "@/lib/files/typescript"
import { useProjects } from "@/lib/projects"
import { useStudio } from "@/lib/store"
import { useWorkspaceSearch, type SearchKind } from "@/lib/workspace-search"
import { useWorktreeChats } from "@/lib/worktree-chat/store"
import { FileIcon } from "./file-icon"
import { IconButton } from "./icon-button"
import { PanelHeader } from "./panel-header"
import { SIDE_ROW_SHAPE, sideRowIndent } from "./side-row"

/**
 * The left column's Search: `Find in files` the way the editors draw it — a
 * field with `Aa` / `ab` / `.*`, and the results grouped by where they are,
 * each line a row that opens on the match.
 *
 * Over the **contents** of the workspace, where `⌘P` is over its names: every
 * file under every folder, and what was said in every chat — the one half an
 * editor cannot answer. A file row opens the file with the match selected
 * (`revealAt`, the jump go-to-definition uses); a chat row opens the chat with
 * its `⌘F` bar already on that occurrence (`landing`, taken by the chat pane).
 *
 * The rows are one flat list (`rowsOf`) drawn in order, so the arrow keys walk
 * exactly what is on screen and nothing has to know how deep a row is nested.
 */
export function SearchSection() {
  const query = useWorkspaceSearch((state) => state.query)
  const options = useWorkspaceSearch((state) => state.options)
  const scope = useWorkspaceSearch((state) => state.scope)
  const filtersOpen = useWorkspaceSearch((state) => state.filtersOpen)
  const replaceOpen = useWorkspaceSearch((state) => state.replaceOpen)
  const replacement = useWorkspaceSearch((state) => state.replacement)
  const replacing = useWorkspaceSearch((state) => state.replacing)
  const notice = useWorkspaceSearch((state) => state.notice)
  const result = useWorkspaceSearch((state) => state.result)
  const searching = useWorkspaceSearch((state) => state.searching)
  const focused = useWorkspaceSearch((state) => state.focused)
  const shut = useWorkspaceSearch((state) => state.shut)
  const shutKinds = useWorkspaceSearch((state) => state.shutKinds)
  const {
    setQuery,
    toggleOption,
    setScope,
    toggleFilters,
    toggleReplace,
    setReplacement,
    replace,
    run,
    toggleGroup,
    toggleKind,
    toggleAll,
  } = useWorkspaceSearch.getState()
  const folders = useStudio((state) => state.folders)
  const activeFolderId = useProjects((state) => state.activeFolderId)

  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [focused])

  const [cursor, setCursor] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const nameOfFolder = (folderId: string | null) =>
    folders.find((folder) => folder.id === folderId)?.name
  // Only worth saying which project a file is in when there is more than one.
  const several = folders.length > 1

  const fileMatches =
    result?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0
  const chatMatches =
    result?.chats.reduce((sum, chat) => sum + chat.matches.length, 0) ?? 0

  // Built here as well as in main, for the replace preview alone: the rows
  // draw what each match would become as the replace field is typed.
  const built = useMemo(() => matcherOf(query, options), [query, options])
  const preview =
    replaceOpen && built && "matcher" in built
      ? (text: string, from: number) =>
          previewReplacement(
            text,
            from,
            built.matcher,
            replacement,
            options.regex
          )
      : undefined

  const rows = useMemo(
    () =>
      result
        ? rowsOf(result, {
            shut,
            shutKinds,
            folderName: nameOfFolder,
            several,
          })
        : [],
    // `nameOfFolder` reads `folders`, which is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, shut, shutKinds, folders, several]
  )
  const at = rows.findIndex((row) => row.key === cursor)

  // The row under the cursor kept on screen as the keys walk past the edge.
  useEffect(() => {
    if (!cursor) return
    list.current
      ?.querySelector(`[data-row="${CSS.escape(cursor)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [cursor])

  function openRow(row: Row) {
    setCursor(row.key)
    if (row.type === "kind") toggleKind(row.kind)
    else if (row.type === "group") toggleGroup(row.group)
    else if (row.chatId) {
      useWorkspaceSearch.getState().land({
        chatId: row.chatId,
        messageId: row.messageId,
        offset: row.offset,
        length: row.length,
      })
      useWorktreeChats.getState().select(row.chatId)
    } else revealAt(row.path, row.line, row.column, row.length)
  }

  /*
   * `F4` / `⇧F4` — the next and previous match, opened, the editors' keys for
   * stepping through a search's results from wherever the caret is. Bound only
   * while this section is mounted, which is while the column shows Search, and
   * never inside the dock's shell, whose function keys are the program's.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "F4" || event.metaKey || event.ctrlKey) return
      if (event.altKey) return
      if (event.target instanceof HTMLElement && event.target.closest(".xterm"))
        return
      const lines = rows.filter((row) => row.type === "line")
      if (lines.length === 0) return
      event.preventDefault()
      const from = lines.findIndex((row) => row.key === cursor)
      const step = event.shiftKey ? -1 : 1
      const next =
        from === -1
          ? event.shiftKey
            ? lines.length - 1
            : 0
          : (from + step + lines.length) % lines.length
      const row = lines[next]
      if (row) openRow(row)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  })

  function onListKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const row = rows[at]
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault()
        const next = rows[Math.min(at + 1, rows.length - 1)]
        if (next) setCursor(next.key)
        break
      }
      case "ArrowUp": {
        event.preventDefault()
        if (at <= 0) {
          field.current?.focus()
          setCursor(null)
          break
        }
        const next = rows[at - 1]
        if (next) setCursor(next.key)
        break
      }
      case "ArrowRight":
        if (row && row.type !== "line" && !row.open) {
          event.preventDefault()
          openRow(row)
        }
        break
      case "ArrowLeft":
        event.preventDefault()
        if (!row) break
        if (row.type !== "line" && row.open) openRow(row)
        else if (row.type === "line") setCursor(row.parent)
        break
      case "Enter":
      case " ":
        if (!row) break
        event.preventDefault()
        openRow(row)
        break
      case "Home":
        event.preventDefault()
        if (rows[0]) setCursor(rows[0].key)
        break
      case "End":
        event.preventDefault()
        if (rows.length > 0) setCursor(rows[rows.length - 1]!.key)
        break
    }
  }

  const replaceable = replaceOpen && fileMatches > 0 && !replacing
  const filtered = scope.include.trim() !== "" || scope.exclude.trim() !== ""

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="Search">
        <IconButton label="Search again" onClick={run} disabled={!query}>
          <RotateCw />
        </IconButton>
        <IconButton
          label="Collapse all"
          onClick={toggleAll}
          disabled={!result || (fileMatches === 0 && chatMatches === 0)}
        >
          <ListCollapse />
        </IconButton>
      </PanelHeader>

      <div className="shrink-0 space-y-1.5 border-b p-2">
        <div className="flex gap-1">
          {/* The disclosure for Replace, the search field's height and level
              with it: stretched down the pair, it read as a bar. */}
          <IconButton
            label={replaceOpen ? "Hide replace" : "Replace"}
            onClick={toggleReplace}
            aria-expanded={replaceOpen}
            className="size-7 shrink-0 [&_svg]:size-3.5"
          >
            <ChevronRight
              className={cn("transition-transform", replaceOpen && "rotate-90")}
            />
          </IconButton>

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex h-7 items-center rounded-md border bg-background pr-0.5 focus-within:ring-1 focus-within:ring-ring">
              <input
                ref={field}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    run()
                  }
                  if (event.key === "Escape" && query) {
                    event.preventDefault()
                    setQuery("")
                  }
                  if (event.key === "ArrowDown" && rows.length > 0) {
                    event.preventDefault()
                    setCursor(rows[0]!.key)
                    list.current?.focus()
                  }
                }}
                placeholder="Search files and chats"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground"
              />
              <Toggle
                option="matchCase"
                label="Match case"
                options={options}
                onToggle={toggleOption}
              >
                <CaseSensitive />
              </Toggle>
              <Toggle
                option="wholeWord"
                label="Match whole word"
                options={options}
                onToggle={toggleOption}
              >
                <WholeWord />
              </Toggle>
              <Toggle
                option="regex"
                label="Use regular expression"
                options={options}
                onToggle={toggleOption}
              >
                <Regex />
              </Toggle>
            </div>

            {replaceOpen && (
              <div className="flex h-7 items-center rounded-md border bg-background pr-0.5 focus-within:ring-1 focus-within:ring-ring">
                <input
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey) &&
                      replaceable
                    ) {
                      event.preventDefault()
                      setConfirming(true)
                    }
                  }}
                  placeholder={
                    options.regex ? "Replace — $1, $<name>, $&" : "Replace"
                  }
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground"
                />
                <IconButton
                  label="Replace all in files (⌘↵)"
                  onClick={() => setConfirming(true)}
                  disabled={!replaceable}
                  className="size-6 [&_svg]:size-3.5"
                >
                  <ReplaceAll />
                </IconButton>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <KindSwitch
            value={scope.kinds}
            onChange={(kinds) => setScope({ kinds })}
          />
          <span className="flex-1" />
          <IconButton
            label={
              scope.thisProject
                ? `Only ${nameOfFolder(activeFolderId) ?? "this project"}`
                : "Search only this project"
            }
            pressed={scope.thisProject}
            onClick={() => setScope({ thisProject: !scope.thisProject })}
            className={cn(
              "size-6 [&_svg]:size-3.5",
              scope.thisProject && "bg-accent text-accent-foreground"
            )}
          >
            <FolderDot />
          </IconButton>
          <IconButton
            label={
              filtersOpen ? "Hide file filters" : "Files to include/exclude"
            }
            pressed={filtersOpen || filtered}
            onClick={toggleFilters}
            className={cn(
              "size-6 [&_svg]:size-3.5",
              (filtersOpen || filtered) && "bg-accent text-accent-foreground"
            )}
          >
            <ListFilter />
          </IconButton>
        </div>

        {filtersOpen && (
          <div className="space-y-1">
            <GlobField
              label="files to include"
              value={scope.include}
              placeholder="e.g. src/**, *.ts"
              disabled={scope.kinds === "chats"}
              onChange={(include) => setScope({ include })}
            />
            <GlobField
              label="files to exclude"
              value={scope.exclude}
              placeholder="e.g. **/*.test.ts, dist"
              disabled={scope.kinds === "chats"}
              onChange={(exclude) => setScope({ exclude })}
            />
          </div>
        )}

        <p className="min-h-4 px-0.5 text-[0.7rem] text-muted-foreground">
          {result?.error ? (
            <span className="text-destructive">{result.error}</span>
          ) : notice ? (
            <span className="text-foreground">{notice}</span>
          ) : replacing ? (
            "Replacing…"
          ) : !query ? null : searching && !result ? (
            "Searching…"
          ) : result ? (
            <>
              {summary(
                fileMatches,
                result.files.length,
                chatMatches,
                result.chats.length
              )}
              {result.truncated && " — stopped at the limit, narrow the search"}
              {searching && " · searching…"}
            </>
          ) : null}
        </p>
      </div>

      <div
        ref={list}
        tabIndex={rows.length > 0 ? 0 : -1}
        role="tree"
        aria-label="Search results"
        aria-activedescendant={at >= 0 ? rowId(rows[at]!.key) : undefined}
        onKeyDown={onListKey}
        onFocus={() => {
          if (at === -1 && rows[0]) setCursor(rows[0].key)
        }}
        className="group/list min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        {rows.map((row) => {
          const current = row.key === cursor
          if (row.type === "kind")
            return (
              <Kind
                key={row.key}
                id={row.key}
                current={current}
                label={row.label}
                count={row.count}
                open={row.open}
                onToggle={() => openRow(row)}
              />
            )
          if (row.type === "group")
            return (
              <Group
                key={row.key}
                id={row.key}
                current={current}
                open={row.open}
                onToggle={() => openRow(row)}
                icon={
                  row.path ? (
                    <FileIcon filePath={row.path} />
                  ) : (
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                  )
                }
                name={row.name}
                where={row.where}
                title={row.path}
                count={row.count}
                onReplace={
                  replaceable && row.path
                    ? () => void replace([row.path!])
                    : undefined
                }
              />
            )
          return (
            <Line
              key={row.key}
              id={row.key}
              current={current}
              preview={row.preview}
              replacement={row.chatId ? undefined : preview}
              title={row.chatId ? undefined : `Line ${row.line}`}
              onClick={() => openRow(row)}
            />
          )
        })}

        {result &&
          !result.error &&
          !searching &&
          result.files.length === 0 &&
          result.chats.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Nothing found.
            </p>
          )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace {plural(fileMatches, "occurrence")} in{" "}
              {plural(result?.files.length ?? 0, "file")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every match of{" "}
              <code className="font-mono text-foreground">{query}</code> becomes{" "}
              <code className="font-mono text-foreground">
                {replacement || "nothing"}
              </code>
              , written to disk at once. A file with unsaved edits is skipped,
              and the chats are left as they were said.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                void replace()
              }}
            >
              Replace all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type Row =
  | {
      type: "kind"
      key: string
      kind: SearchKind
      label: string
      count: number
      open: boolean
    }
  | {
      type: "group"
      key: string
      /** What `shut` keys this group by — a file's path or a chat's id. */
      group: string
      open: boolean
      name: string
      where?: string
      /** A file's; a chat group has none. */
      path?: string
      count: number
    }
  | {
      type: "line"
      key: string
      parent: string
      preview: SearchPreview
      path: string
      line: number
      column: number
      length: number
      chatId?: string
      messageId: string
      offset: number
    }

/** What is on screen, top to bottom — chats, then files, as before. */
function rowsOf(
  result: WorkspaceSearch,
  {
    shut,
    shutKinds,
    folderName,
    several,
  }: {
    shut: string[]
    shutKinds: SearchKind[]
    folderName: (folderId: string | null) => string | undefined
    several: boolean
  }
): Row[] {
  const rows: Row[] = []
  const count = (matches: { matches: unknown[] }[]) =>
    matches.reduce((sum, entry) => sum + entry.matches.length, 0)

  if (result.chats.length > 0) {
    const open = !shutKinds.includes("chats")
    rows.push({
      type: "kind",
      key: "kind:chats",
      kind: "chats",
      label: "Chats",
      count: count(result.chats),
      open,
    })
    if (open)
      for (const chat of result.chats) {
        const key = `chat:${chat.chatId}`
        const groupOpen = !shut.includes(chat.chatId)
        rows.push({
          type: "group",
          key,
          group: chat.chatId,
          open: groupOpen,
          name: chat.title,
          where: folderName(chat.folderId),
          count: chat.matches.length,
        })
        // Keyed by place in the group, not by message: a transcript carries the
        // same message id more than once, and two keys alike in one flat list
        // leave React drawing rows from a search long since replaced.
        if (groupOpen)
          for (const [index, match] of chat.matches.entries())
            rows.push({
              type: "line",
              key: `${key}:${index}`,
              parent: key,
              preview: match.preview,
              path: "",
              line: 0,
              column: 0,
              length: match.length,
              chatId: chat.chatId,
              messageId: match.messageId,
              offset: match.offset,
            })
      }
  }

  if (result.files.length > 0) {
    const open = !shutKinds.includes("files")
    rows.push({
      type: "kind",
      key: "kind:files",
      kind: "files",
      label: "Files",
      count: count(result.files),
      open,
    })
    if (open)
      for (const file of result.files) {
        const key = `file:${file.path}`
        const groupOpen = !shut.includes(file.path)
        const dir = file.relative.slice(0, -nameOf(file.relative).length - 1)
        const folder = several ? folderName(file.folderId) : undefined
        rows.push({
          type: "group",
          key,
          group: file.path,
          open: groupOpen,
          name: nameOf(file.relative),
          where: [folder, dir].filter(Boolean).join(" › ") || undefined,
          path: file.path,
          count: file.matches.length,
        })
        if (groupOpen)
          for (const [index, match] of file.matches.entries())
            rows.push({
              type: "line",
              key: `${key}:${index}`,
              parent: key,
              preview: match.preview,
              path: file.path,
              line: match.line,
              column: match.column,
              length: match.length,
              messageId: "",
              offset: 0,
            })
      }
  }

  return rows
}

/** An element id for `aria-activedescendant`, which wants no spaces. */
const rowId = (key: string) =>
  `search-row-${key.replace(/[^\w-]/g, (char) => `_${char.charCodeAt(0)}`)}`

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`

function summary(
  fileMatches: number,
  files: number,
  chatMatches: number,
  chats: number
): string {
  const parts: string[] = []
  if (chats > 0)
    parts.push(`${plural(chatMatches, "result")} in ${plural(chats, "chat")}`)
  if (files > 0)
    parts.push(`${plural(fileMatches, "result")} in ${plural(files, "file")}`)
  return parts.join(", ") || "No results"
}

function Toggle({
  option,
  label,
  options,
  onToggle,
  children,
}: {
  option: keyof SearchOptions
  label: string
  options: SearchOptions
  onToggle: (option: keyof SearchOptions) => void
  children: ReactNode
}) {
  const on = options[option]
  return (
    <IconButton
      label={label}
      pressed={on}
      onClick={() => onToggle(option)}
      className={cn(
        "size-6 [&_svg]:size-3.5",
        on && "bg-accent text-accent-foreground"
      )}
    >
      {children}
    </IconButton>
  )
}

const KINDS: { value: SearchKinds; label: string }[] = [
  { value: "all", label: "All" },
  { value: "chats", label: "Chats" },
  { value: "files", label: "Files" },
]

/** Which half is searched. A segmented control rather than two toggles, since
 * both off is not a search. */
function KindSwitch({
  value,
  onChange,
}: {
  value: SearchKinds
  onChange: (kinds: SearchKinds) => void
}) {
  return (
    <div role="radiogroup" className="flex h-6 rounded-md border p-0.5">
      {KINDS.map((kind) => (
        <button
          key={kind.value}
          type="button"
          role="radio"
          aria-checked={value === kind.value}
          onClick={() => onChange(kind.value)}
          className={cn(
            "rounded-sm px-1.5 text-[0.65rem] text-muted-foreground transition-colors hover:text-foreground",
            value === kind.value && "bg-accent text-accent-foreground"
          )}
        >
          {kind.label}
        </button>
      ))}
    </div>
  )
}

function GlobField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="block space-y-0.5">
      <span className="px-0.5 text-[0.65rem] text-muted-foreground">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-6 w-full rounded-md border bg-background px-2 font-mono text-[0.7rem] outline-none placeholder:font-sans placeholder:text-muted-foreground focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
    </label>
  )
}

/** The ring on the keyboard's row, drawn only while the list has focus — a
 * cursor left behind in a list nobody is in reads as a selection. */
const CURSOR = "group-focus/list:ring-1 group-focus/list:ring-ring ring-inset"

/** `Chats` / `Files` above their groups — two kinds of row in one list, each
 * folding away whole, the way a `PanelHeader` folds: the whole label is the
 * target. */
function Kind({
  id,
  current,
  label,
  count,
  open,
  onToggle,
}: {
  id: string
  current: boolean
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      id={rowId(id)}
      data-row={id}
      tabIndex={-1}
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex h-6 w-full items-center gap-1 px-2 pt-1 text-left text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground",
        current && CURSOR
      )}
    >
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-transform",
          open && "rotate-90"
        )}
      />
      <span className="flex-1">{label}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  )
}

function Group({
  id,
  current,
  open,
  onToggle,
  icon,
  name,
  where,
  title,
  count,
  onReplace,
}: {
  id: string
  current: boolean
  open: boolean
  onToggle: () => void
  icon: ReactNode
  name: string
  where?: string
  title?: string
  count: number
  /** Set while Replace is open, for a file's group. */
  onReplace?: () => void
}) {
  return (
    // A row rather than one button, so the replace action beside the count is
    // a button of its own and not one nested in another.
    <div
      id={rowId(id)}
      data-row={id}
      className={cn("group/row relative", current && CURSOR)}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onToggle}
        aria-expanded={open}
        title={title}
        style={sideRowIndent(0)}
        className={cn(SIDE_ROW_SHAPE, "text-left hover:bg-accent/60")}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        {icon}
        <span className="shrink-0 truncate">{name}</span>
        {where && (
          <span className="min-w-0 truncate text-muted-foreground">
            {where}
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[0.65rem] text-muted-foreground tabular-nums",
            onReplace && "group-hover/row:invisible"
          )}
        >
          {count}
        </span>
      </button>
      {onReplace && (
        <IconButton
          label="Replace in this file"
          tabIndex={-1}
          onClick={onReplace}
          className="invisible absolute top-1/2 right-1 size-5 -translate-y-1/2 group-hover/row:visible [&_svg]:size-3.5"
        >
          <ReplaceAll />
        </IconButton>
      )}
    </div>
  )
}

/**
 * One match: its line, with the match itself painted in the find amber — or,
 * while a replacement is typed, struck through beside what it would become.
 */
function Line({
  id,
  current,
  preview,
  replacement,
  title,
  onClick,
}: {
  id: string
  current: boolean
  preview: SearchPreview
  replacement?: (text: string, from: number) => string
  title?: string
  onClick: () => void
}) {
  const match = preview.text.slice(preview.from, preview.to)
  return (
    <button
      type="button"
      id={rowId(id)}
      data-row={id}
      tabIndex={-1}
      onClick={onClick}
      title={title}
      style={sideRowIndent(2)}
      className={cn(
        SIDE_ROW_SHAPE,
        "text-left text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        current && CURSOR
      )}
    >
      <span className="min-w-0 truncate font-mono text-[0.7rem] whitespace-pre">
        {preview.text.slice(0, preview.from)}
        {replacement ? (
          <>
            <del className="rounded-sm bg-destructive/20 text-foreground">
              {match}
            </del>
            <ins className="rounded-sm bg-success/25 text-foreground no-underline">
              {replacement(preview.text, preview.from)}
            </ins>
          </>
        ) : (
          <mark className="rounded-sm bg-warning/30 text-foreground">
            {match}
          </mark>
        )}
        {preview.text.slice(preview.to)}
      </span>
    </button>
  )
}

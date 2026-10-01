import { useEffect, useRef, type ReactNode } from "react"
import {
  CaseSensitive,
  ChevronRight,
  ListCollapse,
  MessageSquare,
  Regex,
  RotateCw,
  WholeWord,
} from "lucide-react"

import type { SearchOptions, SearchPreview } from "@shared/api"
import { cn } from "@/lib/utils"
import { nameOf } from "@/lib/files/paths"
import { revealAt } from "@/lib/files/typescript"
import { useStudio } from "@/lib/store"
import { useWorkspaceSearch } from "@/lib/workspace-search"
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
 */
export function SearchSection() {
  const query = useWorkspaceSearch((state) => state.query)
  const options = useWorkspaceSearch((state) => state.options)
  const result = useWorkspaceSearch((state) => state.result)
  const searching = useWorkspaceSearch((state) => state.searching)
  const focused = useWorkspaceSearch((state) => state.focused)
  const shut = useWorkspaceSearch((state) => state.shut)
  const shutKinds = useWorkspaceSearch((state) => state.shutKinds)
  const chatsOpen = !shutKinds.includes("chats")
  const filesOpen = !shutKinds.includes("files")
  const { setQuery, toggleOption, run, toggleGroup, toggleKind, toggleAll } =
    useWorkspaceSearch.getState()
  const folders = useStudio((state) => state.folders)

  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [focused])

  const nameOfFolder = (folderId: string | null) =>
    folders.find((folder) => folder.id === folderId)?.name
  // Only worth saying which project a file is in when there is more than one.
  const several = folders.length > 1

  const fileMatches =
    result?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0
  const chatMatches =
    result?.chats.reduce((sum, chat) => sum + chat.matches.length, 0) ?? 0

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

        <p className="min-h-4 px-0.5 text-[0.7rem] text-muted-foreground">
          {result?.error ? (
            <span className="text-destructive">{result.error}</span>
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

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {result && result.chats.length > 0 && (
          <Kind
            label="Chats"
            count={chatMatches}
            open={chatsOpen}
            onToggle={() => toggleKind("chats")}
          />
        )}
        {chatsOpen &&
          result?.chats.map((chat) => {
            const open = !shut.includes(chat.chatId)
            return (
              <div key={chat.chatId}>
                <Group
                  open={open}
                  onToggle={() => toggleGroup(chat.chatId)}
                  icon={
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                  }
                  name={chat.title}
                  where={nameOfFolder(chat.folderId)}
                  count={chat.matches.length}
                />
                {open &&
                  chat.matches.map((match) => (
                    <Line
                      key={`${match.messageId}:${match.offset}`}
                      preview={match.preview}
                      onClick={() => {
                        useWorkspaceSearch.getState().land({
                          chatId: chat.chatId,
                          messageId: match.messageId,
                          offset: match.offset,
                          length: match.length,
                        })
                        useWorktreeChats.getState().select(chat.chatId)
                      }}
                    />
                  ))}
              </div>
            )
          })}

        {result && result.files.length > 0 && (
          <Kind
            label="Files"
            count={fileMatches}
            open={filesOpen}
            onToggle={() => toggleKind("files")}
          />
        )}
        {filesOpen &&
          result?.files.map((file) => {
            const open = !shut.includes(file.path)
            const dir = file.relative.slice(
              0,
              -nameOf(file.relative).length - 1
            )
            const folder = several ? nameOfFolder(file.folderId) : undefined
            return (
              <div key={file.path}>
                <Group
                  open={open}
                  onToggle={() => toggleGroup(file.path)}
                  icon={<FileIcon filePath={file.path} />}
                  name={nameOf(file.relative)}
                  where={[folder, dir].filter(Boolean).join(" › ") || undefined}
                  title={file.path}
                  count={file.matches.length}
                />
                {open &&
                  file.matches.map((match) => (
                    <Line
                      key={`${match.line}:${match.column}`}
                      preview={match.preview}
                      title={`Line ${match.line}`}
                      onClick={() =>
                        revealAt(
                          file.path,
                          match.line,
                          match.column,
                          match.length
                        )
                      }
                    />
                  ))}
              </div>
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
    </div>
  )
}

function summary(
  fileMatches: number,
  files: number,
  chatMatches: number,
  chats: number
): string {
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`
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

/** `Chats` / `Files` above their groups — two kinds of row in one list, each
 * folding away whole, the way a `PanelHeader` folds: the whole label is the
 * target. */
function Kind({
  label,
  count,
  open,
  onToggle,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-6 w-full items-center gap-1 px-2 pt-1 text-left text-[0.65rem] font-medium tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground"
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
  open,
  onToggle,
  icon,
  name,
  where,
  title,
  count,
}: {
  open: boolean
  onToggle: () => void
  icon: ReactNode
  name: string
  where?: string
  title?: string
  count: number
}) {
  return (
    <button
      type="button"
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
        <span className="min-w-0 truncate text-muted-foreground">{where}</span>
      )}
      <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[0.65rem] text-muted-foreground tabular-nums">
        {count}
      </span>
    </button>
  )
}

/** One match: its line, with the match itself painted in the find amber. */
function Line({
  preview,
  title,
  onClick,
}: {
  preview: SearchPreview
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={sideRowIndent(2)}
      className={cn(
        SIDE_ROW_SHAPE,
        "text-left text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      <span className="min-w-0 truncate font-mono text-[0.7rem] whitespace-pre">
        {preview.text.slice(0, preview.from)}
        <mark className="rounded-sm bg-warning/30 text-foreground">
          {preview.text.slice(preview.from, preview.to)}
        </mark>
        {preview.text.slice(preview.to)}
      </span>
    </button>
  )
}

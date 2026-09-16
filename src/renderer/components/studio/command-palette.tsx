import { useEffect, useMemo, useState, type ReactNode } from "react"
import { defaultFilter } from "cmdk"
import { MessageSquare } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { FileIcon } from "./file-icon"
import { useFiles } from "@/lib/files/store"
import { shortlist } from "@/lib/files/search"
import { nameOf } from "@/lib/files/paths"
import { usePalette } from "@/lib/palette"
import { isStudioShortcut } from "@/lib/shortcuts"
import { useStudio } from "@/lib/store"
import { PREFIX } from "@/lib/tabs"
import { useWorktreeChats } from "@/lib/worktree-chat/store"

/**
 * One thing the palette can open.
 *
 * `value` exists only so cmdk can tell two rows apart — it keys its items by
 * it, and two sharing one are highlighted and picked together. What a search
 * matches is `keywords`; see `score`.
 */
type Entry = {
  value: string
  label: string
  /** The right-hand line: which project a file or a chat is in. */
  hint?: string
  /** Everything a search should match, the label and the hint included. */
  keywords: string[]
  icon: ReactNode
  /**
   * Opens it.
   *
   * Nothing here can fail any more: opening a file is a read and a chat is a
   * `select` on a store. It resolved to *why* it could not be opened while a
   * table was a row — that one dialled a server first — and the Database panel
   * is gone.
   */
  open: () => Promise<void>
}

/**
 * One heading's worth of rows, and the tab that narrows to it.
 *
 * `available` is not `entries.length > 0`: the tab row has to hold still while
 * somebody types, and Files is empty until a query matches something. What
 * decides whether a tab is offered is whether the workspace has that kind of
 * thing at all — no chat started, no `Chats` tab — while what is drawn under it
 * is still the query's own answer.
 */
type Group = {
  kind: string
  heading: string
  entries: Entry[]
  available: boolean
}

/** The tab that narrows to nothing, always first. */
const ALL = "all"

/** The line under the input, for an open that is taking long enough to say so. */
type Notice = { text: string }

/**
 * Search the workspace, and open what comes back.
 *
 * The studio has one strip of tabs and two columns, so the thing being looked
 * for is only ever a few clicks away — but only if the column already has it on
 * screen. A file nobody has expanded a folder of and a chat from last week are
 * each a trip through a list the user is not currently in, and neither is where
 * they would go back to afterwards.
 * This is the way in that does not move the columns: type a name, get the tab.
 *
 * It listed tables and saved requests too, until the Database and API panels
 * were deleted; see `docs/design.md` § Database and API, removed.
 *
 * It opens things and nothing more. There is no "commands" half — a palette
 * that also ran actions would be the second place every action is spelled out,
 * and the actions here already sit in the header or the context menu of the
 * panel they belong to, where the thing they act on is on screen.
 */
export function CommandPalette() {
  // On a store, so the left column's Search row opens the same dialog this
  // key does rather than faking the key — see `lib/palette.ts`.
  const open = usePalette((state) => state.open)
  const setOpen = usePalette((state) => state.setOpen)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isStudioShortcut(event, "p")) return

      /*
       * Claimed on the capture phase, and with `preventDefault`, because Mod-P
       * is a key the app does not own by default: Chromium reads it as print,
       * and a palette that also sent the window to a printer would be one
       * nobody pressed twice.
       */
      event.preventDefault()
      usePalette.getState().toggle()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Go to"
      description="Search the workspace's files and chats."
      className="sm:max-w-xl"
    >
      {/* A child of the dialog, so the stores below are subscribed to
          while the palette is on screen and not for the whole run — a closed
          dialog renders none of its content. */}
      <Palette onOpened={() => setOpen(false)} />
    </CommandDialog>
  )
}

function Palette({ onOpened }: { onOpened: () => void }) {
  /**
   * What has been typed, which the palette otherwise has no need of — cmdk owns
   * the input and the filtering both.
   *
   * The files are the exception: there are too many of them to hand over and
   * let cmdk score, so they are cut to a shortlist against this first. See
   * `lib/files/search.ts`.
   */
  const [query, setQuery] = useState("")
  const groups = useEntries(query)
  const [notice, setNotice] = useState<Notice | null>(null)

  /**
   * Which kind of thing the list is narrowed to.
   *
   * Held here rather than on the palette's store, so it starts at `All` every
   * time the dialog opens — this component is a child of it and so unmounts
   * with it. A tab is a way through one search, not a setting.
   */
  const [tab, setTab] = useState(ALL)
  const tabs = groups.filter((group) => group.available)
  // A tab whose kind has just left the workspace — the last chat closed while
  // the palette was open — would otherwise filter every row away with no tab
  // lit to say why.
  const active = tabs.some((group) => group.kind === tab) ? tab : ALL
  // A heading with nothing under it reads as something having failed to load;
  // cmdk hides a group whose rows are all filtered out, but not one that never
  // had any — the tab row above is drawn from the full list instead.
  const shown = groups.filter(
    (group) =>
      group.entries.length > 0 && (active === ALL || group.kind === active)
  )

  function cycle(by: number) {
    const order = [ALL, ...tabs.map((group) => group.kind)]
    const at = order.indexOf(active)
    setTab(order[(at + by + order.length) % order.length] ?? ALL)
  }

  async function run(entry: Entry) {
    /*
     * A chat is a `select` on a store; a file is a read, which is
     * usually a microtask and occasionally a large file off a slow disk. The
     * wait is so the usual case never flashes a line it did not need.
     */
    const waiting = setTimeout(() => {
      setNotice({ text: `Opening ${entry.label}…` })
    }, 150)

    await entry.open()
    clearTimeout(waiting)
    onOpened()
  }

  return (
    <Command
      filter={score}
      /*
       * `⇥` walks the tabs, the way it does in a browser's own find bar.
       * Claimed here rather than left to the input, where it would move focus
       * out of the palette and into whatever the dialog has next — there is
       * nothing else in here to tab to.
       */
      onKeyDown={(event) => {
        if (event.key !== "Tab" || tabs.length === 0) return
        event.preventDefault()
        cycle(event.shiftKey ? -1 : 1)
      }}
    >
      <CommandInput
        autoFocus
        placeholder="Search files and chats…"
        // A failure is about the row that was picked, so the next keystroke —
        // which is on the way to picking another one — is what clears it.
        onValueChange={(value) => {
          setQuery(value)
          setNotice(null)
        }}
      />

      {tabs.length > 0 && (
        <div className="no-scrollbar flex items-center gap-1 overflow-x-auto px-1 pt-1.5">
          {[{ kind: ALL, heading: "All" }, ...tabs].map((group) => (
            <button
              key={group.kind}
              type="button"
              // The input keeps focus: the arrow keys and Enter are still the
              // way the list is worked, and a click that stole focus would end
              // the search that the tab is meant to narrow.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTab(group.kind)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors",
                group.kind === active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {group.heading}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <p className="px-3 pt-2 text-xs text-muted-foreground">{notice.text}</p>
      )}

      <CommandList className="max-h-[min(60vh,24rem)]">
        <CommandEmpty className="text-muted-foreground">
          {tabs.length === 0
            ? "Nothing to open yet. Add a project and start a chat in it."
            : "No match."}
        </CommandEmpty>

        {shown.map((group) => (
          <CommandGroup
            key={group.kind}
            // Narrowed to one kind, the heading would only repeat the tab that
            // is already lit above it.
            heading={active === ALL ? group.heading : undefined}
          >
            {group.entries.map((entry) => (
              <CommandItem
                key={entry.value}
                value={entry.value}
                keywords={entry.keywords}
                onSelect={() => void run(entry)}
              >
                {entry.icon}
                <span className="truncate">{entry.label}</span>
                {entry.hint && (
                  // The slot the check mark steps aside for, which is what
                  // keeps a hint from being pushed off the end by it.
                  <CommandShortcut className="max-w-[45%] truncate font-normal tracking-normal">
                    {entry.hint}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}

/**
 * How well a row matches what has been typed.
 *
 * Each searchable string is scored on its own and the best one wins, rather
 * than one string of them all: a query is about a name *or* a URL, and
 * concatenating the two lets a match straddle them — "user get" would find
 * `GET /users` through a gap of nothing.
 *
 * The row's `value` is deliberately not scored. It is an id, and cmdk offers no
 * way to filter on keywords alone, so a query of hex letters ("cafe", "dad")
 * would otherwise match whichever request's uuid happened to contain them.
 */
function score(_value: string, search: string, keywords?: string[]): number {
  return Math.max(
    0,
    ...(keywords ?? []).map((text) => defaultFilter(text, search))
  )
}

/**
 * Everything openable in the workspace, grouped the way the sections are
 * ordered.
 *
 * Read from the panels' own stores rather than from anything kept for this:
 * what the palette lists is what the panels would list, and a second index
 * would be one more thing to hold in step with them.
 *
 * Files are the exception, and are an index — the only one. A folder's files
 * are not a list any store holds: the Explorer's tree is what has been expanded,
 * which is a handful of directories out of a repository, while ⌘P has to find a
 * file nobody has opened a folder of. So the workspace is walked once, the first
 * time the palette is opened, and held until the folder list itself changes —
 * adding or removing a folder drops it, since a walk that never saw that folder
 * is wrong rather than merely old; `Refresh` in the Explorer re-walks it for
 * everything else. Everything that follows from that — which directories are
 * skipped, the cap, and why the shortlist happens before cmdk sees a row — is in
 * `main/files.ts` and `lib/files/search.ts`.
 */
function useEntries(query: string): Group[] {
  const files = useFiles((state) => state.index)
  const loadIndex = useFiles((state) => state.loadIndex)

  /*
   * The one group with an index behind it rather than a store already holding
   * what it lists.
   *
   * Walked when the palette is first opened rather than at launch — this
   * component is a child of the dialog, so this effect runs when it opens —
   * and held until the workspace's folders change. A studio nobody presses ⌘P
   * in never walks the workspace at all, which is the same bargain the tree
   * makes by reading a directory only when it is expanded.
   */
  useEffect(() => {
    void loadIndex()
  }, [loadIndex])

  const chats = useWorktreeChats((state) => state.chats)
  const folders = useStudio((state) => state.folders)

  return useMemo(() => {
    const fileEntries: Entry[] = shortlist(files, query).map((entry) => {
      const folder = folders.find(
        (candidate) => candidate.id === entry.folderId
      )
      return {
        value: PREFIX.files + entry.path,
        label: entry.relative,
        // Which repository it is in, since two of them in one workspace both
        // have a `src/index.ts`.
        hint: folder?.name,
        // The path without its slashes as well as with them: the shortlist
        // that chose this row ignores separators — "libfiles" finds
        // `lib/files` — and cmdk, which scores it afterwards, does not. Without
        // this, the row a search had just found could be filtered back out by
        // the stricter of the two scorers.
        keywords: [
          entry.relative,
          nameOf(entry.relative),
          entry.relative.replace(/\//g, ""),
        ],
        // The same icon the strip and the `Changes` list draw for this path:
        // a row here is the way *to* that tab, so a `.ts` found by typing has
        // to be the `.ts` that opens.
        icon: <FileIcon filePath={entry.path} />,
        open: async () => {
          // Opened and revealed both: somebody who found a file this way
          // generally wants to see what is beside it.
          await useFiles.getState().open(entry.path)
          void useFiles.getState().reveal(entry.path)
        },
      }
    })

    // Every chat, not only the ones with a tab open: the palette is how a
    // conversation nobody has on screen is found again, and selecting one is
    // what opens its tab.
    const chatEntries: Entry[] = chats.map((chat) => {
      // The project it is in: two chats can carry the same first sentence, and
      // where they run is what tells them apart.
      const where = folders.find(
        (candidate) => candidate.id === chat.folderId
      )?.name
      return {
        value: PREFIX.worktree + chat.id,
        label: chat.title,
        hint: where,
        keywords: [chat.title, ...(where ? [where] : [])],
        icon: <MessageSquare className="size-3.5 shrink-0" />,
        open: async () => {
          useWorktreeChats.getState().select(chat.id)
        },
      }
    })

    /*
     * Every kind, empty ones included — the tab row is drawn from this list and
     * has to know a kind exists before a query has matched any of it. What
     * `available` says is whether the workspace holds that kind at all, which
     * is why Files asks the index rather than the rows: the shortlist is empty
     * until something is typed.
     *
     * The order is the sections' own. Files first, the way Explorer is first on
     * the rail — and because a query that names a file is usually a query about
     * that file.
     */
    const all: Group[] = [
      {
        kind: "files",
        heading: "Files",
        entries: fileEntries,
        available: files.length > 0,
      },
      {
        kind: "chats",
        heading: "Chats",
        entries: chatEntries,
        available: chatEntries.length > 0,
      },
    ]

    return all
  }, [files, query, chats, folders])
}

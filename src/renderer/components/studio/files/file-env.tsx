import { useRef, useState } from "react"
import { Eye, EyeOff, Plus, Search, Trash2 } from "lucide-react"

import {
  isValidKey,
  parseEnv,
  printEnv,
  type EnvDoc,
  type EnvLine,
} from "@/lib/files/env-doc"
import { cn } from "@/lib/utils"
import { IconButton } from "../icon-button"

/**
 * A `.env` file as a table of variables.
 *
 * The `.md` block editor's bargain, for a smaller format: typing marks the tab
 * dirty and Save writes it, and nothing is written until there is an edit. It
 * is not lossy the way that one is — `lib/files/env-doc.ts` prints a row nobody
 * touched as the bytes it came in as, and keeps every line it cannot read as an
 * assignment exactly where it was.
 *
 * **Values are masked until asked for**, per row or all at once. A `.env` is
 * where the keys live, and this pane is on screen during a screen share as
 * often as any other.
 */
export function FileEnv({
  text,
  onChange,
}: {
  text: string
  onChange: (text: string) => void
}) {
  /*
   * Re-read when the text moves under the table rather than from it — a reload
   * off disk, or an edit in the text editor of the same buffer — and not when
   * it is what this table just wrote, which would rebuild every row (and lose
   * the caret) on every keystroke. `state.text` is what was last read or
   * written, so the echo of this table's own edit matches it.
   */
  const [state, setState] = useState(() => ({ text, rows: rowsOf(text) }))
  let rows = state.rows
  if (state.text !== text) {
    rows = rowsOf(text)
    setState({ text, rows })
  }

  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set())
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState("")
  const focusNext = useRef<number | null>(null)

  const update = (next: Row[]) => {
    const printed = printEnv({
      ...rows.doc,
      lines: next.map((row) => row.line),
    })
    setState({ text: printed, rows: { ...rows, items: next } })
    onChange(printed)
  }

  const edit = (id: number, line: EnvLine) =>
    update(rows.items.map((row) => (row.id === id ? { id, line } : row)))

  const remove = (id: number) =>
    update(rows.items.filter((row) => row.id !== id))

  const add = () => {
    const id = nextId()
    focusNext.current = id
    setFilter("")
    update([
      ...rows.items,
      {
        id,
        line: {
          kind: "entry",
          key: "",
          value: "",
          exported: false,
          quote: "none",
          comment: null,
          raw: null,
        },
      },
    ])
  }

  const duplicates = new Map<string, number>()
  for (const { line } of rows.items) {
    if (line.kind === "entry" && line.key !== "") {
      duplicates.set(line.key, (duplicates.get(line.key) ?? 0) + 1)
    }
  }

  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? rows.items.filter(
        ({ line }) =>
          line.kind === "entry" && line.key.toLowerCase().includes(needle)
      )
    : rows.items

  const count = rows.items.filter(({ line }) => line.kind === "entry").length

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${count} variable${count === 1 ? "" : "s"}`}
          className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        <IconButton
          label={showAll ? "Hide values" : "Show values"}
          pressed={showAll}
          onClick={() => setShowAll((on) => !on)}
          className="shrink-0"
        >
          {showAll ? <EyeOff /> : <Eye />}
        </IconButton>
        <IconButton label="Add variable" onClick={add} className="shrink-0">
          <Plus />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-[clamp(2rem,4%,3.5rem)] pt-4 pb-16">
        <div className="mx-auto max-w-[var(--prose-measure)] font-mono text-xs">
          {visible.map(({ id, line }) => {
            if (line.kind === "blank") {
              return <div key={id} className="h-3" />
            }

            if (line.kind === "other") {
              return (
                <div
                  key={id}
                  title="Not a KEY=value line — kept exactly as it is. Change it in the text editor."
                  className="truncate px-2 py-1 whitespace-pre text-muted-foreground/70"
                >
                  {line.raw}
                </div>
              )
            }

            if (line.kind === "comment") {
              return (
                <div key={id} className="group flex items-center gap-1">
                  <span className="pl-2 text-muted-foreground/70">#</span>
                  <input
                    value={line.text}
                    onChange={(event) =>
                      edit(id, {
                        kind: "comment",
                        text: event.target.value,
                        raw: null,
                      })
                    }
                    className="h-7 min-w-0 flex-1 rounded bg-transparent px-1 text-muted-foreground outline-none focus:bg-muted/50"
                  />
                  <RemoveButton onClick={() => remove(id)} />
                </div>
              )
            }

            const revealed = showAll || shown.has(id)
            const duplicate = (duplicates.get(line.key) ?? 0) > 1
            const invalid = line.key !== "" && !isValidKey(line.key)
            const multiline = line.value.includes("\n")

            return (
              <div
                key={id}
                className="group grid grid-cols-[minmax(8rem,2fr)_minmax(0,3fr)_auto_auto] items-start gap-1 py-0.5"
              >
                <input
                  ref={(node) => {
                    if (node && focusNext.current === id) {
                      focusNext.current = null
                      node.focus()
                    }
                  }}
                  value={line.key}
                  placeholder="KEY"
                  aria-invalid={duplicate || invalid || undefined}
                  title={
                    invalid
                      ? "Not a name a shell or dotenv will read"
                      : duplicate
                        ? "Defined more than once in this file"
                        : undefined
                  }
                  spellCheck={false}
                  onChange={(event) =>
                    edit(id, { ...line, key: event.target.value, raw: null })
                  }
                  className={cn(
                    "h-7 min-w-0 rounded border border-transparent bg-muted/40 px-2 font-medium outline-none focus:border-ring",
                    (duplicate || invalid) &&
                      "border-destructive/60 text-destructive"
                  )}
                />
                {multiline ? (
                  <textarea
                    value={line.value}
                    rows={Math.min(line.value.split("\n").length, 8)}
                    spellCheck={false}
                    onChange={(event) =>
                      edit(id, {
                        ...line,
                        value: event.target.value,
                        raw: null,
                      })
                    }
                    className={cn(
                      "min-w-0 resize-y rounded border border-transparent bg-muted/40 px-2 py-1.5 leading-4 outline-none focus:border-ring",
                      !revealed && "[-webkit-text-security:disc]"
                    )}
                  />
                ) : (
                  <input
                    value={line.value}
                    placeholder="value"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) =>
                      edit(id, {
                        ...line,
                        value: event.target.value,
                        raw: null,
                      })
                    }
                    className={cn(
                      "h-7 min-w-0 rounded border border-transparent bg-muted/40 px-2 outline-none focus:border-ring",
                      !revealed && "[-webkit-text-security:disc]"
                    )}
                  />
                )}
                <IconButton
                  label={revealed ? "Hide value" : "Show value"}
                  disabled={showAll}
                  onClick={() =>
                    setShown((current) => {
                      const next = new Set(current)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }
                  className="mt-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  {revealed ? <EyeOff /> : <Eye />}
                </IconButton>
                <RemoveButton onClick={() => remove(id)} />
                {line.comment !== null && (
                  <span className="col-span-4 truncate pl-2 text-muted-foreground/70">
                    # {line.comment}
                  </span>
                )}
              </div>
            )
          })}

          {needle === "" && (
            <button
              type="button"
              onClick={add}
              className="mt-2 flex h-7 w-full items-center gap-1.5 rounded px-2 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <Plus className="size-3.5" />
              Add variable
            </button>
          )}
          {needle !== "" && visible.length === 0 && (
            <p className="px-2 py-1 text-muted-foreground">
              No variable matches “{filter.trim()}”.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton
      label="Remove line"
      onClick={onClick}
      className="mt-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      <Trash2 />
    </IconButton>
  )
}

interface Row {
  /** A React key that survives edits, which the line's index would not. */
  id: number
  line: EnvLine
}

let lastId = 0
function nextId(): number {
  lastId += 1
  return lastId
}

function rowsOf(text: string): { doc: EnvDoc; items: Row[] } {
  const doc = parseEnv(text)
  return {
    doc,
    items: doc.lines.map((line) => ({ id: nextId(), line })),
  }
}

import type { AssistantMessage } from "@shared/api"
import { markdownRenderer } from "@/lib/markdown/renderer"
import type { ExportChat, ExportOptions } from "./export"
import { toolRowOf } from "./export"
import { dateTimeOf, timeOf } from "./since"
import { money, totalOf, usageLine } from "./usage"
import { compactLine } from "./window"

/**
 * A chat as one HTML file: the `Export as HTML…` item.
 *
 * Self-contained on purpose — the stylesheet is inline and nothing in it points
 * at this app's assets, a CDN or a font file. The file is going to be opened
 * from a Downloads folder, attached to a ticket or mailed, and every one of
 * those is a place the app is not. System fonts, a light scheme, and the dark
 * one under `prefers-color-scheme` so it reads the way the reader's machine
 * already does.
 *
 * The replies go through the app's own markdown renderer (`markdownRenderer`)
 * rather than a second parser: a table that rendered in the pane has to render
 * the same way in the file, and that is the one guarantee a second library
 * cannot give. It builds DOM, so this half lives in the renderer and is not
 * tested under `bun`; the words and the per-line shapes are `export.ts`'s and
 * are.
 */

export async function chatToHtml(
  chat: ExportChat,
  lines: AssistantMessage[],
  options: ExportOptions = {}
): Promise<string> {
  const render = await markdownRenderer()
  // A detached container that each reply is serialised through. One for every
  // line rather than one shared, so a reply that throws mid-render leaves
  // nothing of itself in the next.
  const toHtml = (markdown: string): string => {
    try {
      const box = document.createElement("div")
      box.replaceChildren(render(markdown))
      return box.innerHTML
    } catch (error) {
      console.error("Could not render markdown for export", error)
      return `<p class="plain">${escape(markdown)}</p>`
    }
  }

  const body = lines.map((line) => blockOf(line, toHtml)).join("\n")
  const title = chat.title.trim() || "Untitled chat"
  const facts: string[] = []
  if (options.project) facts.push(`Project: ${escape(options.project)}`)
  const when = dateTimeOf(chat.createdAt)
  if (when) facts.push(escape(when))
  const total = totalOf(lines)
  const footer = total
    ? `<footer class="totals">Total: ${escape(usageLine(total))}${
        total.costUsd === null ? "" : ` · ${escape(money(total.costUsd))}`
      }</footer>`
    : ""

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>${escape(title)}</h1>
${facts.length > 0 ? `<p class="meta">${facts.join(" · ")}</p>` : ""}
</header>
${body}
${footer}
</main>
</body>
</html>
`
}

function blockOf(
  line: AssistantMessage,
  toHtml: (markdown: string) => string
): string {
  switch (line.role) {
    case "user":
      return `<section class="msg user">${who(line.step ? `Workflow · ${escape(line.step)}` : "You", line.at)}<div class="bubble">${escape(line.text)}</div></section>`
    case "step": {
      const mark = line.status === "failed" ? "❌" : "⚙️"
      const summary = `${mark} <b>${escape(line.label)}</b> — <code>${escape(line.summary)}</code>`
      return line.output
        ? `<details class="tool"><summary>${summary}</summary><pre class="input">${escape(line.output)}</pre></details>`
        : `<div class="tool">${summary}</div>`
    }
    case "assistant":
      return `<section class="msg claude">${who("Claude", line.at)}<div class="prose">${toHtml(line.text)}</div></section>`
    case "thinking":
      return `<details class="thinking"><summary>Thinking</summary><div class="plain">${escape(line.text)}</div></details>`
    case "tool":
      return toolOf(line)
    case "error":
      return `<div class="note error">⚠️ ${escape(line.text)}</div>`
    case "ask":
      return `<div class="note ask${line.text.startsWith("Refused") ? " refused" : ""}">🛡️ ${escape(line.text)}</div>`
    case "usage":
      return `<div class="note usage">${escape(usageLine(line.usage))}${
        line.usage.costUsd === null
          ? ""
          : ` · ${escape(money(line.usage.costUsd))}`
      }</div>`
    case "compact":
      return `<div class="compact"><span>${escape(compactLine(line))}</span></div>`
    case "workflow":
      return `<div class="note${line.status === "done" ? "" : " error"}">⚙️ Workflow ${line.status}${line.error ? ` — ${escape(line.error)}` : ""}</div>`
  }
}

function who(name: string, at?: string): string {
  const time = at ? timeOf(at) : ""
  const stamp = time
    ? `<time datetime="${escape(at!)}" title="${escape(dateTimeOf(at!))}">${time}</time>`
    : ""
  return `<div class="who">${name}${stamp}</div>`
}

/**
 * A tool call: its row, and what it opens onto.
 *
 * A `<details>` only when there is something under the row — the same test the
 * pane's `ToolRow` makes, on the same fields main fills in only when the row is
 * not already showing the whole of it. A row that opened onto nothing would be
 * a disclosure arrow that lies.
 */
function toolOf(line: Extract<AssistantMessage, { role: "tool" }>): string {
  const row = toolRowOf(line)
  const mark = row.failed ? "❌" : row.agent ? "🤖" : "🔧"
  const argument = row.argument
    ? row.agent
      ? ` — ${escape(row.argument)}`
      : ` — <code>${escape(row.argument)}</code>`
    : ""
  const said = row.said
    ? ` <span class="said${row.failed ? " failed" : ""}">→ ${escape(row.said)}</span>`
    : ""
  const stamp = line.at ? ` title="${escape(dateTimeOf(line.at))}"` : ""
  const summary = `${mark} <b>${escape(row.label)}</b>${argument}${said}`

  const parts: string[] = []
  // Only the whole argument main kept, never the row's own `summary` again:
  // unlike the pane's open row, the summary stays on this one.
  if (line.input) parts.push(`<pre class="input">${escape(line.input)}</pre>`)
  if (line.change) parts.push(`<pre class="diff">${diffOf(line.change)}</pre>`)
  if (line.todos) {
    parts.push(
      `<ul class="todos">${line.todos
        .map(
          (todo) => `<li class="${todo.status}">${escape(todo.content)}</li>`
        )
        .join("")}</ul>`
    )
  }
  if (line.output) {
    parts.push(
      `<pre class="output${row.failed ? " failed" : ""}">${escape(line.output)}</pre>`
    )
  }

  if (parts.length === 0) {
    return `<div class="tool"${stamp}>${summary}</div>`
  }
  return `<details class="tool"${stamp}><summary>${summary}</summary>${parts.join("")}</details>`
}

/** The two git colours on a change, by its first character — the pane's own
 * rule, on the pane's own two glyphs. */
function diffOf(change: string): string {
  return change
    .split("\n")
    .map((line) => {
      const kind = line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : ""
      return kind
        ? `<span class="${kind}">${escape(line)}</span>`
        : escape(line)
    })
    .join("\n")
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * The whole stylesheet. Custom properties for the handful of colours so the
 * dark scheme is one block that re-points them rather than a second copy of
 * every rule.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #6b7280;
  --border: #e5e7eb;
  --bubble: #eef2ff;
  --block: #f6f8fa;
  --add: #007100;
  --del: #ad0707;
  --error: #b91c1c;
  --error-bg: #fef2f2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --fg: #e6e6e6;
    --muted: #9aa0a6;
    --border: #2a2f36;
    --bubble: #1e2433;
    --block: #171a20;
    --add: #73c991;
    --del: #c74e39;
    --error: #f87171;
    --error-bg: #2a1517;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
header { margin-bottom: 28px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
.meta, .who, .note, .compact, .totals, .tool { color: var(--muted); font-size: 0.8rem; }
.msg { margin: 18px 0; }
.who { display: flex; justify-content: space-between; align-items: baseline; font-weight: 600; margin-bottom: 4px; }
.who time { font-weight: 400; font-variant-numeric: tabular-nums; }
.user .bubble {
  background: var(--bubble);
  border-radius: 12px 12px 4px 12px;
  padding: 10px 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose h1, .prose h2, .prose h3 { font-size: 1.05rem; margin: 1em 0 0.4em; }
.prose a { color: inherit; }
.prose blockquote { margin: 0.6em 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
.prose table { border-collapse: collapse; font-size: 0.9em; }
.prose th, .prose td { border: 1px solid var(--border); padding: 4px 8px; }
.prose img { max-width: 100%; }
code, pre, .plain {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
}
code { background: var(--block); border-radius: 4px; padding: 1px 4px; }
pre {
  background: var(--block);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto;
  margin: 0.6em 0;
}
pre code { background: none; padding: 0; }
.plain { white-space: pre-wrap; overflow-wrap: anywhere; }
details.thinking { margin: 10px 0; font-size: 0.85rem; color: var(--muted); }
details.thinking .plain { margin-top: 6px; padding-left: 12px; border-left: 2px solid var(--border); }
summary { cursor: pointer; }
.tool { margin: 4px 0; padding-left: 4px; }
.tool b { font-weight: 600; color: var(--fg); opacity: 0.85; }
.tool .said { opacity: 0.9; }
.tool .failed, .note.error, .ask.refused { color: var(--error); }
.tool pre { font-size: 0.78rem; max-height: 320px; margin: 6px 0 10px; }
.tool pre.diff .add { color: var(--add); }
.tool pre.diff .del { color: var(--del); }
.tool pre.output.failed { color: var(--error); }
.todos { margin: 6px 0 10px; padding-left: 20px; font-size: 0.8rem; }
.todos .completed { text-decoration: line-through; opacity: 0.6; }
.todos .in_progress { color: var(--fg); font-weight: 600; }
.note { margin: 8px 0; }
.note.error { background: var(--error-bg); border: 1px solid var(--error); border-radius: 8px; padding: 8px 12px; white-space: pre-wrap; }
.compact { display: flex; align-items: center; gap: 10px; margin: 14px 0; }
.compact::before, .compact::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.totals { margin-top: 28px; padding-top: 12px; border-top: 1px solid var(--border); }
`

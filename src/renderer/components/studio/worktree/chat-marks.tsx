import {
  Bot,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Search,
  Terminal,
  Wrench,
} from "lucide-react"

import type { ComponentType, ReactNode, SVGProps } from "react"

import type { AssistantMessage } from "@shared/api"
import { AGENT_TOOLS } from "@/lib/worktree-chat/activity"
import { cn } from "@/lib/utils"
import { AsanaLogo } from "@/components/ui/svgs/asana"
import { Atlassian } from "@/components/ui/svgs/atlassian"
import { Canva } from "@/components/ui/svgs/canva"
import { Chrome } from "@/components/ui/svgs/chrome"
import { Clickup } from "@/components/ui/svgs/clickup"
import { Cloudflare } from "@/components/ui/svgs/cloudflare"
import { Drive } from "@/components/ui/svgs/google-drive"
import { Figma } from "@/components/ui/svgs/figma"
import { GithubDark } from "@/components/ui/svgs/githubDark"
import { GithubLight } from "@/components/ui/svgs/githubLight"
import { Gitlab } from "@/components/ui/svgs/gitlab"
import { Gmail } from "@/components/ui/svgs/gmail"
import { Linear } from "@/components/ui/svgs/linear"
import { Notion } from "@/components/ui/svgs/notion"
import { Playwright } from "@/components/ui/svgs/playwright"
import { Sentry } from "@/components/ui/svgs/sentry"
import { Slack } from "@/components/ui/svgs/slack"
import { Stripe } from "@/components/ui/svgs/stripe"
import { Supabase } from "@/components/ui/svgs/supabase"
import { Vercel } from "@/components/ui/svgs/vercel"

/**
 * What a tool looks and reads like in a chat row.
 *
 * Its own file for the reason `section-marks.tsx` is: the same mark is drawn in
 * two places — on the row itself and on the closed fold above it — and a glyph
 * that means "the shell ran" has to mean it in both. Splitting it also keeps
 * `chat-message.tsx` about the rows rather than about a lookup table.
 */

/**
 * A tool's mark, drawn.
 *
 * A function returning a node rather than a component taking a name, which is
 * the same shape `tab-items.tsx` draws a file's icon with — a looked-up
 * `LucideIcon` rendered inside a component is a component created during
 * render, and React cannot keep the node it drew last time when the type is
 * fresh on every pass.
 */
export function toolMark(name: string, className?: string): ReactNode {
  const Icon = iconOf(name)
  return <Icon className={className} />
}

/**
 * The same mark for a *server* rather than for one of its tools — Settings ›
 * MCP, where the rows are servers.
 *
 * Here rather than in the dialog so the two agree: a server recognised by its
 * logo in a chat's tool row and not in the listing of servers would look like
 * two different servers.
 */
export function serverMark(server: string, className?: string): ReactNode {
  return toolMark(`mcp__${server}__`, className)
}

/**
 * A mark is a `LucideIcon` or one of the brand SVGs under `components/ui/svgs`
 * (svgl's shadcn registry). The brands carry their own colours and have no
 * intrinsic size, so every caller has to pass a `size-*` class — an `<svg>` with
 * only a `viewBox` falls back to 300×150 when CSS says nothing.
 */
type ToolIcon = ComponentType<SVGProps<SVGSVGElement>>

/**
 * Which glyph a tool gets.
 *
 * By kind rather than one per tool: what a row is scanned for is "did it read,
 * did it run something, did it write" — so `Edit`, `Write` and `NotebookEdit`
 * share a mark. A tool with no entry falls back to the wrench every one of them
 * used to have.
 */
function iconOf(name: string): ToolIcon {
  // A server the user configured — which is every MCP server a turn can reach,
  // now that this app serves none of its own. Its brand where there is one,
  // because that is
  // what the row is scanned for — "this turn touched ClickUp" reads off a logo
  // faster than off a name. Otherwise the globe: not the wrench, because what
  // makes it worth its own mark is that it reaches outside this machine.
  if (name.startsWith("mcp__")) return brandOf(name) ?? Globe
  return TOOL_ICONS[name] ?? Wrench
}

/**
 * The brand behind an MCP server's name, if it is one we ship a logo for.
 *
 * Matched on a substring of the *server*, not on the whole name, because the
 * same service arrives under whatever the user (or the connector) called it:
 * `claude_ai_ClickUp`, `clickup-mcp`, `my-figma`. Case and separators are
 * dropped for the same reason. The tool half is deliberately not searched — a
 * `notion_search` on some other server is not Notion.
 */
function brandOf(name: string): ToolIcon | undefined {
  const server = /^mcp__(.+?)__/.exec(name)?.[1]
  if (!server) return undefined
  const flat = server.toLowerCase().replace(/[^a-z0-9]/g, "")
  return BRANDS.find(([key]) => flat.includes(key))?.[1]
}

/**
 * GitHub is the one brand whose mark is a solid glyph rather than a coloured
 * shape, so svgl ships it twice — black and white — and neither is legible on
 * both themes. Drawn twice and switched in CSS rather than read off
 * `resolvedTheme`, so a theme change repaints without re-rendering the row.
 */
function GithubMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <>
      <GithubLight className={cn(className, "dark:hidden")} {...props} />
      <GithubDark className={cn(className, "hidden dark:block")} {...props} />
    </>
  )
}

const BRANDS: [string, ToolIcon][] = [
  ["clickup", Clickup],
  ["figma", Figma],
  ["linear", Linear],
  ["notion", Notion],
  ["asana", AsanaLogo],
  ["atlassian", Atlassian],
  ["jira", Atlassian],
  ["confluence", Atlassian],
  ["canva", Canva],
  ["slack", Slack],
  ["github", GithubMark],
  ["gitlab", Gitlab],
  ["sentry", Sentry],
  ["supabase", Supabase],
  ["vercel", Vercel],
  ["cloudflare", Cloudflare],
  ["stripe", Stripe],
  ["playwright", Playwright],
  ["chrome", Chrome],
  ["gmail", Gmail],
  ["drive", Drive],
]

const TOOL_ICONS: Record<string, ToolIcon> = {
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Bash: Terminal,
  Glob: Search,
  Grep: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListTodo,
  // Both of the subagent tool's names — see `AGENT_TOOLS`.
  ...Object.fromEntries(AGENT_TOOLS.map((name) => [name, Bot])),
}

/**
 * One tool name per distinct mark, in the order they first appeared.
 *
 * Deduplicated by *glyph* rather than by name, because a closed fold is
 * answering "what kind of thing happened here" — a `Read` and a `Grep` are two
 * marks and a `Write` and an `Edit` are one, and twelve identical glyphs answer
 * the question no better than one. The count is already in the sentence beside
 * them.
 */
export function marksOf(lines: AssistantMessage[]): string[] {
  const seen: ToolIcon[] = []
  const names: string[] = []
  for (const line of lines) {
    if (line.role !== "tool") continue
    const mark = iconOf(line.name)
    if (seen.includes(mark)) continue
    seen.push(mark)
    names.push(line.name)
  }
  return names
}

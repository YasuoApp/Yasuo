import { Bot } from "lucide-react"

import type { ChatAgent } from "@shared/api"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * The subagents running under this chat, as a chip above the composer that
 * opens onto the list. They used to hang under `Working…` at the end of the
 * transcript, where four of them and their summaries pushed the turn's own
 * last line up and read as part of the answer. The loader now says only that
 * something is working; who is working is here, one click away.
 */
export function ChatAgents({ agents }: { agents: ChatAgent[] }) {
  if (agents.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[0.7rem] text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Subagents running in this chat"
      >
        <Bot className="size-3 text-primary" />
        {agents.length} {agents.length === 1 ? "agent" : "agents"} running
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-h-[min(60vh,28rem)] w-[26rem] gap-2 overflow-y-auto text-xs"
      >
        {agents.map((agent) => (
          <div key={agent.id} className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <Bot className="size-3 shrink-0 translate-y-0.5 text-muted-foreground/50" />
              <span className="min-w-0 truncate text-foreground/90">
                {agent.description}
              </span>
              {/* The last tool is what shows movement — a name on its own for
                  five minutes reads as something stuck. */}
              {agent.lastTool && (
                <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-muted-foreground/60">
                  {agent.lastTool}
                </span>
              )}
            </div>
            {/* Where it has got to, under what it was asked: the description
                is the same for the agent's whole life, and this is the line
                that moves. */}
            {agent.summary && (
              <div className="line-clamp-2 pl-4.5 text-muted-foreground">
                {agent.summary}
              </div>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

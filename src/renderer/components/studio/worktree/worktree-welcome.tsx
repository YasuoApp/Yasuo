import { FolderGit2, GitBranch, TriangleAlert } from "lucide-react"

import type { ChatPlace } from "@shared/api"
import { useStudio } from "@/lib/store"

/**
 * What a chat with nothing in it yet opens on: where this chat actually is.
 *
 * A conversation with nothing in it has a whole pane and one sentence to put in
 * it, and there is something worth saying instead — which directory the turn
 * will run in. Somebody with two projects open needs that before they type
 * anything, because the alternative is asking an agent to change the wrong one.
 *
 * It says the opposite of a reassurance, on purpose: this is the branch you
 * have checked out, and an edit here is an edit to your work. There was a
 * second shape for a chat in a `git worktree` checkout — where nothing had been
 * copied and no edit could reach the branch you had open — and that layer is
 * gone, so the only honest line left is this one.
 */
export function WorktreeWelcome({ place }: { place: ChatPlace | null }) {
  const folders = useStudio((state) => state.folders)

  // Between the project leaving the workspace and its chats closing. The chat
  // is still readable — the conversation is on disk — so this says nothing
  // rather than claiming a directory that has gone.
  if (!place) return null

  const folder = folders.find((entry) => entry.id === place.folderId)
  if (!folder) return null

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-muted px-4 py-3 text-sm">
        You are in <span className="font-medium">{folder.name}</span> itself —
        the working tree you have checked out
      </div>

      <dl className="space-y-2 text-xs text-muted-foreground">
        {/* First, because it is the one fact that changes how the next
            sentence should be phrased: there is no branch to throw away. */}
        <Line Icon={TriangleAlert}>
          Edits here change the files you are working in. Use{" "}
          <span className="font-medium">Plan</span> or{" "}
          <span className="font-medium">Ask</span> in the toolbar below if you
          would rather be asked first.
        </Line>

        <Line Icon={GitBranch}>
          Turns run on whatever branch this project has checked out
        </Line>

        {/* The path last and in full: it is the least interesting thing here
            until the moment somebody needs to reach it from a terminal. */}
        <Line Icon={FolderGit2}>
          <span className="font-mono break-all">{folder.path}</span>
        </Line>
      </dl>
    </div>
  )
}

function Line({
  Icon,
  children,
}: {
  Icon: typeof GitBranch
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

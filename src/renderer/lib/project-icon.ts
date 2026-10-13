import { useEffect, useState } from "react"
import { create } from "zustand"

/**
 * One ask per project for the run, shared by every row drawing it. A
 * project's icon changes about never, and the column re-renders on every chat
 * event — asking again each time would be a stat storm for a 16px square.
 */
const asked = new Map<string, Promise<string | null>>()

/** Bumped per project when its icon is changed here, which is the one time the
 * cached answer is known to be stale. */
const useIconVersions = create<{ versions: Record<string, number> }>(() => ({
  versions: {},
}))

function iconOf(folderId: string): Promise<string | null> {
  let pending = asked.get(folderId)
  if (!pending) {
    // A miss or a refusal both draw the folder, which is what the row drew
    // before there were icons.
    pending = window.desktop.projectIcon(folderId).catch(() => null)
    asked.set(folderId, pending)
  }
  return pending
}

function refresh(folderId: string): void {
  asked.delete(folderId)
  useIconVersions.setState(({ versions }) => ({
    versions: { ...versions, [folderId]: (versions[folderId] ?? 0) + 1 },
  }))
}

/** Asks for a picture and redraws the row with it. Throws what main threw —
 * a file too large to be an icon. */
export async function chooseProjectIcon(folderId: string): Promise<void> {
  if (await window.desktop.pickProjectIcon(folderId)) refresh(folderId)
}

export async function resetProjectIcon(folderId: string): Promise<void> {
  await window.desktop.resetProjectIcon(folderId)
  refresh(folderId)
}

/** The project's icon as a `data:` URL, or null — none, or not read yet. */
export function useProjectIcon(folderId: string | null): string | null {
  const version = useIconVersions((state) =>
    folderId ? (state.versions[folderId] ?? 0) : 0
  )
  const [found, setFound] = useState<{
    key: string
    url: string | null
  } | null>(null)
  const key = folderId && `${folderId}:${version}`
  useEffect(() => {
    if (!folderId || !key) return
    let live = true
    void iconOf(folderId).then((url) => {
      if (live) setFound({ key, url })
    })
    return () => {
      live = false
    }
  }, [folderId, key])
  // The previous picture stays up while a changed one is read, rather than
  // the folder flashing between them.
  if (!found || !folderId || !found.key.startsWith(`${folderId}:`)) return null
  return found.url
}

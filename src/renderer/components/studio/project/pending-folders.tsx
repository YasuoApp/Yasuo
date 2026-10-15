import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useCloudSync, refreshPending } from "@/lib/cloud-workspace"
import { useStudio } from "@/lib/store"
import { pickDirectory } from "@/lib/workspace"

/**
 * Folders the account has that this machine has no path for, at the head of the
 * Projects column. A folder another machine added is listed here rather than
 * opened: "Locate" asks for this machine's copy of it, and the folder then keeps
 * the id the account knows it by.
 *
 * Drawn only while there is something to locate, so an account whose folders
 * all live here sees the column it always saw.
 */
export function PendingFolders() {
  const pending = useCloudSync((state) => state.pending)
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null
  )
  const [busy, setBusy] = useState<string | null>(null)

  if (pending.length === 0) return null

  async function locate(folder: { id: string; name: string }) {
    setError(null)
    setBusy(folder.id)
    try {
      const path = await pickDirectory()
      if (!path) return
      await useStudio
        .getState()
        .addFolder({ path, name: folder.name, id: folder.id })
      await refreshPending()
    } catch (reason) {
      setError({
        id: folder.id,
        message: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Not on this machine" className="px-1 pb-2">
      <h2 className="px-3 pt-1 pb-1 text-xs font-medium text-muted-foreground">
        Not on this machine
      </h2>
      <ul className="space-y-1">
        {pending.map((folder) => (
          <li key={folder.id} className="px-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {folder.name}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={busy !== null}
                onClick={() => void locate(folder)}
              >
                Locate…
              </Button>
            </div>
            {error?.id === folder.id && (
              <p className="pt-1 text-xs text-destructive">{error.message}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

import { useState } from "react"
import { ArrowUpCircle } from "lucide-react"

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
import { installLabel, pendingUpdate, useUpdates } from "@/lib/updates"
import { UpdateProgressBar } from "./update-progress"

/**
 * "Update to 1.0.20", in the status bar, and the sheet that explains what
 * pressing it does.
 *
 * In the footer beside the machine's meters rather than as a banner over the
 * workbench, and for the same reason those are there: this is a thing to
 * glance at. A release is not an event in whatever the user is in the middle
 * of, and an app that says so by covering the composer has misjudged whose
 * time is whose. The pill is gone entirely when there is nothing to install —
 * "you are up to date" is not news, and Settings › Updates is where somebody
 * who wants to hear it anyway can ask.
 *
 * The confirmation is not ceremony: the install quits the app. Anything
 * unsaved in a terminal or a running process goes with it, and a one-click
 * pill that did that without saying so would be a trap.
 */
export function UpdatePill() {
  const update = useUpdates((state) => pendingUpdate(state))
  const installing = useUpdates((state) => state.installing)
  const progress = useUpdates((state) => state.progress)
  const error = useUpdates((state) => state.error)
  const install = useUpdates((state) => state.install)
  const dismiss = useUpdates((state) => state.dismiss)
  const [open, setOpen] = useState(false)

  if (!update) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Visual Studio Claude ${update.version} is available. You are on ${update.current}.`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium text-primary outline-none hover:bg-primary/20 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowUpCircle className="size-3 shrink-0" />
        {/* The percentage reaches the pill too, not only the sheet: the sheet
            can be closed while the download runs, and this is then the one
            thing on screen saying it still is. */}
        {installing
          ? installLabel(installing, progress)
          : `Update to ${update.version}`}
      </button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Update to Visual Studio Claude {update.version}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {update.installable ? (
                <>
                  Visual Studio Claude will quit, install {update.version} into{" "}
                  <code className="font-mono">/Applications</code> and reopen —
                  the same <code className="font-mono">install.sh</code> the
                  README hands you, run from inside the app. Terminal sessions
                  and anything running in the dock end with it.
                </>
              ) : (
                <>
                  Installing from inside the app is macOS only. The release page
                  has the build for this machine.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* An anchor, not an IPC call: main's window-open handler is what
              hands an http(s) link to the browser. */}
          <p className="text-xs text-muted-foreground">
            You are on {update.current}.{" "}
            <a
              href={update.url}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              What&rsquo;s new in {update.version}
            </a>
          </p>

          {installing && (
            <div className="space-y-1.5">
              <UpdateProgressBar progress={progress} />
              <p className="text-xs text-muted-foreground">
                {progress?.stage === "installing"
                  ? "Visual Studio Claude is quitting to replace itself, and reopens when it is done."
                  : `Downloading Visual Studio Claude ${update.version}. Nothing has been replaced yet.`}
              </p>
            </div>
          )}

          {error && (
            <p className="text-xs leading-relaxed text-destructive">{error}</p>
          )}

          <AlertDialogFooter>
            {/* Dismissing is per version, and says so — the pill comes back
                for the next release rather than never again. */}
            <AlertDialogCancel onClick={() => dismiss()}>
              Skip {update.version}
            </AlertDialogCancel>
            {update.installable ? (
              <AlertDialogAction
                disabled={installing}
                onClick={(event) => {
                  // Held open: if the installer will not start, its message is
                  // the only thing that says why, and this dialog is where it
                  // is drawn.
                  event.preventDefault()
                  void install()
                }}
              >
                {installLabel(installing, progress)}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                render={
                  <a href={update.url} target="_blank" rel="noreferrer" />
                }
              >
                Open the release
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

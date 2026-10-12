import { useEffect } from "react"
import { create } from "zustand"

import type { UpdateCheck, UpdateProgress } from "@shared/api"
import { recall, remember } from "./tab-memory"

/**
 * Whether there is a newer Visual Studio Claude, and the one button that installs it.
 *
 * The check itself is `main/updater.ts`; what is here is when it is asked and
 * what the answer is allowed to do to the window. Both of those are deliberate:
 *
 * - **Once at launch and then every six hours.** A release is cut a handful of
 *   times a month, so anything more often is asking GitHub a question whose
 *   answer cannot have changed. The anonymous API also allows 60 requests an
 *   hour per address, and this app is not the only thing on a developer's
 *   machine spending them.
 * - **Nothing ever pops up.** The answer becomes a pill in the status bar, and
 *   a section in Settings for somebody who came looking. An update is not an
 *   interruption — the app was doing something when the check came back, and
 *   whatever it was, it was more important than this.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** The version whose pill was dismissed. A newer one is a new pill: dismissing
 * 1.0.20 says "not now", not "stop telling me about releases". */
const DISMISSED_KEY = "workbench.update-dismissed"

function isVersion(value: unknown): value is string {
  return typeof value === "string"
}

type UpdatesState = {
  /** Null until the first check comes back. */
  check: UpdateCheck | null
  checking: boolean
  /**
   * The installer has been started. There is no "finished": its next act is
   * quitting this app, so the honest end of this state is the window closing.
   */
  installing: boolean
  /** How far it has got, pushed by main. Null until the first byte and while
   * nothing is installing. */
  progress: UpdateProgress | null
  /** Why the installer would not start, or the download failed. Never a failure
   * of the install itself, which happens after this process is gone — that is in
   * `~/.vsclaude/update.log`. */
  error: string | null
  dismissed: string | null

  refresh: () => Promise<void>
  install: () => Promise<void>
  dismiss: () => void
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  check: null,
  checking: false,
  installing: false,
  progress: null,
  error: null,
  dismissed: null,

  async refresh() {
    if (get().checking) return
    set({ checking: true })
    try {
      const check = await window.desktop.checkForUpdate()
      set({ check })
    } catch (error) {
      // A rejection here is the IPC call failing rather than GitHub — main
      // answers an unreachable GitHub as `unknown`. Either way it is not worth
      // a dialog, so it lands in the same place.
      set({
        check: {
          status: "unknown",
          current: get().check?.current ?? "",
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      set({ checking: false })
    }
  },

  async install() {
    const check = get().check
    if (check?.status !== "available") return
    set({ installing: true, progress: null, error: null })
    try {
      await window.desktop.installUpdate(check.version)
    } catch (error) {
      set({
        installing: false,
        // Cleared with it: a bar left at 63% under an error message reads as
        // "still going", and it is not.
        progress: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // No success branch: the installer quits this app on its way through, so
    // `installing` staying true is what actually happens.
  },

  dismiss() {
    const check = get().check
    if (check?.status !== "available") return
    set({ dismissed: check.version })
    remember(DISMISSED_KEY, check.version)
  },
}))

/**
 * The release worth showing a button for, or null.
 *
 * One place answers "is there an update", so the pill and the Settings section
 * cannot disagree about it — and the Settings section deliberately passes
 * `dismissed: false`, since somebody reading that page has come to ask.
 */
export function pendingUpdate(
  state: UpdatesState,
  respectDismissal = true
): Extract<UpdateCheck, { status: "available" }> | null {
  const { check, dismissed } = state
  if (check?.status !== "available") return null
  if (respectDismissal && dismissed === check.version) return null
  return check
}

/**
 * The download's percentage, or null when there is no honest number.
 *
 * Null covers three cases the bar draws the same way — indeterminate: nothing
 * installing, a release that did not say how large its asset is, and the
 * `installing` stage, which is `install.sh` mounting and copying with this app
 * being quit somewhere in the middle. Rounded, and clamped, because a
 * `content-length` that disagrees with the bytes arriving should not put 101%
 * on screen.
 */
export function downloadPercent(
  progress: UpdateProgress | null
): number | null {
  if (progress?.stage !== "downloading") return null
  if (progress.total <= 0) return null
  return Math.min(100, Math.round((progress.received / progress.total) * 100))
}

/**
 * What the install button says, in one place — the pill and Settings both draw
 * it, and two spellings of "Downloading 42%" that drifted apart would be a bug
 * nobody would ever notice.
 */
export function installLabel(
  installing: boolean,
  progress: UpdateProgress | null
): string {
  if (!installing) return "Update and reopen"
  if (progress?.stage === "installing") return "Installing…"
  const percent = downloadPercent(progress)
  return percent === null ? "Downloading…" : `Downloading ${percent}%`
}

/**
 * Starts the timer, once for the window, and keeps it while anything is
 * mounted that would draw the answer — the same shape `useSystemUsage` uses,
 * for the same reason: two components asking would be two schedules.
 */
let timer: ReturnType<typeof setInterval> | null = null
let watchers = 0

export function useUpdateWatch(): void {
  useEffect(() => {
    // Per mount rather than beside the timer: an unsubscribe is what the effect
    // returns, and progress only arrives while a button somebody pressed is on
    // screen anyway.
    const stop = window.desktop.onUpdateProgress((progress) => {
      useUpdates.setState({ progress })
    })
    watchers += 1
    if (!timer) {
      void recall(DISMISSED_KEY, isVersion).then((dismissed) => {
        // Before the first answer can arrive, so a dismissed version never
        // flashes as a pill on the way in.
        useUpdates.setState({ dismissed })
        void useUpdates.getState().refresh()
      })
      timer = setInterval(
        () => void useUpdates.getState().refresh(),
        CHECK_INTERVAL_MS
      )
    }
    return () => {
      stop()
      watchers -= 1
      if (watchers === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }, [])
}

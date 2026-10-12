import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useTheme } from "next-themes"

import {
  loadDrawing,
  saveDrawing,
  type DrawingScene,
} from "@/lib/note/drawings"
import {
  stampBadge,
  loadBadgeFont,
  PLAIN_FONT_FAMILY,
  type DrawingAppState,
} from "@/lib/note/badges"

/**
 * What a shape drawn on one of this studio's canvases looks like.
 *
 * Excalidraw is a whiteboard, and its defaults say so: every shape comes out
 * sketched — an outline that wobbles off true and a hand-drawn font — which
 * reads as charm on a whiteboard and as a badly drawn rectangle on a diagram of
 * an API. Roughness 0 is the straightest of the three it offers, and Liberation
 * Sans is a label meant to be read rather than admired.
 *
 * These are the studio's, not the drawing's, and so are forced over whatever a
 * scene was saved with, exactly as `theme` below is. The cost is that changing
 * the sloppiness or the font inside a drawing lasts as long as that drawing is
 * open and no longer; the alternative — a default that only applies to a canvas
 * nobody has saved yet — leaves every drawing made before today sketched, which
 * is the thing being fixed.
 */
const PLAIN_DEFAULTS = {
  currentItemRoughness: 0,
  currentItemFontFamily: PLAIN_FONT_FAMILY,
  currentItemFontSize: 20,
}

/**
 * The rest of Excalidraw's module, once the chunk below has arrived.
 *
 * `convertToExcalidrawElements` and `CaptureUpdateAction` are wanted by the
 * badge button, which only exists inside a mounted canvas — so by the time
 * anything reads this it has been set. Kept here rather than imported at the
 * top so the two names do not drag the megabyte back into the studio's bundle.
 */
let excalidraw: typeof import("@excalidraw/excalidraw") | null = null

/**
 * Excalidraw itself, kept out of the studio's own bundle.
 *
 * It is around a megabyte of editor, and the overwhelming majority of sessions
 * never open a drawing. `React.lazy` is what makes the import a chunk of its
 * own; the spinner below is the second or two of loading it the first time.
 */
const Excalidraw = lazy(async () => {
  const module = await import("@excalidraw/excalidraw")
  excalidraw = module
  // Excalidraw resolves its own fonts against this. Left unset it reaches
  // esm.sh, which is a desktop app going to the network for a file it ships —
  // see the `excalidraw-fonts` plugin in `vite.config.ts` for what serves it.
  window.EXCALIDRAW_ASSET_PATH = "./excalidraw/"
  return { default: module.Excalidraw }
})

/** Loaded once, so a second drawing opens without the CSS flashing in. */
let stylesLoaded: Promise<unknown> | null = null
function loadStyles(): Promise<unknown> {
  stylesLoaded ??= import("@excalidraw/excalidraw/index.css")
  return stylesLoaded
}

type ExcalidrawApi = {
  getSceneElements: () => readonly unknown[]
  getAppState: () => DrawingAppState
  getFiles: () => Record<string, unknown>
  updateScene: (scene: {
    elements?: readonly unknown[]
    appState?: Record<string, unknown>
    captureUpdate?: string
  }) => void
  setActiveTool: (tool: { type: string }) => void
  /** Re-measures where the canvas sits on screen — see `settleOffsets` below. */
  refresh: () => void
}

/**
 * The drawing editor: Excalidraw's own canvas and its full toolbar — freehand,
 * shapes, arrows, text, and images dropped or pasted in — over the note.
 *
 * A dialog rather than a canvas embedded in the note itself. Excalidraw claims
 * the wheel for zoom, so a canvas in the middle of a scrolling document is
 * something the page cannot be scrolled past; and a drawing wants the room,
 * which a column of prose does not have.
 */
export function DrawingEditor({
  drawingId,
  onClose,
}: {
  drawingId: string
  onClose: () => void
}) {
  const { resolvedTheme } = useTheme()
  const [initial, setInitial] = useState<DrawingScene | null>(null)
  const [saving, setSaving] = useState(false)
  const api = useRef<ExcalidrawApi | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([loadDrawing(drawingId), loadStyles()]).then(([scene]) => {
      if (!cancelled) setInitial(scene)
    })
    return () => {
      cancelled = true
    }
  }, [drawingId])

  /**
   * The row of tools inside Excalidraw's toolbar, to portal the badge button
   * into — the one way there is to put a button in that island. Excalidraw
   * renders it itself and offers no slot: `renderTopRightUI` is beside the
   * island, `Footer` is below the canvas, and neither is the row of tools.
   *
   * So this is a DOM query against class names that are Excalidraw's, not this
   * app's, and the first thing to look at if the button ever goes missing after
   * an upgrade. What it is not is fragile in the other direction: the portal's
   * node is appended after everything React put there, and React removes only
   * the children it created, so a re-render of the toolbar leaves it alone.
   *
   * The observer is left running rather than disconnected on the first hit,
   * because the whole toolbar unmounts and comes back with view mode.
   */
  useEffect(() => {
    const host = surface.current
    if (!host || initial === null) return

    const find = () =>
      setToolbar(
        host.querySelector<HTMLElement>(".App-toolbar > .Stack_horizontal")
      )

    find()
    const observer = new MutationObserver(find)
    observer.observe(host, { childList: true, subtree: true })

    // Fetched now rather than on the click that needs it, so the first badge of
    // a session is measured against the real font like every one after it.
    void loadBadgeFont()

    return () => observer.disconnect()
  }, [initial])

  /**
   * Excalidraw measures the rect its canvas occupies once, when it mounts, and
   * every pointer event afterwards is read against that one measurement. The
   * dialog arrives on a `zoom-in-95` animation, so a canvas that mounts while
   * that is still running measures a box 5% too small and still moving, and
   * from then on the cursor and the shape under it are apart — a click at
   * (50, 50) landing at (47, 47), the whole canvas off by the scale.
   *
   * Which is why it was the *second* drawing that was wrong and never the
   * first: the first opening pays for the megabyte of editor below, which
   * outlasts the animation by an order of magnitude, so it mounts into a box
   * that has long since settled. Once that chunk and its CSS are cached, the
   * mount wins the race instead.
   *
   * Re-measuring when the animation ends covers both orders — whichever of the
   * two got there first, this runs after the box has stopped moving. It fires
   * on the closing animation too, and on any of Excalidraw's own UI animations
   * were the target not checked; a refresh costs one `getBoundingClientRect`,
   * but the check keeps it to the one element whose size is the question.
   */
  function settleOffsets(event: React.AnimationEvent<HTMLElement>) {
    if (event.target === event.currentTarget) api.current?.refresh()
  }

  /**
   * Drops the next numbered circle into the middle of the canvas.
   *
   * It arrives selected and with the pointer back on the selection tool, so the
   * gesture is stamp-and-drag rather than stamp, then go and find it.
   */
  async function addBadge() {
    const editor = api.current
    if (!editor || !excalidraw) return

    // Awaited even though the mount already asked: this is what makes a click
    // that beats the download measure the digit against the right font anyway.
    await loadBadgeFont()

    const { elements, ids, groupId } = stampBadge(
      excalidraw.convertToExcalidrawElements as never,
      editor.getSceneElements(),
      editor.getAppState()
    )
    editor.updateScene({
      elements,
      // The group as well as its two halves: selecting only the elements leaves
      // the badge without the group's own handles, which are what resize it as
      // one object rather than moving the circle out from under its digit.
      appState: {
        selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])),
        selectedGroupIds: { [groupId]: true },
      },
      // Anything else leaves the stamp out of the undo stack, so ⌘Z after one
      // would undo whatever was drawn before it instead.
      captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY,
    })
    editor.setActiveTool({ type: "selection" })
  }

  async function save() {
    const editor = api.current
    if (!editor || saving) return
    setSaving(true)

    // `collaborators` is a Map of who else is on the canvas — nobody here, and
    // not JSON: it would serialise to `{}` and be read back as a plain object
    // where Excalidraw expects a Map.
    const appState = { ...editor.getAppState() }
    delete appState.collaborators

    await saveDrawing(drawingId, {
      type: "excalidraw",
      version: 2,
      source: "vsclaude",
      elements: [...editor.getSceneElements()],
      appState,
      files: editor.getFiles(),
    })
    setSaving(false)
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {/* Far larger than the dialog's own default: this is a canvas, and one
          sized like a form would be a worse place to draw than a sheet of
          paper. */}
      <DialogContent
        className="flex h-[88vh] w-[92vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        onAnimationEnd={settleOffsets}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="text-sm">Drawing</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1" ref={surface}>
          {initial === null ? (
            <div className="grid h-full place-items-center">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="grid h-full place-items-center">
                  <Spinner className="size-4 text-muted-foreground" />
                </div>
              }
            >
              <Excalidraw
                excalidrawAPI={(instance: unknown) => {
                  api.current = instance as ExcalidrawApi
                }}
                initialData={{
                  elements: initial.elements as never,
                  appState: {
                    ...initial.appState,
                    ...PLAIN_DEFAULTS,
                    // Never restored from the scene: it is this app's setting,
                    // and a drawing saved in dark mode should not force the
                    // canvas dark for someone working in the light theme.
                    theme: resolvedTheme === "light" ? "light" : "dark",
                  } as never,
                  files: initial.files as never,
                  scrollToContent: true,
                }}
                // The canvas follows the studio's theme like everything else.
                theme={resolvedTheme === "light" ? "light" : "dark"}
                // Excalidraw's own name is not this app's, and there is nothing
                // behind these two here: the scene is a file in the workspace.
                UIOptions={{
                  canvasActions: { loadScene: false, saveToActiveFile: false },
                }}
              />
            </Suspense>
          )}

          {/* Excalidraw's own classes, not this app's: a button that sits among
              the shapes has to be one of them, down to the hover and the size
              the row shrinks its icons to on a narrow window. The divider is
              the one the extra-tools button already has, and says this is not a
              thirteenth shape. */}
          {toolbar &&
            createPortal(
              <>
                <div className="App-toolbar__divider" />
                <button
                  type="button"
                  className="ToolIcon ToolIcon_type_button"
                  title="Numbered badge"
                  onClick={() => void addBadge()}
                >
                  <div className="ToolIcon__icon" aria-label="Numbered badge">
                    {/* Drawn rather than taken from lucide: the toolbar's icons
                        are a 20-box stroked at 1.25, and one that is not reads
                        as heavier than everything beside it. */}
                    <svg
                      viewBox="0 0 20 20"
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      aria-hidden
                    >
                      <circle cx="10" cy="10" r="7.5" />
                      <text
                        x="10"
                        y="10"
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontFamily="Arial, Helvetica, sans-serif"
                        fontSize="9"
                        fontWeight="600"
                        fill="currentColor"
                        stroke="none"
                      >
                        1
                      </text>
                    </svg>
                  </div>
                </button>
              </>,
              toolbar
            )}
        </div>

        {/* `m-0` because `DialogFooter` carries `-mx-4 -mb-4`, sized to sit
            inside a `DialogContent` with `p-4` — and this one is `p-0`, so
            those margins pull the buttons out past the dialog's own right and
            bottom edges. `new-table-dialog.tsx` cancels them the same way. */}
        <DialogFooter className="m-0 shrink-0 border-t px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

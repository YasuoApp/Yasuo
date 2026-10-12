/**
 * The drawings a note's blocks point at.
 *
 * Not a zustand store, unlike everything else in `lib/`: a drawing is opened
 * from a block and from the slash menu, and both of those raise an event rather
 * than call a hook — the dialog that answers it is mounted somewhere else
 * entirely. So this is a cache and two subscriptions, and the React side uses
 * the same functions everything else does.
 */

/** What Excalidraw's own `.excalidraw` file holds. Only the fields this app
 * passes back and forth are named; the rest travel with them. */
export type DrawingScene = {
  type: "excalidraw"
  version: number
  source: string
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

/** A drawing nobody has drawn in yet. */
export function emptyScene(): DrawingScene {
  return {
    type: "excalidraw",
    version: 2,
    source: "vsclaude",
    elements: [],
    appState: {},
    files: {},
  }
}

/**
 * Scenes already read this session, so a note with a drawing in it does not go
 * back to disk every time the block is re-rendered — a theme change alone
 * re-renders every preview in the document.
 */
const cache = new Map<string, DrawingScene>()

/** Called when a drawing's scene changes, so previews of it redraw. */
const changed = new Set<(id: string) => void>()

/** Called when something asks for a drawing to be opened for editing. */
const opened = new Set<(id: string) => void>()

export function onDrawingChanged(listener: (id: string) => void): () => void {
  changed.add(listener)
  return () => changed.delete(listener)
}

/**
 * Subscribes to edit requests — what a block's Edit button raises and the
 * block editor answers by opening the dialog.
 *
 * An event rather than a callback passed down: the button is inside a node view
 * that Milkdown built, several layers below any React component that could have
 * handed it one.
 */
export function onDrawingOpened(listener: (id: string) => void): () => void {
  opened.add(listener)
  return () => opened.delete(listener)
}

export function openDrawing(id: string): void {
  for (const listener of opened) listener(id)
}

export function newDrawingId(): string {
  return crypto.randomUUID()
}

/** A drawing's scene, read once and then remembered. */
export async function loadDrawing(id: string): Promise<DrawingScene> {
  const cached = cache.get(id)
  if (cached) return cached

  let scene = emptyScene()
  try {
    const raw = await window.desktop.readDrawing(id)
    if (raw.trim()) scene = { ...emptyScene(), ...(JSON.parse(raw) as object) }
  } catch (error) {
    // A scene that will not parse is a file somebody edited by hand or a write
    // that was cut short. An empty canvas is recoverable — refusing to open the
    // note is not — and the next save replaces the file.
    console.error("Could not read the drawing", error)
  }

  cache.set(id, scene)
  // Once per session, for a scene that has something in it: the preview server
  // can only show a drawing this side has exported, and the drawings already in
  // the workspace were all drawn before there was an export to write. Reading
  // one is what opening the note it is in does, so that is where the backfill
  // belongs — the alternative is a pass over every scene at startup for a
  // preview that may never be asked for.
  if (scene.elements.length > 0) void exportDrawing(id, scene)
  return scene
}

/** What is already known about a drawing, without going to disk. */
export function peekDrawing(id: string): DrawingScene | undefined {
  return cache.get(id)
}

export async function saveDrawing(
  id: string,
  scene: DrawingScene
): Promise<void> {
  cache.set(id, scene)
  for (const listener of changed) listener(id)
  await window.desktop.writeDrawing(id, JSON.stringify(scene))
  await exportDrawing(id, scene)
}

/**
 * The picture beside the scene, for the preview server to inline.
 *
 * Here rather than in the block that already exports one on screen, because
 * this is the one place every save goes through — the dialog's, and the copies
 * `cloneDrawings` makes — and because the block's export follows the studio's
 * theme while the preview page has only the one. So: always the light
 * rendering, and always from the scene that was just written, so the two files
 * cannot disagree.
 *
 * Failing is not failing the save. The scene is the record and it is already on
 * disk; what is lost is a picture in a preview, which the next save replaces.
 */
async function exportDrawing(id: string, scene: DrawingScene): Promise<void> {
  try {
    const { exportToSvg } = await import("@excalidraw/excalidraw")
    const svg = await exportToSvg({
      elements: scene.elements as Parameters<typeof exportToSvg>[0]["elements"],
      appState: { ...scene.appState, exportWithDarkMode: false },
      files: scene.files as Parameters<typeof exportToSvg>[0]["files"],
      exportPadding: 8,
    })

    // The same sizing the block does inline, for the same reason: Excalidraw
    // writes its own width on the root element, and a preview page is a
    // measure rather than the scene's own pixel bounds.
    svg.removeAttribute("width")
    svg.removeAttribute("height")
    svg.style.width = "100%"
    svg.style.height = "auto"

    await window.desktop.writeDrawingSvg(id, svg.outerHTML)
  } catch (error) {
    console.error("Could not export the drawing", error)
  }
}

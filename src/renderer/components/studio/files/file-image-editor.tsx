import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  MoveUpRight,
  Pencil,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Scaling,
  Square,
  Undo2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useFiles } from "@/lib/files/store"
import {
  arrowHead,
  isCroppable,
  isValidSize,
  keepRatio,
  rectBetween,
  toImagePoint,
  turnedSize,
  type Point,
  type Rect,
  type Size,
} from "@/lib/files/image-edit"
import { cn } from "@/lib/utils"
import { encodableTypeOf } from "@shared/image-files"
import { IconButton } from "../icon-button"

type Tool = "crop" | "pen" | "rect" | "arrow"

/** What is being dragged out, in the picture's pixels. A crop outlives its
 * drag — it waits for Apply — and the strokes are committed on release. */
type Draft =
  | { tool: "pen"; points: Point[]; width: number }
  | { tool: "rect" | "arrow"; from: Point; to: Point; width: number }
  | { tool: "crop"; from: Point; to: Point }

/** How far back undo reaches. Each step is a whole canvas, and a 12MP photo is
 * ~48MB of one, so the ceiling is memory rather than patience. */
const MAX_HISTORY = 30

const WIDTHS = [2, 4, 8]

/**
 * A raster picture, edited where it is opened.
 *
 * Every step is a new canvas pushed onto a stack rather than a list of
 * operations replayed from the original: rotate, crop and a stroke compose in
 * an order that matters, and replaying is that order re-derived on every undo.
 * Nothing touches the file until Save, which writes the format the extension
 * names (`encodableTypeOf`) — so a `.jpg` stays a JPEG and loses what a JPEG
 * loses, as it would in any other editor.
 */
export function FileImageEditor({
  path,
  src,
  onClose,
}: {
  path: string
  src: string
  onClose: () => void
}) {
  const [history, setHistory] = useState<{
    stack: HTMLCanvasElement[]
    at: number
  }>({ stack: [], at: -1 })
  /** The step that is on disk — by identity rather than index, so the history
   * dropping its oldest step cannot move it. */
  const [saved, setSaved] = useState<HTMLCanvasElement | null>(null)
  const [tool, setTool] = useState<Tool | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [color, setColor] = useState("#ef4444")
  const [width, setWidth] = useState(WIDTHS[1]!)
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const view = useRef<HTMLCanvasElement>(null)
  const current = history.stack[history.at] ?? null
  const dirty = current !== saved

  /* Read once, on the way in. The store re-reads the file after a save, and
   * taking that as a fresh start would throw the undo history away for a
   * picture that is already what is on screen. */
  useEffect(() => {
    let live = true
    const image = new Image()
    image.onload = () => {
      if (!live) return
      const canvas = blank(image.naturalWidth, image.naturalHeight)
      canvas.getContext("2d")!.drawImage(image, 0, 0)
      setHistory({ stack: [canvas], at: 0 })
      setSaved(canvas)
    }
    image.onerror = () => live && setFailure("Could not decode this image.")
    image.src = src
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const push = useCallback((next: HTMLCanvasElement) => {
    setHistory(({ stack, at }) => {
      const kept = [...stack.slice(0, at + 1), next].slice(-MAX_HISTORY)
      return { stack: kept, at: kept.length - 1 }
    })
    setFailure(null)
  }, [])

  const undo = useCallback(() => {
    setDraft(null)
    setHistory((h) => ({ ...h, at: Math.max(0, h.at - 1) }))
  }, [])
  const redo = useCallback(() => {
    setDraft(null)
    setHistory((h) => ({ ...h, at: Math.min(h.stack.length - 1, h.at + 1) }))
  }, [])

  const cropRect =
    draft?.tool === "crop" && current
      ? rectBetween(draft.from, draft.to, current)
      : null
  const canCrop = isCroppable(cropRect)

  function applyCrop() {
    if (!current || !isCroppable(cropRect)) return
    push(cropped(current, cropRect))
    setDraft(null)
  }

  const save = useCallback(async () => {
    if (!current || saving) return
    const type = encodableTypeOf(path)
    if (!type) return
    setSaving(true)
    try {
      await window.desktop.writeImageFile(path, current.toDataURL(type, 0.92))
      setSaved(current)
      setFailure(null)
      // So the preview behind the editor is the file as it now is.
      void useFiles.getState().reload(path)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [current, path, saving])

  function close() {
    if (dirty && !window.confirm("Discard the unsaved changes to this image?"))
      return
    onClose()
  }

  /* The canvas on screen: the current step, and whatever is being dragged
   * drawn over it. */
  useEffect(() => {
    const canvas = view.current
    if (!canvas || !current) return
    if (canvas.width !== current.width) canvas.width = current.width
    if (canvas.height !== current.height) canvas.height = current.height
    const ctx = canvas.getContext("2d")!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(current, 0, 0)
    if (!draft) return
    if (draft.tool === "crop") {
      const rect = rectBetween(draft.from, draft.to, current)
      ctx.save()
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)"
      ctx.beginPath()
      ctx.rect(0, 0, canvas.width, canvas.height)
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.fill("evenodd")
      ctx.strokeStyle = "#fff"
      ctx.lineWidth = Math.max(1, canvas.width / 800)
      ctx.setLineDash([6 * ctx.lineWidth, 4 * ctx.lineWidth])
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
      ctx.restore()
      return
    }
    drawStroke(ctx, draft, color)
  }, [current, draft, color])

  function pointOf(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const box = event.currentTarget.getBoundingClientRect()
    return toImagePoint({ x: event.clientX, y: event.clientY }, box, current!)
  }

  /** The stroke's width in the picture's pixels, so a line looks the width
   * it was picked at whatever the picture has been shrunk to on screen. */
  function strokeWidth(event: React.PointerEvent<HTMLCanvasElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return (width * current!.width) / box.width
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!tool || !current || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const at = pointOf(event)
    if (tool === "crop") setDraft({ tool, from: at, to: at })
    else if (tool === "pen")
      setDraft({ tool, points: [at], width: strokeWidth(event) })
    else setDraft({ tool, from: at, to: at, width: strokeWidth(event) })
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId))
      return
    const at = pointOf(event)
    setDraft(
      draft.tool === "pen"
        ? { ...draft, points: [...draft.points, at] }
        : { ...draft, to: at }
    )
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!draft || !current) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    // A crop stays up for Apply; a stroke is done the moment it is let go.
    if (draft.tool === "crop") return
    const next = copied(current)
    drawStroke(next.getContext("2d")!, draft, color)
    push(next)
    setDraft(null)
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === "z") {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if (mod && key === "y") {
      event.preventDefault()
      redo()
    } else if (mod && key === "s") {
      event.preventDefault()
      void save()
    } else if (key === "enter" && canCrop) {
      event.preventDefault()
      applyCrop()
    } else if (key === "escape" && draft) {
      event.preventDefault()
      setDraft(null)
    }
  }

  function pick(next: Tool) {
    setDraft(null)
    setTool(tool === next ? null : next)
  }

  const strokes = tool === "pen" || tool === "rect" || tool === "arrow"

  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <ToolButton
          label="Crop"
          on={tool === "crop"}
          onClick={() => pick("crop")}
        >
          <Crop />
        </ToolButton>
        <ToolButton label="Pen" on={tool === "pen"} onClick={() => pick("pen")}>
          <Pencil />
        </ToolButton>
        <ToolButton
          label="Rectangle"
          on={tool === "rect"}
          onClick={() => pick("rect")}
        >
          <Square />
        </ToolButton>
        <ToolButton
          label="Arrow"
          on={tool === "arrow"}
          onClick={() => pick("arrow")}
        >
          <MoveUpRight />
        </ToolButton>

        <Divider />

        <IconButton
          label="Rotate left"
          disabled={!current}
          onClick={() => current && push(turned(current, -1))}
        >
          <RotateCcw />
        </IconButton>
        <IconButton
          label="Rotate right"
          disabled={!current}
          onClick={() => current && push(turned(current, 1))}
        >
          <RotateCw />
        </IconButton>
        <IconButton
          label="Flip horizontally"
          disabled={!current}
          onClick={() => current && push(flipped(current, "x"))}
        >
          <FlipHorizontal2 />
        </IconButton>
        <IconButton
          label="Flip vertically"
          disabled={!current}
          onClick={() => current && push(flipped(current, "y"))}
        >
          <FlipVertical2 />
        </IconButton>
        {current && (
          <ResizeButton
            size={current}
            onResize={(size) => push(resized(current, size))}
          />
        )}

        {strokes && (
          <>
            <Divider />
            <input
              type="color"
              aria-label="Colour"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="size-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            {WIDTHS.map((w) => (
              <ToolButton
                key={w}
                label={`${w}px`}
                on={width === w}
                onClick={() => setWidth(w)}
              >
                <span
                  className="block rounded-full bg-current"
                  style={{ width: w + 2, height: w + 2 }}
                />
              </ToolButton>
            ))}
          </>
        )}

        {tool === "crop" && (
          <>
            <Divider />
            <Button
              size="xs"
              variant="outline"
              disabled={!canCrop}
              onClick={applyCrop}
            >
              <Check /> Apply crop
            </Button>
          </>
        )}

        <span className="flex-1" />

        <IconButton label="Undo" disabled={history.at <= 0} onClick={undo}>
          <Undo2 />
        </IconButton>
        <IconButton
          label="Redo"
          disabled={history.at >= history.stack.length - 1}
          onClick={redo}
        >
          <Redo2 />
        </IconButton>
        <IconButton
          label="Save image"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          <Save />
        </IconButton>
        <IconButton label="Close editor" onClick={close}>
          <X />
        </IconButton>
      </div>

      {failure && (
        <p className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive">
          {failure}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <canvas
            ref={view}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              backgroundImage:
                "linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
            }}
            className={cn(
              "max-h-full max-w-full rounded-sm object-contain shadow-sm",
              tool && "cursor-crosshair touch-none"
            )}
          />
        </div>
      </div>

      {current && (
        <p className="shrink-0 border-t px-3 py-1.5 text-center font-mono text-[0.65rem] text-muted-foreground">
          {cropRect && canCrop
            ? `${cropRect.width} × ${cropRect.height} of `
            : ""}
          {current.width} × {current.height}
          {dirty && " · Unsaved"}
        </p>
      )}
    </div>
  )
}

function ToolButton({
  label,
  on,
  onClick,
  children,
}: {
  label: string
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <IconButton
      label={label}
      pressed={on}
      onClick={onClick}
      className={cn(on && "bg-accent text-accent-foreground")}
    >
      {children}
    </IconButton>
  )
}

function Divider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border" />
}

/** Width and height, the other following with the ratio kept unless it is
 * unlocked — a resize that stretches is the rarer thing to want. */
function ResizeButton({
  size,
  onResize,
}: {
  size: Size
  onResize: (size: Size) => void
}) {
  const [open, setOpen] = useState(false)
  const [next, setNext] = useState(size)
  const [locked, setLocked] = useState(true)

  function change(side: "width" | "height", value: number) {
    if (!Number.isFinite(value)) return
    setNext(
      locked
        ? keepRatio(size, side, value)
        : { ...next, [side]: Math.round(value) }
    )
  }

  const valid = isValidSize(next)

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) setNext(size)
      }}
    >
      <PopoverTrigger
        render={
          <IconButton label="Resize">
            <Scaling />
          </IconButton>
        }
      />
      <PopoverContent className="w-60">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!valid) return
            onResize(next)
            setOpen(false)
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              aria-label="Width"
              min={1}
              value={next.width}
              onChange={(event) => change("width", event.target.valueAsNumber)}
              className="h-7 font-mono text-xs"
            />
            <span className="text-xs text-muted-foreground">×</span>
            <Input
              type="number"
              aria-label="Height"
              min={1}
              value={next.height}
              onChange={(event) => change("height", event.target.valueAsNumber)}
              className="h-7 font-mono text-xs"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={locked}
              onChange={(event) => setLocked(event.target.checked)}
            />
            Keep aspect ratio
          </label>
          <Button size="sm" type="submit" disabled={!valid}>
            Resize
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function blank(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

function copied(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = blank(source.width, source.height)
  canvas.getContext("2d")!.drawImage(source, 0, 0)
  return canvas
}

function turned(source: HTMLCanvasElement, turn: 1 | -1): HTMLCanvasElement {
  const size = turnedSize(source)
  const canvas = blank(size.width, size.height)
  const ctx = canvas.getContext("2d")!
  ctx.translate(size.width / 2, size.height / 2)
  ctx.rotate((turn * Math.PI) / 2)
  ctx.drawImage(source, -source.width / 2, -source.height / 2)
  return canvas
}

function flipped(
  source: HTMLCanvasElement,
  axis: "x" | "y"
): HTMLCanvasElement {
  const canvas = blank(source.width, source.height)
  const ctx = canvas.getContext("2d")!
  if (axis === "x") {
    ctx.translate(source.width, 0)
    ctx.scale(-1, 1)
  } else {
    ctx.translate(0, source.height)
    ctx.scale(1, -1)
  }
  ctx.drawImage(source, 0, 0)
  return canvas
}

function cropped(source: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
  const canvas = blank(rect.width, rect.height)
  canvas
    .getContext("2d")!
    .drawImage(
      source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height
    )
  return canvas
}

function resized(source: HTMLCanvasElement, size: Size): HTMLCanvasElement {
  const canvas = blank(size.width, size.height)
  const ctx = canvas.getContext("2d")!
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(source, 0, 0, size.width, size.height)
  return canvas
}

/** One stroke, the same on the preview and on the step it is committed to —
 * two drawings of it would be a line that moves when it is let go. */
function drawStroke(
  ctx: CanvasRenderingContext2D,
  draft: Exclude<Draft, { tool: "crop" }>,
  color: string
) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = draft.width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.beginPath()
  if (draft.tool === "pen") {
    const [first, ...rest] = draft.points
    ctx.moveTo(first!.x, first!.y)
    // A single click is a dot, which a path of one point does not draw.
    if (rest.length === 0) ctx.lineTo(first!.x + 0.01, first!.y)
    for (const point of rest) ctx.lineTo(point.x, point.y)
  } else if (draft.tool === "rect") {
    const { from, to } = draft
    ctx.rect(from.x, from.y, to.x - from.x, to.y - from.y)
  } else {
    const { from, to } = draft
    const [left, right] = arrowHead(from, to, draft.width)
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.moveTo(left.x, left.y)
    ctx.lineTo(to.x, to.y)
    ctx.lineTo(right.x, right.y)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * The numbered circles stamped onto a drawing — the ①②③ of a screenshot
 * annotated in the order someone is meant to read it.
 *
 * Not a thirteenth tool in Excalidraw's toolbar: that island is a component of
 * its own and takes no additions, there being no prop anywhere in the editor's
 * API that puts a button in it. So a badge is stamped rather than drawn — the
 * button beside the toolbar drops the next number into the middle of the
 * canvas, already selected, to be dragged where it belongs.
 */

/**
 * The mark that makes a circle one of these rather than one somebody drew.
 *
 * `customData` is Excalidraw's own field for exactly this and survives the
 * `.excalidraw` file, which is what lets a drawing reopened tomorrow carry on
 * at 4 rather than starting again at 1. A counter held in React would not.
 */
const BADGE = "vsclaudeBadge"

/** The same mark in a drawing saved while the app was called Yasuo, read so
 * the count carries on there too. Never written. */
const LEGACY_BADGE = "yasuoBadge"

/** Excalidraw's red, for the transparent background a canvas starts on. */
const DEFAULT_FILL = "#e03131"

/**
 * The circle's diameter and the digit in it — an actual size now, and free to
 * be whatever looks right. Nothing measures the text against the circle any
 * more; see the group below for why that changed.
 */
const SIZE = 48
const FONT_SIZE = 20

/**
 * Nunito — what Excalidraw's own font picker calls "Normal". Its default is
 * Excalifont, the hand-drawn one: right for a sketch and wrong for a marker
 * whose whole job is to be read as a number, and wrong for the labels people
 * put on a diagram of an API, which is what this studio's drawings mostly are.
 * So the canvas takes it as its default too — see `drawing-editor.tsx`.
 *
 * **It has to be a font the picker offers.** Liberation Sans was here first,
 * being the plainest thing Excalidraw ships, and it is the one font that is not
 * for the browser at all: `serverSide: true`, filtered out of the picker, there
 * to render an export on a server. Nothing preloads it, because `loadSceneFonts`
 * only loads what a scene already contains — so the first text measured with it
 * was measured against whatever the browser substituted, and when the real file
 * finally arrived `Fonts.onLoaded` dropped the caches and re-fitted every bound
 * label, moving boxes that had already been put down. Which is what made this
 * canvas feel unlike excalidraw.com.
 *
 * The number Excalidraw's own `FONT_FAMILY` map gives it. Hard-coded rather
 * than imported for the same reason `convertToExcalidrawElements` is passed in.
 */
export const PLAIN_FONT_FAMILY = 6

/** The same font by the name `document.fonts` knows it by. The two have to
 * agree — Excalidraw builds this string from its own map. */
const PLAIN_FONT_NAME = "Nunito"

/** Every glyph a badge can ever need, which is all this has to fetch. */
const DIGITS = "0123456789"

/**
 * Fetches the digits before anything measures them.
 *
 * A stamp measures its text the instant it is made, and Excalidraw preloads
 * only the families a scene already contains — so the first badge on a fresh
 * drawing was measured against whatever the browser substitutes for a font it
 * has not fetched yet, and the width and height it came out with were wrong.
 *
 * A **bound** label would have recovered: `Fonts.onLoaded` re-fits those when
 * the real file lands. A standalone text is only re-rendered, never
 * re-measured, so the wrong size is the size it keeps and the digit sits off
 * its circle for good. Hence loading it up front rather than fixing it after.
 *
 * Not memoised: `document.fonts.check` is the memo, and it answers for the
 * browser's own cache rather than for whether this function has run — which
 * matters because it can be called before Excalidraw has registered the face,
 * where a remembered promise would be a remembered no-op.
 */
export async function loadBadgeFont(): Promise<void> {
  const font = `${FONT_SIZE}px ${PLAIN_FONT_NAME}`
  if (document.fonts.check(font, DIGITS)) return
  try {
    await document.fonts.load(font, DIGITS)
  } catch (error) {
    // A badge in a substituted font is off-centre; one that threw here is not
    // stamped at all. The first is the better failure.
    console.error("Could not load the badge font", error)
  }
}

/**
 * How far each stamp lands from the last. Every badge arrives at the centre of
 * the view, so without the step a run of them stamped before any is moved
 * would leave four circles hidden under the fifth.
 */
const CASCADE = 18

/** The appState fields a stamp is placed from. */
export type DrawingAppState = Record<string, unknown> & {
  scrollX: number
  scrollY: number
  width: number
  height: number
  zoom: { value: number }
  currentItemBackgroundColor: string
}

type SceneElement = {
  id: string
  x: number
  y: number
  width: number
  height: number
  customData?: Record<string, unknown> | null
}

/** `convertToExcalidrawElements`, passed in rather than imported: Excalidraw is
 * a lazy chunk, and importing it here would pull the megabyte back into the
 * studio's own bundle. */
type Convert = (skeletons: unknown[]) => readonly SceneElement[]

/** The number the next badge gets: one past the highest already on the canvas,
 * so deleting the last one hands its number back. */
export function nextBadgeNumber(elements: readonly unknown[]): number {
  let highest = 0
  for (const element of elements) {
    const data = (element as SceneElement | null)?.customData
    const stamped = data?.[BADGE] ?? data?.[LEGACY_BADGE]
    if (typeof stamped === "number" && stamped > highest) highest = stamped
  }
  return highest + 1
}

/**
 * Whether a number written in `ink` would be read against `fill`.
 *
 * The badge takes the background colour chosen in Excalidraw's own panel, and
 * white on its pale yellow is a badge with nothing legible in it. Rec. 601
 * luma, which is coarse but decides this one question the same way an eye does.
 */
function inkFor(fill: string): string {
  const hex = fill.replace("#", "")
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex
  if (full.length !== 6) return "#ffffff"

  const red = parseInt(full.slice(0, 2), 16)
  const green = parseInt(full.slice(2, 4), 16)
  const blue = parseInt(full.slice(4, 6), 16)
  const luma = (red * 299 + green * 587 + blue * 114) / 1000
  return luma > 140 ? "#1e1e1e" : "#ffffff"
}

export type StampedBadge = {
  /** The scene as it should now be — every element, the new badge last. */
  elements: readonly unknown[]
  /** The circle and its digit, to select so the badge can be dragged into place. */
  ids: string[]
  /** The group holding those two, which is what a click on either selects. */
  groupId: string
}

/** Adds the next numbered badge to `elements`, at the centre of the view. */
export function stampBadge(
  convert: Convert,
  elements: readonly unknown[],
  appState: DrawingAppState
): StampedBadge {
  const number = nextBadgeNumber(elements)

  const zoom = appState.zoom?.value || 1
  const centreX = appState.width / 2 / zoom - appState.scrollX
  const centreY = appState.height / 2 / zoom - appState.scrollY
  const step = ((number - 1) % 5) * CASCADE

  const chosen = appState.currentItemBackgroundColor
  const fill = !chosen || chosen === "transparent" ? DEFAULT_FILL : chosen

  /*
   * A circle and a digit in a **group**, rather than an ellipse with a bound
   * label — and the difference is the whole behaviour of the thing.
   *
   * A bound label does not scale with what contains it. Excalidraw resizes the
   * container and then re-fits the label to it, growing the container's height
   * and its width in two separate branches when the text no longer fits — one
   * axis at a time, which on a circle means an oval, and a digit that stays
   * 20px however small the circle gets. `resizeMultipleElements`, which is what
   * a group goes through, does neither: `keepAspectRatio` is forced the moment a
   * selection holds a text element or anything grouped, so the circle cannot be
   * squashed, and `isTextElement` there scales `fontSize` with everything else.
   * A badge resizes as one object, without holding Shift.
   *
   * What the group gives up is nothing: a standalone text that is centred and
   * middle-aligned re-centres itself on edit — `getAdjustedDimensions` offsets
   * it by half of what it grew — so 9 becoming 10 stays over the circle.
   */
  const groupId = crypto.randomUUID()
  const x = centreX - SIZE / 2 + step
  const y = centreY - SIZE / 2 + step

  const [circle, digit] = convert([
    {
      type: "ellipse",
      x,
      y,
      width: SIZE,
      height: SIZE,
      strokeColor: fill,
      backgroundColor: fill,
      fillStyle: "solid",
      // A marker is not a sketch. Excalidraw's default roughness wobbles the
      // outline, which on a circle this small reads as a badly drawn one.
      roughness: 0,
      groupIds: [groupId],
      customData: { [BADGE]: number },
    },
    {
      type: "text",
      // Placed once its measured size is known, below.
      x,
      y,
      text: String(number),
      fontSize: FONT_SIZE,
      fontFamily: PLAIN_FONT_FAMILY,
      strokeColor: inkFor(fill),
      // Both are needed for the re-centring on edit, and neither is a default.
      textAlign: "center",
      verticalAlign: "middle",
      groupIds: [groupId],
    },
  ])
  if (!circle || !digit) return { elements, ids: [], groupId }

  return {
    elements: [
      ...elements,
      circle,
      {
        ...digit,
        x: x + (SIZE - digit.width) / 2,
        y: y + (SIZE - digit.height) / 2,
      },
    ],
    ids: [circle.id, digit.id],
    groupId,
  }
}

/**
 * How the studio looks, past light and dark: the accent, the two typefaces,
 * the base size and how tightly the rows sit.
 *
 * Everything here is pure except `applyAppearance`, which is the one place the
 * choice touches the document — a handful of attributes and custom properties
 * on `<html>` that `styles/globals.css` reads. Pure so `test/appearance.ts` can
 * hold the tables without a DOM, and so the terminal, which takes a font
 * string rather than a CSS variable, can ask `monoFontFamily` for the same
 * stack the editors get.
 *
 * `lib/settings.ts` holds the choice and this file says what it means; this
 * file does not read the store, so the store can import the guards below
 * without a cycle.
 */

export const ACCENT_PALETTES = [
  "indigo",
  "graphite",
  "teal",
  "rose",
  "amber",
] as const
export type AccentPalette = (typeof ACCENT_PALETTES)[number]

export const SANS_FONTS = [
  "system",
  "inter",
  "sf-pro",
  "segoe",
  "roboto",
] as const
export type SansFont = (typeof SANS_FONTS)[number]

export const MONO_FONTS = [
  "system",
  "jetbrains",
  "fira",
  "cascadia",
  "menlo",
  "sf-mono",
] as const
export type MonoFont = (typeof MONO_FONTS)[number]

export const FONT_SIZES = ["small", "default", "large"] as const
export type FontSize = (typeof FONT_SIZES)[number]

export const DENSITIES = ["compact", "comfortable", "spacious"] as const
export type Density = (typeof DENSITIES)[number]

/** The appearance half of the settings store — what `applyAppearance` reads. */
export type Appearance = {
  palette: AccentPalette
  fontSans: SansFont
  fontMono: MonoFont
  fontSize: FontSize
  density: Density
}

export const DEFAULT_APPEARANCE: Appearance = {
  palette: "indigo",
  fontSans: "system",
  fontMono: "system",
  fontSize: "default",
  density: "comfortable",
}

export function isAccentPalette(value: unknown): value is AccentPalette {
  return (ACCENT_PALETTES as readonly unknown[]).includes(value)
}
export function isSansFont(value: unknown): value is SansFont {
  return (SANS_FONTS as readonly unknown[]).includes(value)
}
export function isMonoFont(value: unknown): value is MonoFont {
  return (MONO_FONTS as readonly unknown[]).includes(value)
}
export function isFontSize(value: unknown): value is FontSize {
  return (FONT_SIZES as readonly unknown[]).includes(value)
}
export function isDensity(value: unknown): value is Density {
  return (DENSITIES as readonly unknown[]).includes(value)
}

/** What the swatches and the pickers call each choice. */
export const PALETTE_LABELS: Record<AccentPalette, string> = {
  indigo: "Indigo",
  graphite: "Graphite",
  teal: "Teal",
  rose: "Rose",
  amber: "Amber",
}

export const SANS_FONT_LABELS: Record<SansFont, string> = {
  system: "System UI",
  inter: "Inter",
  "sf-pro": "SF Pro / Helvetica Neue",
  segoe: "Segoe UI",
  roboto: "Roboto",
}

export const MONO_FONT_LABELS: Record<MonoFont, string> = {
  system: "System mono",
  jetbrains: "JetBrains Mono",
  fira: "Fira Code",
  cascadia: "Cascadia Code",
  menlo: "Menlo",
  "sf-mono": "SF Mono",
}

/*
 * The two stacks `index.css` paints the first frame with, before any setting
 * has been read. They are repeated there as literals because that frame is
 * drawn before this module runs; `applyAppearance` then writes the same string
 * back over it, so the two cannot disagree past the first paint. A picked
 * family goes in front of the stack rather than replacing it: a machine
 * without the font falls through to what it would have had.
 */
const SYSTEM_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const SYSTEM_MONO =
  'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace'

/** The families a choice puts ahead of the system stack, quoted for CSS. */
const SANS_FAMILIES: Record<SansFont, string | null> = {
  system: null,
  inter: '"Inter", "Inter Variable"',
  "sf-pro": '"SF Pro Text", "SF Pro Display", "Helvetica Neue"',
  segoe: '"Segoe UI", "Segoe UI Variable"',
  roboto: '"Roboto"',
}

const MONO_FAMILIES: Record<MonoFont, string | null> = {
  system: null,
  jetbrains: '"JetBrains Mono"',
  fira: '"Fira Code"',
  cascadia: '"Cascadia Code", "Cascadia Mono"',
  menlo: '"Menlo"',
  "sf-mono": '"SF Mono", "SFMono-Regular"',
}

/** The full `font-family` value for the interface, fallbacks included. */
export function sansFontFamily(font: SansFont): string {
  const family = SANS_FAMILIES[font] ?? null
  return family ? `${family}, ${SYSTEM_SANS}` : SYSTEM_SANS
}

/** The full `font-family` value for code — the editors, the diff, and the
 * terminal, which must be handed a string rather than a `var()`. */
export function monoFontFamily(font: MonoFont): string {
  const family = MONO_FAMILIES[font] ?? null
  return family ? `${family}, ${SYSTEM_MONO}` : SYSTEM_MONO
}

/**
 * The root `font-size`, which every `rem` in the studio is a multiple of —
 * Tailwind's spacing scale included, so a larger size widens the rows and the
 * paddings with the text rather than leaving a bigger label in the same box.
 * `16px` is the browser's own default written down, not a change to it.
 */
export function rootFontSize(size: FontSize): string {
  switch (size) {
    case "small":
      return "14px"
    case "large":
      return "18px"
    default:
      return "16px"
  }
}

/**
 * The custom properties a density sets, as `globals.css` reads them: a
 * sidebar row's height, the gap between a transcript's turns, and the tab
 * strip's height.
 *
 * Here rather than as three `[data-density]` blocks in the stylesheet so the
 * table has one home a test can read; the stylesheet carries only the
 * comfortable defaults, for the frame before the setting has been applied.
 */
export function densityVars(density: Density): Record<string, string> {
  switch (density) {
    case "compact":
      return {
        "--density-row": "1.25rem",
        "--density-gap": "0.5rem",
        "--density-tab": "2rem",
      }
    case "spacious":
      return {
        "--density-row": "1.75rem",
        "--density-gap": "1rem",
        "--density-tab": "2.5rem",
      }
    default:
      return {
        "--density-row": "1.5rem",
        "--density-gap": "0.75rem",
        "--density-tab": "2.25rem",
      }
  }
}

/**
 * Writes the choice onto `<html>`, where the stylesheet's `[data-palette]` and
 * `[data-density]` rules and the `--font-*` properties are read from.
 *
 * Each write is skipped when nothing changed: this runs on every change to the
 * settings store, most of which are about something else, and an inline style
 * rewritten with its own value is still a style invalidation of the whole
 * tree.
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement
  setAttribute(root, "data-palette", appearance.palette)
  setAttribute(root, "data-density", appearance.density)
  setProperty(root, "--font-sans", sansFontFamily(appearance.fontSans))
  setProperty(root, "--font-mono", monoFontFamily(appearance.fontMono))
  setProperty(root, "font-size", rootFontSize(appearance.fontSize))
  for (const [name, value] of Object.entries(densityVars(appearance.density))) {
    setProperty(root, name, value)
  }
}

function setAttribute(root: HTMLElement, name: string, value: string) {
  if (root.getAttribute(name) !== value) root.setAttribute(name, value)
}

function setProperty(root: HTMLElement, name: string, value: string) {
  if (root.style.getPropertyValue(name) !== value) {
    root.style.setProperty(name, value)
  }
}

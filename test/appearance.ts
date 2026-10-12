import {
  ACCENT_PALETTES,
  DEFAULT_APPEARANCE,
  DENSITIES,
  densityVars,
  FONT_SIZES,
  isAccentPalette,
  isDensity,
  isFontSize,
  isMonoFont,
  isSansFont,
  MONO_FONT_LABELS,
  MONO_FONTS,
  monoFontFamily,
  PALETTE_LABELS,
  rootFontSize,
  SANS_FONT_LABELS,
  SANS_FONTS,
  sansFontFamily,
  type Density,
} from "../src/renderer/lib/appearance"
import { check, finish, section } from "./harness"

/**
 * The tables behind Settings › Appearance.
 *
 * Worth a test because each is read from more than one place — the font stack
 * by the editors and (later) the terminal, the density by the stylesheet's
 * defaults — and the failure when they drift is a window that is almost
 * right: a terminal in a different face from the diff beside it, a sidebar
 * whose rows no longer match the gap the setting promised.
 */

section("font stacks")

const systemSans = sansFontFamily("system")
check(
  "system sans is the stack index.css paints first",
  systemSans.startsWith("ui-sans-serif, system-ui") &&
    systemSans.endsWith("sans-serif"),
  systemSans
)
check(
  "a picked sans goes in front of the system stack, not instead of it",
  sansFontFamily("inter").startsWith('"Inter"') &&
    sansFontFamily("inter").endsWith(systemSans),
  sansFontFamily("inter")
)

const systemMono = monoFontFamily("system")
check(
  "system mono is the stack index.css paints first",
  systemMono.startsWith("ui-monospace") && systemMono.endsWith("monospace"),
  systemMono
)
check(
  "a picked mono goes in front of the system stack",
  monoFontFamily("jetbrains").startsWith('"JetBrains Mono"') &&
    monoFontFamily("jetbrains").endsWith(systemMono),
  monoFontFamily("jetbrains")
)
check(
  "every family is quoted, so a space in a name survives a canvas font string",
  [...SANS_FONTS, ...MONO_FONTS]
    .filter((font) => font !== "system")
    .every((font) => {
      const stack = isMonoFont(font)
        ? monoFontFamily(font)
        : sansFontFamily(font as Exclude<typeof font, "system">)
      return stack.startsWith('"')
    })
)
check(
  "a family unknown to this build falls back to the system stack",
  // What an older or newer bag might have written: not a crash, not a blank.
  sansFontFamily("comic" as never) === systemSans &&
    monoFontFamily("comic" as never) === systemMono
)

section("font size")

check("default is the browser's 16px", rootFontSize("default") === "16px")
check(
  "small and large step either side of it",
  parseInt(rootFontSize("small")) < 16 && parseInt(rootFontSize("large")) > 16
)
check(
  "every size is a pixel length the root can take",
  FONT_SIZES.every((size) => /^\d+px$/.test(rootFontSize(size)))
)

section("density")

const names = ["--density-row", "--density-gap", "--density-tab"]
check(
  "every density sets the same three properties",
  DENSITIES.every((density) =>
    names.every((name) => name in densityVars(density))
  ),
  DENSITIES.map((density) => Object.keys(densityVars(density)))
)
// A missing property reads as `NaN`, which fails the comparison below rather
// than passing it by accident.
const rem = (density: Density, name: string) =>
  parseFloat(densityVars(density)[name] ?? "")
for (const name of names) {
  check(
    `${name} grows from compact to spacious`,
    rem("compact", name) < rem("comfortable", name) &&
      rem("comfortable", name) < rem("spacious", name)
  )
}
check(
  "comfortable is what globals.css paints before the setting lands",
  densityVars("comfortable")["--density-row"] === "1.5rem" &&
    densityVars("comfortable")["--density-gap"] === "0.75rem" &&
    densityVars("comfortable")["--density-tab"] === "2.25rem"
)

section("guards and labels")

check(
  "the defaults pass their own guards",
  isAccentPalette(DEFAULT_APPEARANCE.palette) &&
    isSansFont(DEFAULT_APPEARANCE.fontSans) &&
    isMonoFont(DEFAULT_APPEARANCE.fontMono) &&
    isFontSize(DEFAULT_APPEARANCE.fontSize) &&
    isDensity(DEFAULT_APPEARANCE.density)
)
check(
  "a stranger is refused by every guard",
  !isAccentPalette("violet") &&
    !isSansFont("comic") &&
    !isMonoFont("comic") &&
    !isFontSize("huge") &&
    !isDensity("cosy") &&
    !isAccentPalette(null) &&
    !isDensity(undefined)
)
check(
  "every palette and font has a label for the dialog",
  ACCENT_PALETTES.every((palette) => PALETTE_LABELS[palette]) &&
    SANS_FONTS.every((font) => SANS_FONT_LABELS[font]) &&
    MONO_FONTS.every((font) => MONO_FONT_LABELS[font])
)

finish()

/**
 * The one kind of thing the workbench opens: a file.
 *
 * **It was three** — a file, a table and a request — first as the activity
 * rail's icons, then as the right-hand panel's tabs, then as two panels in
 * windows of their own. The Database and API panels are deleted (`docs/design.md`
 * § Database and API, removed) and a fourth, `note`, went with the Notes panel
 * before them. What is left is the Explorer.
 *
 * The type stays rather than being folded into a string, because it is what
 * `Pane` in `lib/store.ts` is built out of and what `SECTIONS` in
 * `components/studio/section-marks.tsx` keys a label, an icon and a hue by. A
 * union of one is also the honest shape: the next kind to arrive is an entry
 * here and a compiler error at every point that assumed there was only ever
 * one.
 */
export type Section = "files"

/** Every kind, in the app's own order — see `SECTIONS` in
 * `components/studio/section-marks.tsx`, which is this list with a label, an
 * icon and a hue against each id. */
export const SECTION_IDS: Section[] = ["files"]

export function isSection(value: string): value is Section {
  return (SECTION_IDS as string[]).includes(value)
}

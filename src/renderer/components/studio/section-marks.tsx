import type { ComponentType } from "react"
import { FolderTree } from "lucide-react"

import { SECTION_IDS, type Section } from "@/lib/sections"

/**
 * The three ways into the studio, and how each is drawn.
 *
 * Data rather than a component, and its own module because six other files
 * want the hues and the icons — the pane's empty states, the sidebar headers,
 * the Settings dialog. It has now outlived two bars that were named after it:
 * the activity rail, and the row of tabs on the right-hand panel that replaced
 * it. The lists live in three places today — the Explorer is the right-hand
 * panel, Database and API have a window each — and a hue that says "this is a
 * table" is the same hue wherever the table is listed.
 *
 * Ordered the way the work goes: the folders themselves, then the data and the
 * endpoints behind them.
 *
 * **There is no Terminal section**, and there is no Terminal panel either: a
 * shell is a tab of the dock, pointed at whichever project was last clicked,
 * and an agent's work happens in a project's chat — which draws in a pane of
 * its own with no sidebar of its own.
 *
 * Explorer is first because it is the workspace's own contents — the folders
 * every other panel is about — and because it is the section somebody reaches
 * for without having decided what they are doing yet.
 *
 * `Icon` is typed by the one prop the tabs pass rather than as a Lucide icon,
 * so a hand-drawn mark could sit beside the glyphs. The ids themselves are
 * `SECTION_IDS` in `lib/rail.ts`, which is what `Pane` is built from — this is
 * that list with a label and an icon against each one, and the type below is
 * what keeps the two in step.
 */
const SECTION_MARKS: Record<
  Section,
  { label: string; Icon: ComponentType<{ className?: string }> }
> = {
  files: { label: "Explorer", Icon: FolderTree },
}

export const SECTIONS: {
  id: Section
  label: string
  Icon: ComponentType<{ className?: string }>
}[] = SECTION_IDS.map((id) => ({ id, ...SECTION_MARKS[id] }))

/**
 * The hue each section is known by, defined in `globals.css`.
 *
 * Read through `style` rather than composed into a class name — Tailwind scans
 * for whole literals, so a `text-section-${id}` would never be generated.
 *
 * `--section-terminal` is still a token and still used — by the splash, and by
 * the dock's own running dot — it just has no section to be keyed by here.
 */
export const SECTION_ACCENT: Record<Section, string> = {
  files: "var(--section-files)",
}

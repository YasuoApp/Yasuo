import {
  ChartColumn,
  ClipboardCopy,
  File,
  FileCode,
  FileDown,
  Puzzle,
  Share,
  type LucideIcon,
} from "lucide-react"

import type { PluginIcon } from "./registry"

/** The mark each of `PLUGIN_ICONS` is drawn as. */
export const PLUGIN_ICON_COMPONENTS: Record<PluginIcon, LucideIcon> = {
  copy: ClipboardCopy,
  download: FileDown,
  code: FileCode,
  file: File,
  share: Share,
  chart: ChartColumn,
  puzzle: Puzzle,
}

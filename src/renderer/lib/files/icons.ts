import { iconNameFor } from "./icon-names"

/**
 * The file-type icons, as URLs the tree and the strip can draw.
 *
 * The icons are [vscode-icons](https://github.com/vscode-icons/vscode-icons)
 * (MIT), vendored into `assets/file-icons/` — a chosen forty-odd out of the
 * fifteen hundred that set holds. All of them would be several megabytes in
 * git for a tree that would still be showing the same handful of types; the
 * ones checked in are the ones a workspace in this studio actually contains,
 * and a type nobody has an icon for falls back to a Lucide glyph rather than to
 * a worse guess.
 *
 * Collected with `import.meta.glob` rather than listed: a glob makes adding a
 * type "drop the file in and add the line to `icon-names.ts`", while a list
 * here would be a second place to forget.
 */
const URLS: Record<string, string> = import.meta.glob(
  "../../assets/file-icons/*.svg",
  { eager: true, query: "?url", import: "default" }
)

/** `…/file_type_typescript.svg` → `typescript`, which is what the tables in
 * `icon-names.ts` are keyed by. */
const BY_ICON_NAME = new Map(
  Object.entries(URLS).map(([path, url]) => [
    path.replace(/^.*\/file_type_/, "").replace(/\.svg$/, ""),
    url,
  ])
)

/**
 * The icon for a file, or null when there is none to draw.
 *
 * Null covers both "no rule for this extension" and "a rule naming an icon
 * that is not checked in" — the second is what a mistyped table entry looks
 * like, and it should degrade to the Lucide fallback rather than to a broken
 * image.
 */
export function iconFor(filePath: string): string | null {
  const name = iconNameFor(filePath)
  return name === null ? null : (BY_ICON_NAME.get(name) ?? null)
}

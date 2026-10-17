/**
 * Framework and tool logos, as URLs.
 *
 * Taken from [svgl](https://svgl.app) (`api.svgl.app/svg/<name>.svg`, svgo'd)
 * and vendored into `assets/brand-icons/` rather than fetched: the dialog that
 * shows them has to draw offline, and svgl's API is rate-limited and asks not
 * to be leaned on. Each logo stays its owner's trademark.
 *
 * svgl's svgo'd files **drop `xmlns`**, which is harmless inline and fatal in
 * an `<img>`: a standalone SVG without its namespace is not an image, and the
 * tag draws a broken one. So a file added here gets
 * `xmlns="http://www.w3.org/2000/svg"` put back by hand.
 *
 * A logo svgl draws differently per theme is two files, `<name>.svg` for a
 * light background and `<name>_dark.svg` for a dark one; most have only the
 * first, which serves both. Collected with `import.meta.glob` for the reason
 * `files/icons.ts` gives: adding one is dropping the file in.
 */
const URLS: Record<string, string> = import.meta.glob(
  "../assets/brand-icons/*.svg",
  { eager: true, query: "?url", import: "default" }
)

const BY_NAME = new Map(
  Object.entries(URLS).map(([path, url]) => [
    path.replace(/^.*\//, "").replace(/\.svg$/, ""),
    url,
  ])
)

/** The logo called `name`, or null when none is checked in. */
export function brandIcon(
  name: string
): { light: string; dark: string } | null {
  const light = BY_NAME.get(name)
  if (!light) return null
  return { light, dark: BY_NAME.get(`${name}_dark`) ?? light }
}

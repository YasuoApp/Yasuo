/**
 * What clicking a link in rendered markdown should do.
 *
 * Every `<a>` the renderers produce is a bare anchor, so left alone a click is
 * a navigation of the window itself. Main hands anything off the studio's own
 * origin to the browser (`keepInside` in `main/main.ts`), but a *relative*
 * `href` resolves against the studio's own origin — `./CONTRIBUTING.md` became
 * `http://localhost:5173/CONTRIBUTING.md` — and that is let through as the
 * studio navigating, which replaced the whole window with a 404 and nothing to
 * come back with. So anything that is not a web link is read here instead.
 */
export type MarkdownLink =
  /** Left to the browser: main's `will-navigate` opens it there. */
  | { kind: "external" }
  /** A heading in the same document. */
  | { kind: "anchor"; id: string }
  /** A file or folder next to the document, in the readings worth trying. */
  | { kind: "relative"; paths: string[] }
  /** Nothing to go to: a scheme this app does not open, or a path anchored at
   * `/`, which in a README means a repository root the preview has no name
   * for — the same rule its pictures follow. */
  | { kind: "none" }

const EXTERNAL = new Set(["http", "https", "mailto"])

export function linkOf(href: string): MarkdownLink {
  const value = href.trim()
  if (value === "") return { kind: "none" }

  if (value.startsWith("#")) {
    const id = decoded(value.slice(1))
    return id === "" ? { kind: "none" } : { kind: "anchor", id }
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (scheme) {
    return EXTERNAL.has(scheme[1]!.toLowerCase())
      ? { kind: "external" }
      : { kind: "none" }
  }
  if (value.startsWith("/")) return { kind: "none" }

  // The query and the fragment are the URL's, not the file's: `guide.md#setup`
  // is the file `guide.md`.
  const written = value.replace(/[?#].*$/, "")
  if (written === "") return { kind: "none" }

  // As written first and decoded second, for the reason `readLocalImage` gives:
  // `%20` is how a space travels in a link, but a literal `%` in a filename is
  // not an escape.
  const decodedPath = decoded(written)
  return {
    kind: "relative",
    paths: decodedPath === written ? [written] : [written, decodedPath],
  }
}

/**
 * A heading's anchor the way GitHub writes it, since that is the reader every
 * `#section` link in a README was written against: lower case, punctuation
 * dropped, spaces as hyphens. Letters outside ASCII are kept, as GitHub keeps
 * them.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

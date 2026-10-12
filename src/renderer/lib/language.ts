/**
 * Picks a language name from a response's `Content-Type`.
 *
 * The strings are the names `@codemirror/language-data` knows a language by,
 * which for the six here are also the ids Monaco used — so this file survived
 * the move between the two stacks unchanged except for this comment.
 * `languageNamed` in `lib/editor-languages.ts` is what resolves one.
 *
 * XML gets its own parser rather than being highlighted as HTML: it is a
 * dynamic import either way now, so the compromise this once made — a second
 * parser being a dependency rather than a string — has nothing left to weigh.
 * A type nobody here recognises is `plaintext`, which no registry has and is
 * therefore no highlighting rather than a wrong guess.
 */
export function languageIdForContentType(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""

  if (type.includes("json")) return "json"
  if (type === "text/html" || type.includes("xhtml")) return "html"
  if (type.includes("xml") || type.endsWith("+xml") || type.includes("svg")) {
    return "xml"
  }
  if (type.includes("javascript") || type.includes("ecmascript")) {
    return "javascript"
  }
  if (type.includes("css")) return "css"
  if (type.includes("markdown")) return "markdown"
  return "plaintext"
}

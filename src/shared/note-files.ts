/**
 * Where a picture dropped into a note lives, and what the note writes down for
 * it.
 *
 * A note's images are **files of the workspace's own**, one per upload under
 * `workspace/note-files/`, and the document holds a URL naming one. Not a data
 * URL inlined into the block: a note's body is rewritten on every pause in the
 * typing and travels across the bridge each time, so a photograph pasted into
 * one would be re-encoded, re-sent and re-written for the rest of that note's
 * life. Not a path into the user's own folders either — the file the picture
 * came from is theirs to move or delete, and a note is expected to still have
 * its picture afterwards. It is the same trade the drawings make: the note keeps
 * a reference, and the bytes are beside it.
 *
 * The URL is a scheme of this app's, served by `main/protocol.ts`, because both
 * sides have to be able to say what one means: the renderer puts it in an `img`
 * and Chromium fetches it, and the preview server — which renders the same
 * document in the main process, for a browser that has never heard of this
 * scheme — swaps it for the bytes inlined. That is why the shape lives here
 * rather than in either of them.
 */

/** Registered as a privileged scheme before the app is ready — see
 * `registerNoteFileScheme`. */
export const NOTE_FILE_SCHEME = "note-file"

/**
 * The host every note file URL carries.
 *
 * A standard scheme needs one, and it is a constant rather than the file's name
 * because a host is lower-cased and punycoded by the URL parser: a name that
 * became a filename after that trip would be a different name. So the name is a
 * path segment, where it survives being parsed.
 */
const NOTE_FILE_HOST = "workspace"

const PREFIX = `${NOTE_FILE_SCHEME}://${NOTE_FILE_HOST}/`

/** The URL a note holds for one of its files. */
export function noteFileUrl(fileName: string): string {
  return `${PREFIX}${encodeURIComponent(fileName)}`
}

/** The file a note's URL names, or null for any other URL — an image embedded
 * from the web, or a `data:` one pasted out of a browser, both of which the
 * note keeps as they are. */
export function noteFileNameOf(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(PREFIX)) return null
  const name = decodeURIComponent(url.slice(PREFIX.length))
  return name || null
}

/**
 * What a note file may be, as one table read in both directions.
 *
 * One table rather than two because the two sides ask opposite questions about
 * the same fact. The renderer, storing a dropped file, has the type the browser
 * gave it and needs the extension to name the file with. The main process,
 * serving that file back or inlining it into a preview page, has the extension
 * and needs the type — and if it answered `video/quicktime` where the other had
 * written `.mp4`, the file would be stored under one name and served as another.
 *
 * Not an exhaustive mime table: what is here is what a note holds — the four
 * kinds of block BlockNote has a file for — and anything else is stored under
 * its own extension and served as a download.
 */
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/tiff": "tiff",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "application/pdf": "pdf",
  "text/plain": "txt",
}

/** The other direction, built once. First declaration wins, so `image/jpeg`
 * keeps `.jpg` rather than being reached through an alias. */
const CONTENT_TYPES = new Map(
  Object.entries(TYPES).map(([type, extension]) => [extension, type])
)

/** The extension to store a dropped file under, or null for a type this app has
 * no name for — the caller decides what to do with that. */
export function extensionForType(type: string): string | null {
  return TYPES[type.toLowerCase()] ?? null
}

/**
 * What to serve one of these files as, from its own name.
 *
 * Null rather than `application/octet-stream` for an extension not in the
 * table, because the two callers want different things from not knowing: the
 * preview inlines a picture and only a picture, and the file route has to send
 * *something* — see each of them.
 */
export function contentTypeOf(fileName: string): string | null {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
  return CONTENT_TYPES.get(extension) ?? null
}

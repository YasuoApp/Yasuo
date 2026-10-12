import { extensionForType, noteFileUrl } from "@shared/note-files"

/**
 * What the note editor does with a file dropped, pasted or picked into it.
 *
 * This is `uploadFile` on the editor, and setting it is what puts the **Upload**
 * tab in BlockNote's image panel at all: with none, the panel offers only
 * "Embed" a URL, and a dropped or pasted picture is ignored. So there is nothing
 * to switch on here — the panel is built from what the editor can do.
 *
 * Where the bytes go and why they are not inlined into the note is
 * `shared/note-files.ts`. What this file owns is the name that lands in the
 * workspace: a fresh UUID and an extension, so nothing the user's own filesystem
 * named reaches a path of ours, and so two pictures dropped from two folders
 * with the same name cannot be the same file.
 */

/**
 * The ceiling on a file dropped into a note.
 *
 * A note is a page of writing, and this copies whatever it is handed into the
 * workspace's own directory — so a 4K video dragged in by accident would be
 * quietly duplicated on the user's disk with nothing in the note to show for it
 * beyond a block. Generous enough for any photograph, and the note keeps working
 * either way: what fails is the upload, and the panel says so.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** The ceiling as the panel writes it — "64 MB". Beside the constant so the
 * limit is stated once. */
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`

/**
 * The extension a file is stored under, without the dot.
 *
 * From the browser's own idea of the type rather than the file's name: the type
 * is what the panel filtered on and what the bytes actually are, while a name is
 * a label — and a screenshot pasted out of the clipboard arrives with no name at
 * all. The table is in `shared/note-files.ts` because the main process reads it
 * the other way round to serve the file back.
 *
 * The name is fallen back to for a type this app has no entry for, and `bin`
 * after that: a name the store accepts and a type nothing will try to decode.
 */
function extensionOf(file: File): string {
  const known = extensionForType(file.type)
  if (known) return known

  const suffix = file.name.split(".").pop() ?? ""
  return /^[a-z0-9]{1,8}$/i.test(suffix) && suffix !== file.name
    ? suffix.toLowerCase()
    : "bin"
}

/**
 * Writes a dropped file into the workspace and hands back the URL the note
 * holds for it.
 *
 * What it throws is shown to the user: the panel this runs behind is the
 * studio's own (`note/file-panel.tsx`) and puts the message under the drop
 * zone, unlike BlockNote's, which catches the error and says only that an
 * upload failed. So the sentence here is written to be read.
 */
export async function uploadNoteFile(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1)
    throw new Error(
      `${file.name || "That file"} is ${megabytes} MB — a note takes up to ${MAX_UPLOAD_LABEL}.`
    )
  }

  const fileName = `${crypto.randomUUID()}.${extensionOf(file)}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  await window.desktop.writeNoteFile(fileName, bytes)
  return noteFileUrl(fileName)
}

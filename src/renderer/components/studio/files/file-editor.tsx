import { lazy, Suspense } from "react"

/**
 * The file editor, fetched the first time a file is opened.
 *
 * `lazy` for the reason every editor in the studio is behind one — see
 * `lib/editor.ts`. The bundle it keeps out of the launch is a great deal smaller
 * than Monaco's four megabytes of grammars and workers was, but a language is
 * still a chunk of its own, and a studio somebody opened to read a note should
 * fetch none of them.
 */
const CodeMirrorFileEditor = lazy(() => import("./codemirror-editor"))

export function FileEditor(props: {
  path: string
  initialText: string
  onChange: (text: string) => void
  onSave: () => void
}) {
  return (
    <Suspense
      fallback={
        // Deliberately bare. The chunk is on local disk and lands in a frame or
        // two; a spinner would be a flash of something that says less than the
        // empty box it replaces.
        <div className="h-full w-full" />
      }
    >
      <CodeMirrorFileEditor {...props} />
    </Suspense>
  )
}

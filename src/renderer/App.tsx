import { TooltipProvider } from "@/components/ui/tooltip"

import { lazy, Suspense } from "react"

import { ThemeProvider } from "@/components/theme-provider"
import { StudioLoader } from "@/components/studio/studio-loader"

const ChatWindow = lazy(() =>
  import("@/components/studio/chat-window").then((mod) => ({
    default: mod.ChatWindow,
  }))
)

/**
 * The chat this window was opened for, or null for the studio itself.
 *
 * `main.ts` opens a second window on this same renderer with `?chat=<id>`
 * (`openChatWindow`); the studio's own window has no query. Read once, at
 * module load: a window is one or the other for its whole life.
 */
const POPPED_CHAT = new URLSearchParams(window.location.search).get("chat")

/**
 * The studio, and the whole of what this renderer draws — or one chat, in a
 * window of its own.
 *
 * It used to read a `?view=` off its own URL and draw the Database or API panel
 * on its own instead. Both panels are gone; the one query left is `?chat=`,
 * which draws a conversation rather than a panel: `ChatWindow`.
 */
export function App() {
  return (
    <div className="font-sans antialiased">
      <ThemeProvider defaultTheme="dark">
        {/*
          A toolbar of icon buttons sits a few pixels apart, so tooltips open on
          a delay: at zero they fire one after another as the pointer crosses
          the row on its way somewhere else.
        */}
        <TooltipProvider delay={400}>
          {POPPED_CHAT ? (
            <Suspense fallback={null}>
              <ChatWindow chatId={POPPED_CHAT} />
            </Suspense>
          ) : (
            <StudioLoader />
          )}
        </TooltipProvider>
      </ThemeProvider>
    </div>
  )
}

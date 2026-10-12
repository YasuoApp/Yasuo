import { lazy, Suspense } from "react"

import { Splash } from "./splash"

const Studio = lazy(() =>
  import("./studio").then((mod) => ({ default: mod.Studio }))
)

/**
 * The same launch screen the studio itself shows while it reads the manifest,
 * rather than a second one worded differently: the handover from this to that
 * happens partway through the animation, and two screens made it a flicker.
 */
export function StudioLoader() {
  return (
    <Suspense fallback={<Splash />}>
      <Studio />
    </Suspense>
  )
}

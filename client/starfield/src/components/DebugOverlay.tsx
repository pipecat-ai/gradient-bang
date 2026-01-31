import { lazy, Suspense } from "react"

// Lazy load debug components so they're not bundled in production
const Stats = lazy(() =>
  import("@react-three/drei").then((mod) => ({ default: mod.Stats }))
)
const RenderingIndicator = lazy(() =>
  import("./RenderingIndicator").then((mod) => ({
    default: mod.RenderingIndicator,
  }))
)

/**
 * Debug overlay components - lazy loaded to avoid bundling in production
 */
export function DebugOverlay() {
  return (
    <Suspense fallback={null}>
      <Stats showPanel={0} />
      <RenderingIndicator />
    </Suspense>
  )
}

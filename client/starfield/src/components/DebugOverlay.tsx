import { lazy, Suspense } from "react"

// Lazy load debug components so they're not bundled in production
const Stats = lazy(() =>
  import("@react-three/drei/core/Stats").then((mod) => ({ default: mod.Stats }))
)
const RenderingIndicator = lazy(() =>
  import("./RenderingIndicator").then((mod) => ({
    default: mod.RenderingIndicator,
  }))
)
const FrameProfiler = lazy(() =>
  import("./FrameProfiler").then((mod) => ({
    default: mod.FrameProfiler,
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
      <FrameProfiler />
    </Suspense>
  )
}

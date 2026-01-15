import { lazy, Suspense } from "react"

import type { StarfieldConfig, StarfieldProps } from "@gradient-bang/starfield"

import { images } from "@/assets"
import useGameStore from "@/stores/game"

const StarfieldComponent = lazy(() =>
  import("@gradient-bang/starfield").then((mod) => ({
    default: mod.Starfield,
  }))
)

export const Starfield = ({
  config,
  ...props
}: { config?: StarfieldConfig } & StarfieldProps) => {
  const settings = useGameStore.use.settings()
  const setStarfieldReady = useGameStore.use.setStarfieldReady()

  return (
    <div
      id="starfield-container"
      className="relative user-select-none pointer-events-none"
      tabIndex={-1}
    >
      {settings.renderStarfield && (
        <Suspense fallback={null}>
          <StarfieldComponent
            {...props}
            profile={settings.qualityPreset}
            config={{
              imageAssets: [
                images.skybox1,
                images.skybox2,
                images.skybox3,
                images.skybox4,
                images.skybox5,
                images.skybox6,
                images.skybox7,
                images.skybox8,
                images.skybox9,
              ],
              ...config,
            }}
            onCreated={() => {
              console.debug("[STARFIELD] Starfield Ready")
              setStarfieldReady(true)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}

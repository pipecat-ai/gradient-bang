import { useEffect } from "react"

import Starfield, {
  generateRandomScene,
  type PerformanceProfile,
  useSceneChange,
} from "@gradient-bang/starfield"

import useGameStore from "@/stores/game"

interface StarfieldLazyProps {
  profile: PerformanceProfile
  config: { imageAssets: string[] }
  onCreated: () => void
  lookMode: boolean
}

/**
 * Lazy-loaded starfield component with utilities.
 * Keeps all Three.js deps out of the main bundle.
 */
export default function StarfieldLazy({
  profile,
  config,
  onCreated,
  lookMode,
}: StarfieldLazyProps) {
  const settings = useGameStore.use.settings()
  const { changeScene } = useSceneChange()

  useEffect(() => {
    if (!settings.renderStarfield) return

    // Subscribe to sector id changes
    const unsub = useGameStore.subscribe(
      (state) => state.sector?.id,
      (sectorId, prevSectorId) => {
        if (sectorId !== prevSectorId && sectorId) {
          const newScene = generateRandomScene()
          changeScene({
            id: sectorId.toString(),
            gameObjects: [],
            config: newScene,
          })
        }
      }
    )

    return unsub
  }, [settings.renderStarfield, changeScene])

  return (
    <Starfield
      profile={profile}
      config={config}
      onCreated={onCreated}
      lookMode={lookMode}
    />
  )
}

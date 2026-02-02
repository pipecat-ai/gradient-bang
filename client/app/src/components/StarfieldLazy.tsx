import { useEffect } from "react"

import Starfield, {
  generateRandomScene,
  type StarfieldProps,
  useSceneChange,
} from "@gradient-bang/starfield"

import useGameStore from "@/stores/game"

/**
 * Lazy-loaded starfield component with utilities.
 * Keeps all Three.js deps out of the main bundle.
 */
export default function StarfieldLazy(props: StarfieldProps) {
  // Use specific selector to prevent re-renders from unrelated settings changes
  const renderStarfield = useGameStore((state) => state.settings.renderStarfield)
  const { changeScene } = useSceneChange()

  useEffect(() => {
    if (!renderStarfield) return

    // Subscribe to sector id changes
    const unsub = useGameStore.subscribe(
      (state) => state.sector?.id,
      (sectorId, prevSectorId) => {
        if (sectorId !== prevSectorId && sectorId) {
          const newScene = generateRandomScene()
          console.log("SCENE CHANGE")

          changeScene({
            id: sectorId.toString(),
            gameObjects: [],
            config: newScene,
          })
        }
      }
    )

    return unsub
  }, [renderStarfield, changeScene])

  return <Starfield {...props} />
}

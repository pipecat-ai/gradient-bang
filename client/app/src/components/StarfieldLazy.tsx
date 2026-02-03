import { useCallback, useEffect } from "react"

import Starfield, {
  type GameObject,
  generateRandomScene,
  type StarfieldProps,
  useSceneChange,
} from "@gradient-bang/starfield"

import useGameStore from "@/stores/game"

const generateGameObjects = (sector: Sector) => {
  return sector.port ?
      [
        {
          id: "port-" + sector.id.toString(),
          type: "port",
          label: sector.port.code,
        } as GameObject,
      ]
    : []
}

/**
 * Lazy-loaded starfield component with utilities.
 * Keeps all Three.js deps out of the main bundle.
 */
export default function StarfieldLazy(props: StarfieldProps) {
  // Use specific selector to prevent re-renders from unrelated settings changes
  const renderStarfield = useGameStore((state) => state.settings.renderStarfield)
  const { changeScene } = useSceneChange()

  const onReady = useCallback(() => {
    console.debug("[STARFIELD] Starfield ready")
    // Get current sector id
    const sector = useGameStore.getState().sector
    if (sector?.id) {
      const newScene = generateRandomScene()
      console.debug("[STARFIELD] Initial scene load", sector)

      // Get game objects
      const gameObjects = generateGameObjects(sector)

      changeScene({
        id: sector.id.toString(),
        gameObjects,
        config: newScene,
      })
    }
  }, [changeScene])

  useEffect(() => {
    if (!renderStarfield) return

    // Subscribe to sector id changes
    const unsub = useGameStore.subscribe(
      (state) => state.sector?.id,
      (sectorId, prevSectorId) => {
        if (sectorId !== prevSectorId && sectorId) {
          const newScene = generateRandomScene()
          console.debug("[STARFIELD] Scene change")

          const sector = useGameStore.getState().sector
          if (sector === undefined) return

          changeScene({
            id: sectorId.toString(),
            gameObjects: generateGameObjects(sector),
            config: newScene,
          })
        }
      }
    )

    return unsub
  }, [renderStarfield, changeScene])

  return <Starfield {...props} onReady={onReady} />
}

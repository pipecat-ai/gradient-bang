import { useCallback, useEffect } from "react"

import Starfield, {
  type GameObject,
  generateRandomScene,
  type StarfieldProps,
  useSceneChange,
  useStarfieldEvent,
} from "@gradient-bang/starfield"

import useGameStore from "@/stores/game"
import { getPortCode } from "@/utils/port"

const generateGameObjects = (sector: Sector) => {
  const portCode = getPortCode(sector.port ?? null)
  return sector.port ?
      [
        {
          id: "port-" + sector.id.toString(),
          type: "port",
          label: portCode,
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
  const { animateImpact } = useStarfieldEvent()

  const onReady = useCallback(() => {
    console.debug("%c[STARFIELD] Starfield ready", "color: blue; font-weight: bold")
    // Get current sector id
    const sector = useGameStore.getState().sector
    if (sector?.id !== undefined) {
      const newScene = generateRandomScene()
      console.debug("%c[STARFIELD] Initial scene load", "color: blue; font-weight: bold", sector)

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

    const unsub = useGameStore.subscribe(
      (state) => state.uiState,
      (uiState) => {
        if (uiState === "combat") {
          animateImpact(0.015, 200, 1000, 100, 2000)
        }
      }
    )

    return unsub
  }, [renderStarfield, animateImpact])

  // React to combat damage — the app sets tookDamageThisRound in the store,
  // and we trigger the screen-shake here inside the lazy boundary.
  useEffect(() => {
    if (!renderStarfield) return

    const unsub = useGameStore.subscribe(
      (state) => state.tookDamageThisRound,
      (tookDamage) => {
        if (tookDamage) {
          animateImpact(0.015, 200, 1000, 100, 2000)
          // Don't reset the flag here — CombatDamageVignette resets it
          // after its fade-out animation completes.
        }
      }
    )

    return unsub
  }, [renderStarfield, animateImpact])

  useEffect(() => {
    if (!renderStarfield) return

    // Subscribe to sector id changes
    const unsub = useGameStore.subscribe(
      (state) => state.sector?.id,
      (sectorId, prevSectorId) => {
        if (sectorId !== prevSectorId && sectorId !== undefined) {
          const newScene = generateRandomScene()
          console.debug("%c[STARFIELD] Scene change", "color: blue; font-weight: bold")

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

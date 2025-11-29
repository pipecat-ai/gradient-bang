import { getPaletteNames } from "@/colors"
import { defaultProfile } from "@/profiles"
import type { SceneConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

export function generateRandomScene(
  config: Partial<SceneConfig> = {}
): SceneConfig {
  const { imageAssets } = useGameStore.getState().starfieldConfig
  const randomImageIndex = Math.floor(
    Math.random() * (imageAssets?.length || 1)
  )

  const randomPlanetScale = Math.floor(Math.random() * 200) + 20
  const randomPlanetShadowOpacity =
    randomPlanetScale < 70
      ? Math.random() * 0.5 + 0.35
      : (defaultProfile.planet?.shadowOpacity ?? 0.85)
  const randomPlanetOpacity =
    randomPlanetScale < 100
      ? Math.random() * 0.5 + 0.1
      : (defaultProfile.planet?.opacity ?? 1)

  return {
    ...config,
    palette:
      getPaletteNames()[Math.floor(Math.random() * getPaletteNames().length)],
    planet: {
      ...config.planet,
      imageIndex: randomImageIndex,
      scale: randomPlanetScale,
      opacity: randomPlanetOpacity,
      position: {
        x: Math.random() * 100 - 50,
        y: Math.random() * 100 - 50,
      },
      shadowOpacity: randomPlanetShadowOpacity,
    },
  }
}

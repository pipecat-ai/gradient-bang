import { getPaletteNames } from "@/colors"
import type { SceneConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

export function generateRandomScene(
  config: Partial<SceneConfig> = {}
): SceneConfig {
  const { imageAssets } = useGameStore.getState().starfieldConfig
  const randomImageIndex = Math.floor(
    Math.random() * (imageAssets?.length || 1)
  )

  return {
    ...config,
    palette:
      getPaletteNames()[Math.floor(Math.random() * getPaletteNames().length)],
    planet: {
      ...config.planet,
      imageIndex: randomImageIndex,
      position: {
        x: Math.random() * 100 - 50,
        y: Math.random() * 100 - 50,
      },
    },
  }
}

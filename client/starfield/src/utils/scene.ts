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

  // Planet
  // Use power curve to bias toward smaller planets (Math.random() ** 1.5 skews smaller)
  const randomPlanetScale = Math.floor(Math.random() ** 1.5 * 200) + 20
  const randomPlanetOpacity =
    randomPlanetScale < 100
      ? Math.random() * 0.5 + 0.2
      : (defaultProfile.planet?.opacity ?? 1)

  // Shadow opacity graduated by planet size:
  // - Small (<70): soft shadow scaled by opacity, minimum 0.2
  // - Medium (70-140): at least 50%
  // - Large (>140): 65%+
  let randomPlanetShadowOpacity: number
  if (randomPlanetScale < 70) {
    // Small planets: soft shadow scaled by opacity
    const baseShadow = Math.random() * 0.3 + 0.2
    const opacityModifier = 0.5 + 0.5 * randomPlanetOpacity
    randomPlanetShadowOpacity = Math.max(0.25, baseShadow * opacityModifier)
  } else if (randomPlanetScale < 140) {
    // Medium planets: 50-75% shadow
    randomPlanetShadowOpacity = Math.random() * 0.25 + 0.5
  } else {
    // Large planets: 65-90% shadow
    randomPlanetShadowOpacity = Math.random() * 0.25 + 0.65
  }

  // Sun
  const randomSunIntensity = Math.random() * 0.4 + 0.2 // 0.1-0.5

  // Nebula - randomize iterations first, then adjust intensity based on iteration count
  const randomIterPrimary = Math.floor(Math.random() * 49) + 1 // 1-50
  const randomNebulaIntensity =
    randomIterPrimary > 20
      ? Math.random() * 0.4 // 0-0.4 for high primary iterations
      : Math.random() // 0-1 for low primary iterations
  let randomIterSecondary: number
  if (randomIterPrimary < 5) {
    // Low primary: secondary should be 10-50
    randomIterSecondary = Math.floor(Math.random() * 41) + 10
  } else if (randomNebulaIntensity > 0.5) {
    // High intensity: cap secondary at 20
    randomIterSecondary = Math.floor(Math.random() * 20) + 1 // 1-20
  } else {
    randomIterSecondary = Math.floor(Math.random() * 50) + 1 // 1-50
  }
  const randomDomainScale = Math.random() * 2 + 1 // 1-3
  const randomWarpDecay = Math.random() * 19.9 + 0.1 // 0.1-20

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
    sun: {
      ...config.sun,
      intensity: randomSunIntensity,
    },
    nebula: {
      ...config.nebula,
      intensity: randomNebulaIntensity,
      domainScale: randomDomainScale,
      iterPrimary: randomIterPrimary,
      iterSecondary: randomIterSecondary,
      warpDecay: randomWarpDecay,
    },
  }
}

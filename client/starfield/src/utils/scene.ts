import { getPaletteNames } from "@/colors"
import { defaultProfile } from "@/profiles"
import type { SceneConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

export function generateRandomScene(
  config: Partial<SceneConfig> = {}
): SceneConfig {
  const { imageAssets } = useGameStore.getState().starfieldConfig

  // ============================================
  // PLANET
  // ============================================

  // Filter to only skybox images for planet backgrounds
  const skyboxAssets = imageAssets?.filter((asset) => asset.type === "skybox")
  const randomImageIndex = Math.floor(
    Math.random() * (skyboxAssets?.length || 1)
  )

  const randomPlanetScale = Math.floor(Math.random() * 100) + 30 // 30-100

  // Opacity: smaller planets are more transparent
  const randomPlanetOpacity =
    randomPlanetScale < 100
      ? Math.random() * 0.5 + 0.2
      : (defaultProfile.planet?.opacity ?? 1)

  // Shadow opacity graduated by planet size, factored by overall opacity
  // All sizes have minimum 0.3
  const opacityModifier = 0.5 + 0.5 * randomPlanetOpacity
  let baseShadow: number
  if (randomPlanetScale < 60) {
    baseShadow = Math.random() * 0.3 + 0.3 // 0.3-0.6
  } else if (randomPlanetScale < 140) {
    baseShadow = Math.random() * 0.25 + 0.5 // 0.5-0.75
  } else {
    baseShadow = Math.random() * 0.25 + 0.65 // 0.65-0.9
  }
  const randomPlanetShadowOpacity = Math.max(0.4, baseShadow * opacityModifier)

  // Position: range scales with planet size (larger planets can be further out)
  const positionRange = 15 + (randomPlanetScale - 20) * 0.35 // ~15 for small, ~50 for large
  const randomPlanetPositionX =
    Math.random() * positionRange * 2 - positionRange
  const randomPlanetPositionY =
    Math.random() * positionRange * 2 - positionRange

  // ============================================
  // NEBULA
  // ============================================

  // Randomize iterations first, then adjust intensity based on iteration count
  const randomIterPrimary = Math.floor(Math.random() * 49) + 1 // 1-50

  // Higher primary iterations = lower intensity to avoid visual overload
  const randomNebulaIntensity = 0.5 + 0.1

  // Secondary iterations: adjusted based on primary and intensity
  let randomIterSecondary: number
  if (randomIterPrimary < 5) {
    // Low primary: secondary should be 10-50 to compensate
    randomIterSecondary = Math.floor(Math.random() * 41) + 10
  } else if (randomNebulaIntensity > 0.5) {
    // High intensity: cap secondary at 20
    randomIterSecondary = Math.floor(Math.random() * 20) + 1
  } else {
    randomIterSecondary = Math.floor(Math.random() * 50) + 1
  }

  const randomDomainScale = Math.random() * 2.5 + 0.5 // 0.5-3
  // Warp decay based on nebula intensity: lower intensity needs higher minimum
  const randomWarpDecay =
    randomNebulaIntensity < 0.5
      ? Math.random() * 2 + 3 // 3-5 for low intensity
      : Math.random() * 4 + 1 // 1-5 for high intensity

  // ============================================
  // GALAXY
  // ============================================

  const randomGalaxyIntensity = Math.random() * 0.9 + 0.15 // 0.1-1.0
  const randomGalaxySpread = Math.random() * 1.9 + 0.1 // 0.1-2.0
  //const randomGalaxyRotation = Math.random() * Math.PI * 2 // 0 to 2π
  // Clamp offsets to avoid sphere seam (X) and pole distortion (Y)
  const randomGalaxyOffsetX = Math.random() * 1.6 - 0.8 // -0.8 to 0.8
  const randomGalaxyOffsetY = Math.random() * 0.4 - 0.2 // -0.2 to 0.2

  // ============================================
  // LENS FLARE
  // ============================================

  // Align lens flare intensity with galaxy (galaxy intensity + 1)
  const randomLensFlareIntensity = randomGalaxyIntensity + 0.6

  // ============================================
  // BUILD SCENE CONFIG
  // ============================================

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
        x: randomPlanetPositionX,
        y: randomPlanetPositionY,
      },
      shadowOpacity: randomPlanetShadowOpacity,
    },
    nebula: {
      ...config.nebula,
      intensity: randomNebulaIntensity,
      domainScale: randomDomainScale,
      iterPrimary: randomIterPrimary,
      iterSecondary: randomIterSecondary,
      warpDecay: randomWarpDecay,
    },
    galaxy: {
      ...config.galaxy,
      intensity: randomGalaxyIntensity,
      spread: randomGalaxySpread,
      //rotation: randomGalaxyRotation,
      offsetX: randomGalaxyOffsetX,
      offsetY: randomGalaxyOffsetY,
    },
    lensFlare: {
      ...config.lensFlare,
      intensity: randomLensFlareIntensity,
    },
  }
}

import { createContext } from "react"
import type { SpringValue } from "@react-spring/three"

/**
 * Animation Context - Central store for all scene animations
 *
 * To add a new animation:
 * 1. Define spring values type (e.g., FadeSpringValues)
 * 2. Add spring values and metadata to AnimationContextValue
 * 3. Use useAnimationSpring in AnimationController
 * 4. Create consumer hook in hooks/animations.ts
 */

// ============================================================================
// WARP ANIMATION
// ============================================================================
type WarpSpringValues = {
  scale: SpringValue<number>
  rotationSpeed: SpringValue<number>
  warpProgress: SpringValue<number>
  glowIntensity: SpringValue<number>
  distortion: SpringValue<number>
}

type WarpMetadata = {
  isWarping: boolean
  isAnimating: boolean
}

// ============================================================================
// DIM ANIMATION
// ============================================================================
type DimSpringValues = {
  dimOpacity: SpringValue<number>
}

type DimMetadata = {
  isDimmed: boolean
}

// ============================================================================
// SHOCKWAVE ANIMATION
// ============================================================================
type ShockwaveMetadata = {
  shockwaveSequence: number
  triggerShockwave: () => void
}

// ============================================================================
// COMBINED CONTEXT TYPE
// ============================================================================
export type AnimationContextValue = WarpSpringValues &
  WarpMetadata &
  DimSpringValues &
  DimMetadata &
  ShockwaveMetadata

export const AnimationContext = createContext<AnimationContextValue | null>(
  null
)

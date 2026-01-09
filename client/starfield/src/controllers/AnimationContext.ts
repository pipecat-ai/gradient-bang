import { createContext } from "react"
import type { SpringValue } from "@react-spring/three"

import type { DimSpringValues } from "@/animations/dim"
import type { WarpSpringValues } from "@/animations/warp"

/**
 * Animation Context - Central store for all scene animations
 *
 * To add a new animation:
 * 1. Define spring values type (e.g., FadeSpringValues)
 * 2. Add spring values and metadata to AnimationContextValue
 * 3. Implement use<Animation>NameSpring in src/animations/
 * 4. Register it inside AnimationController
 * 5. Create consumer hook in hooks/animations.ts
 */

type WarpMetadata = {
  isWarping: boolean
}

type DimMetadata = {
  isDimmed: boolean
}

// ============================================================================
// SHOCKWAVE ANIMATION
// ============================================================================
type ShockwaveMetadata = {
  shockwaveSequence: number
  shockwaveProgress: SpringValue<number>
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

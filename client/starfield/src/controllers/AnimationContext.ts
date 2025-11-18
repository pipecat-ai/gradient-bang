import { createContext } from "react"
import type { SpringValue } from "@react-spring/three"

type WarpSpringValues = {
  scale: SpringValue<number>
  rotationSpeed: SpringValue<number>
  warpProgress: SpringValue<number>
  glowIntensity: SpringValue<number>
  distortion: SpringValue<number>
}

type DimSpringValues = {
  dimOpacity: SpringValue<number>
}

export type AnimationContextValue = WarpSpringValues &
  DimSpringValues & {
    isWarping: boolean
    isAnimating: boolean
    isDimmed: boolean
    isDimAnimating: boolean
    shockwaveSequence: number
    triggerShockwave: () => void
  }

export const AnimationContext = createContext<AnimationContextValue | null>(
  null
)

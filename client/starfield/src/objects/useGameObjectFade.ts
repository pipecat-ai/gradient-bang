import { createContext, useContext } from "react"

/**
 * Context providing the current fade value (0–1) from the nearest
 * BaseGameObject. Updated every frame — read .current inside useFrame.
 */
export const GameObjectFadeContext = createContext({ current: 1 })

/**
 * Read the current fade value (0–1) from the nearest BaseGameObject.
 * Access `.current` inside useFrame for per-frame opacity calculations.
 *
 * @example
 * const fadeRef = useGameObjectFade()
 * useFrame(() => {
 *   material.opacity = baseOpacity * fadeRef.current
 * })
 */
export function useGameObjectFade() {
  return useContext(GameObjectFadeContext)
}

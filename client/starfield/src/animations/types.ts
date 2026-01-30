import type { SpringValue } from "@react-spring/three"

/**
 * Base interface for animation hooks that provide a progress spring and start method.
 *
 * @example
 * // Simple single-shot animation
 * const { progress, start } = useFadeAnimation()
 * start() // triggers the animation
 */
export interface AnimationHook {
  /** Spring value representing animation progress (typically 0-1) */
  progress: SpringValue<number>

  /** Method to trigger the animation */
  start: () => void
}

/**
 * Animation hook with directional control
 *
 * @template TDirection - The type of direction parameter for the start method
 *
 * @example
 * // Directional animation
 * const { progress, start } = useHyperspaceAnimation()
 * start("enter") or start("exit")
 */
export interface DirectionalAnimationHook<TDirection extends string> {
  /** Spring value representing animation progress (typically 0-1) */
  progress: SpringValue<number>

  /** Method to trigger the animation in a specific direction */
  start: (direction: TDirection) => void
}

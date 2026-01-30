import { invalidate, useFrame } from "@react-three/fiber"
import { button, folder, useControls } from "leva"

import { useHyperspaceAnimation } from "@/animations/hyperspaceAnim"
import { useAnimationStore } from "@/useAnimationStore"

/**
 * AnimationController - Registers animations with the animation store
 *
 * This controller initializes and runs all animation hooks.
 * Animations drive registered uniforms via the uniform store.
 */
export function AnimationController() {
  const { start: startHyperspace } = useHyperspaceAnimation()

  // Keep render loop alive while any animation is running
  // Read directly from store to avoid stale closure
  useFrame(() => {
    if (useAnimationStore.getState().isAnimating) {
      invalidate()
    }
  })

  useControls(() => ({
    Animations: folder(
      {
        Hyperspace: folder(
          {
            ["Enter"]: button(() => {
              startHyperspace("enter")
            }),
            ["Exit"]: button(() => {
              startHyperspace("exit")
            }),
          },
          { collapsed: true }
        ),
      },
      { collapsed: true }
    ),
  }))

  return null
}

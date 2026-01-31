import { useEffect, useRef } from "react"
import { invalidate, useFrame } from "@react-three/fiber"
import { button, folder, useControls } from "leva"

import { useDimAnimation } from "@/animations/dimAnim"
import { useExposureAnimation } from "@/animations/exposureAnim"
import { useHyperspaceAnimation } from "@/animations/hyperspaceAnim"
import { useShockwaveAnimation } from "@/animations/shockwaveAnim"
import { useAnimationStore } from "@/useAnimationStore"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

/**
 * AnimationController - Manages all scene animations
 *
 * Placed after PostProcessingController to ensure uniforms are registered.
 * Handles:
 * - Initial uniform setup (exposure=0 for fade-in)
 * - Reacting to suspenseReady signal to start fade-in animation
 * - Runtime animations (dim, exposure, hyperspace, shockwave)
 */
export function AnimationController() {
  const { start: startDim } = useDimAnimation()
  const { start: startExposure } = useExposureAnimation()
  const { start: startHyperspace } = useHyperspaceAnimation()
  const { start: startShockwave } = useShockwaveAnimation()
  const setIsShaking = useAnimationStore((state) => state.setIsShaking)

  // Subscribe to suspenseReady - when true, scene objects are loaded
  const suspenseReady = useAnimationStore((state) => state.suspenseReady)
  const animationStarted = useRef(false)

  // When suspense resolves, signal ready and start fade-in animation (once only)
  useEffect(() => {
    if (suspenseReady && !animationStarted.current) {
      animationStarted.current = true
      console.debug("[STARFIELD] Suspense ready, starting fade-in animation")

      // Signal ready and fire callback
      useGameStore.getState().setIsReady(true)
      setIsShaking(true)
      useCallbackStore.getState().onReady()

      // Start fade-in animation (exit = from black to normal)
      startHyperspace("exit", () => {
        setIsShaking(false)
      })
    }
  }, [suspenseReady, startHyperspace, setIsShaking])

  // Subscribe to camera look-at target
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)
  const prevLookAtTargetRef = useRef<string | null>(null)

  // React to camera target changes - dim when targeting, undim when released
  useEffect(() => {
    const hadTarget = prevLookAtTargetRef.current !== null
    const hasTarget = lookAtTarget !== null

    if (!hadTarget && hasTarget) {
      // Gained a target - dim the background
      console.debug("[STARFIELD] Gained a target - dim the background")
      startDim("enter")
    } else if (hadTarget && !hasTarget) {
      console.debug("[STARFIELD] Lost a target - restore background")
      // Lost the target - restore background
      startDim("exit")
    }

    prevLookAtTargetRef.current = lookAtTarget
  }, [lookAtTarget, startDim])

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
        Dim: folder(
          {
            ["Dim Enter"]: button(() => {
              startDim("enter")
            }),
            ["Dim Exit"]: button(() => {
              startDim("exit")
            }),
          },
          { collapsed: true }
        ),
        Exposure: folder(
          {
            ["Exposure Enter"]: button(() => {
              startExposure("enter")
            }),
            ["Exposure Exit"]: button(() => {
              startExposure("exit")
            }),
          },
          { collapsed: true }
        ),
        Hyperspace: folder(
          {
            ["Hyperspace Enter"]: button(() => {
              startHyperspace("enter")
            }),
            ["Hyperspace Exit"]: button(() => {
              startHyperspace("exit")
            }),
          },
          { collapsed: true }
        ),
        Shockwave: folder(
          {
            ["Shockwave Trigger"]: button(() => {
              startShockwave()
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

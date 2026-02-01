import { useEffect, useRef } from "react"
import { invalidate, useFrame } from "@react-three/fiber"
import { button, folder, useControls } from "leva"

import { useDimAnimation } from "@/animations/dimAnim"
import { useExposureAnimation } from "@/animations/exposureAnim"
import { useHyperspaceAnimation } from "@/animations/hyperspaceAnim"
import { useShakeAnimation } from "@/animations/shakeAnim"
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
  const { start: startShake, stop: stopShake } = useShakeAnimation()
  const { start: startShockwave } = useShockwaveAnimation()

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

      startShake()

      useCallbackStore.getState().onReady()

      startHyperspace(
        "exit",
        () => {
          stopShake()
        },
        { initialExposure: 0 } // Start from black on initial run
      )
    }
  }, [suspenseReady, startHyperspace, startShake, stopShake])

  // Subscribe to camera look-at target
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)
  const prevLookAtTargetRef = useRef<string | undefined>(undefined)

  // React to camera target changes - dim when targeting, undim when released
  useEffect(() => {
    const hadTarget = prevLookAtTargetRef.current !== undefined
    const hasTarget = lookAtTarget !== undefined

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
        Shake: folder(
          {
            ["Shake Start"]: button(() => {
              startShake()
            }),
            ["Shake Stop"]: button(() => {
              stopShake()
            }),
            ["Shake (Strong)"]: button(() => {
              startShake({ strength: 0.03, frequency: 15 })
            }),
            ["Shake (Perlin)"]: button(() => {
              startShake({ mode: "perlin", strength: 0.02 })
            }),
            ["Impact (Light)"]: button(() => {
              startShake({
                duration: 300,
                strength: 0.015,
                rampUpTime: 50,
                settleTime: 200,
              })
            }),
            ["Impact (Heavy)"]: button(() => {
              startShake({
                duration: 800,
                strength: 0.04,
                rampUpTime: 100,
                settleTime: 500,
              })
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

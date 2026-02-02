import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { button, folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { useDimAnimation } from "@/animations/dimAnim"
import { useExposureAnimation } from "@/animations/exposureAnim"
import { useHyperspaceAnimation } from "@/animations/hyperspaceAnim"
import { useShakeAnimation } from "@/animations/shakeAnim"
import { useShockwaveAnimation } from "@/animations/shockwaveAnim"
import { useShowControls } from "@/hooks/useStarfieldControls"
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
  const showControls = useShowControls()
  const initialAnimationPlayed = useRef(false)
  const isFirstSceneCycleRef = useRef(true) // Skip exit transition for first scene
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)

  const { start: startDim } = useDimAnimation()
  const { start: startExposure } = useExposureAnimation()
  const { start: startHyperspace } = useHyperspaceAnimation()
  const { start: startShake, stop: stopShake } = useShakeAnimation()
  const { start: startShockwave } = useShockwaveAnimation()

  const animationStartRefs = useRef<{
    startHyperspace: typeof startHyperspace
    startShake: typeof startShake
    stopShake: typeof stopShake
    startShockwave: typeof startShockwave
    startDim: typeof startDim
  } | null>(null)

  useLayoutEffect(() => {
    animationStartRefs.current = {
      startHyperspace,
      startShake,
      stopShake,
      startShockwave,
      startDim,
    }
  })

  const playInitialAnimation = useCallback(() => {
    if (!animationStartRefs.current) return

    // Double rAF here just to ensure all objects are mounted (precaution)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        animationStartRefs.current?.startShake()
        animationStartRefs.current?.startHyperspace(
          "exit",
          () => {
            animationStartRefs.current?.stopShake()
          },
          {
            initialExposure: 0,
          }
        )
      })
    })
  }, [])

  const playTransitionAnimation = useCallback((direction: "enter" | "exit") => {
    console.debug("[STARFIELD] Playing transition animation", direction)
    if (!animationStartRefs.current) return

    // Enter: start shake + dim, Exit: stop shake + undim
    // Springs handle smooth transitions automatically
    if (direction === "enter") {
      animationStartRefs.current?.startShake()
      animationStartRefs.current?.startDim("enter")
    } else {
      animationStartRefs.current?.stopShake()
      animationStartRefs.current?.startDim("exit")
    }
  }, [])

  // Scene transition handler - springs handle smooth transitions
  useEffect(() => {
    if (!useGameStore.getState().isReady) return

    console.debug("[STARFIELD] Scene change requested:", isSceneChanging)

    // First time the scene is changing, play the initial animation
    if (!initialAnimationPlayed.current) {
      playInitialAnimation()
      initialAnimationPlayed.current = true
      return
    }

    // First scene cycle: when isSceneChanging goes back to false, mark cycle complete
    // but don't play exit transition (initial animation already revealed the scene)
    if (isFirstSceneCycleRef.current) {
      if (!isSceneChanging) {
        console.debug("[STARFIELD] First scene cycle complete, no exit transition needed")
        isFirstSceneCycleRef.current = false
      }
      return
    }

    // Play transition - springs handle smooth state changes automatically
    playTransitionAnimation(isSceneChanging ? "enter" : "exit")
  }, [isSceneChanging, playInitialAnimation, playTransitionAnimation])

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

  useControls(
    () =>
      (showControls
        ? {
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
          }
        : {}) as Schema
  )

  return null
}

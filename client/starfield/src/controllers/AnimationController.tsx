import { useCallback, useEffect, useRef } from "react"
import { invalidate, useFrame } from "@react-three/fiber"
import { button, folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { useDimAnimation } from "@/animations/dimAnim"
import { useExposureAnimation } from "@/animations/exposureAnim"
import { useHyperspaceAnimation } from "@/animations/hyperspaceAnim"
import { useSceneChangeAnimation } from "@/animations/sceneChangeAnim"
import { useShakeAnimation } from "@/animations/shakeAnim"
import { useShockwaveAnimation } from "@/animations/shockwaveAnim"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { useAnimationStore } from "@/useAnimationStore"
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

  // Animation hooks - these set up the animations and register in store
  // All animations are accessed via useAnimationStore.getState().animations
  useDimAnimation()
  useExposureAnimation()
  useHyperspaceAnimation()
  useSceneChangeAnimation()
  useShakeAnimation()
  useShockwaveAnimation()

  const playInitialAnimation = useCallback(() => {
    // Double rAF here just to ensure all objects are mounted (precaution)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        console.debug(
          "%c[STARFIELD] Playing initial animation",
          "color: blue; font-weight: bold"
        )
        const { animations } = useAnimationStore.getState()
        animations.shake?.start()
        animations.hyperspace?.start(
          "exit",
          () => {
            animations.shake?.stop()
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

    const { animations } = useAnimationStore.getState()

    // Enter: start shake + scene change, Exit: stop shake + undim
    if (direction === "enter") {
      animations.shake?.start()
      animations.sceneChange?.start("enter")
    } else {
      animations.shake?.stop()
      animations.sceneChange?.start("exit")
    }
  }, [])

  // Scene transition handler - uses Zustand subscribe for synchronous updates
  // This fires immediately when isSceneChanging changes, bypassing React's async render cycle
  useEffect(() => {
    const unsub = useGameStore.subscribe(
      (state) => state.isSceneChanging,
      (isSceneChanging) => {
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
            console.debug(
              "[STARFIELD] First scene cycle complete, no exit transition needed"
            )
            isFirstSceneCycleRef.current = false
          }
          return
        }

        // Play transition - springs handle smooth state changes automatically
        playTransitionAnimation(isSceneChanging ? "enter" : "exit")
      }
    )

    return unsub
  }, [playInitialAnimation, playTransitionAnimation])

  // Subscribe to camera look-at target
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)
  const prevLookAtTargetRef = useRef<string | undefined>(undefined)

  // React to camera target changes - dim when targeting, undim when released
  useEffect(() => {
    const hadTarget = prevLookAtTargetRef.current !== undefined
    const hasTarget = lookAtTarget !== undefined
    const { animations } = useAnimationStore.getState()

    if (!hadTarget && hasTarget) {
      // Gained a target - dim the background
      console.debug("[STARFIELD] Gained a target - dim the background")
      animations.shake?.kill()
      animations.dim?.start("enter")
    } else if (hadTarget && !hasTarget) {
      console.debug("[STARFIELD] Lost a target - restore background")
      // Lost the target - restore background
      animations.shake?.kill()
      animations.dim?.start("exit")
    }

    prevLookAtTargetRef.current = lookAtTarget
  }, [lookAtTarget])

  // Keep render loop alive while any animation is running
  // Important: Read directly from store to avoid stale closure
  useFrame(() => {
    if (useAnimationStore.getState().isAnimating) {
      invalidate()
    }
  })

  useControls(
    () =>
      (showControls
        ? {
            Animations: folder(
              {
                Dim: folder(
                  {
                    ["Dim Enter"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.dim?.start("enter")
                    }),
                    ["Dim Exit"]: button(() => {
                      useAnimationStore.getState().animations.dim?.start("exit")
                    }),
                  },
                  { collapsed: true }
                ),
                Exposure: folder(
                  {
                    ["Exposure Enter"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.exposure?.start("enter")
                    }),
                    ["Exposure Exit"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.exposure?.start("exit")
                    }),
                  },
                  { collapsed: true }
                ),
                Hyperspace: folder(
                  {
                    ["Hyperspace Enter"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.hyperspace?.start("enter")
                    }),
                    ["Hyperspace Exit"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.hyperspace?.start("exit")
                    }),
                  },
                  { collapsed: true }
                ),
                SceneChange: folder(
                  {
                    ["Scene Change Enter"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.sceneChange?.start("enter")
                    }),
                    ["Scene Change Exit"]: button(() => {
                      useAnimationStore
                        .getState()
                        .animations.sceneChange?.start("exit")
                    }),
                  },
                  { collapsed: true }
                ),
                Shake: folder(
                  {
                    ["Shake Start"]: button(() => {
                      useAnimationStore.getState().animations.shake?.start()
                    }),
                    ["Shake Stop"]: button(() => {
                      useAnimationStore.getState().animations.shake?.stop()
                    }),
                    ["Shake (Strong)"]: button(() => {
                      useAnimationStore.getState().animations.shake?.start({
                        strength: 0.03,
                        frequency: 15,
                      })
                    }),
                    ["Shake (Perlin)"]: button(() => {
                      useAnimationStore.getState().animations.shake?.start({
                        mode: "perlin",
                        strength: 0.02,
                      })
                    }),
                    ["Impact (Light)"]: button(() => {
                      useAnimationStore.getState().animations.shake?.start({
                        duration: 300,
                        strength: 0.015,
                        rampUpTime: 50,
                        settleTime: 200,
                      })
                    }),
                    ["Impact (Heavy)"]: button(() => {
                      useAnimationStore.getState().animations.shake?.start({
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
                      useAnimationStore.getState().animations.shockwave?.start()
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

import { useCallback, useEffect, useRef } from "react"
import { deepmerge } from "deepmerge-ts"

import type { Scene, SceneChangeOptions, StarfieldConfig } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

/**
 * SceneController - Manages scene queue and transition timing
 *
 * This controller has NO knowledge of animations. It simply:
 * 1. Manages a queue of scenes
 * 2. Sets isSceneChanging flag (which AnimationController reads)
 * 3. Uses timing values from config to pace scene changes
 *
 * Flow (debounced):
 * - Scene arrives → enter hyperspace → hold for hyperspaceDuration
 * - New scenes during hold → reset timer (intermediate scenes are skipped)
 * - Timer elapses → apply LAST scene in queue → exit hyperspace
 */
export function SceneController() {
  const isProcessingRef = useRef(false)
  const isFirstSceneRef = useRef(true) // First scene applies immediately
  const enterCompleteRef = useRef(false) // Whether enter animation phase has finished
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setIsSceneChanging = useGameStore((state) => state.setIsSceneChanging)

  // Apply scene changes
  const applyScene = useCallback((scene: Scene) => {
    const state = useGameStore.getState()

    console.debug("[SCENE CONTROLLER] Applying scene:", scene.id)

    // Clear existing game objects before loading new scene
    state.setGameObjects([])
    state.setPositionedGameObjects([])

    // Update current scene
    state.setCurrentScene(scene)

    // Apply config changes
    const mergedConfig = deepmerge(
      state.starfieldConfig,
      scene.config
    ) as StarfieldConfig
    state.setStarfieldConfig(mergedConfig)

    // Load new game objects from scene
    state.setGameObjects(scene.gameObjects)
  }, [])

  // Apply the last scene in the queue and exit hyperspace
  const applyLastSceneAndExit = useCallback(() => {
    const state = useGameStore.getState()
    const queue = state.sceneQueue
    const lastQueued = queue[queue.length - 1]

    if (!lastQueued) {
      // Queue was emptied (shouldn't normally happen) - just exit
      console.debug(
        "[SCENE CONTROLLER] Hold timer fired but queue empty, exiting"
      )
      isProcessingRef.current = false
      enterCompleteRef.current = false
      holdTimerRef.current = null
      setIsSceneChanging(false)
      useCallbackStore.getState().onSceneChangeEnd()
      return
    }

    console.debug(
      "[SCENE CONTROLLER] Hold complete, applying last scene:",
      lastQueued.scene.id,
      `(skipped ${queue.length - 1} intermediate scene(s))`
    )

    // Clear the entire queue, then apply only the last scene
    state.clearSceneQueue()
    applyScene(lastQueued.scene)

    // Exit hyperspace
    isProcessingRef.current = false
    enterCompleteRef.current = false
    holdTimerRef.current = null
    setIsSceneChanging(false)
    useCallbackStore.getState().onSceneChangeEnd()
  }, [applyScene, setIsSceneChanging])

  // Start (or restart) the hold timer
  const startHoldTimer = useCallback(() => {
    const { hyperspaceDuration = 2000 } =
      useGameStore.getState().starfieldConfig

    // Clear any existing hold timer
    if (holdTimerRef.current !== null) {
      console.debug("[SCENE CONTROLLER] Resetting hold timer")
      clearTimeout(holdTimerRef.current)
    }

    console.debug(
      "[SCENE CONTROLLER] Starting hold timer:",
      hyperspaceDuration,
      "ms"
    )
    holdTimerRef.current = setTimeout(applyLastSceneAndExit, hyperspaceDuration)
  }, [applyLastSceneAndExit])

  // Enqueue a scene for processing
  const enqueueScene = useCallback(
    (scene: Scene, options?: SceneChangeOptions) => {
      console.debug("[SCENE CONTROLLER] Enqueuing scene:", scene.id, options)

      // Check if we're in a ready state before enqueuing
      if (!useGameStore.getState().isReady) {
        console.debug("[SCENE CONTROLLER] Not ready, ignoring scene:", scene.id)
        return
      }

      const state = useGameStore.getState()

      // Prevent duplicate scenes (same as current or last in queue)
      const lastInQueue = state.sceneQueue[state.sceneQueue.length - 1]
      const isDuplicate =
        state.currentScene?.id === scene.id ||
        lastInQueue?.scene.id === scene.id

      if (isDuplicate) {
        console.debug(
          "[SCENE CONTROLLER] Duplicate scene detected, ignoring:",
          scene.id
        )
        return
      }

      // First scene: apply immediately (initial animation handles the reveal)
      if (isFirstSceneRef.current) {
        console.debug(
          "[SCENE CONTROLLER] First scene, applying immediately:",
          scene.id
        )
        isFirstSceneRef.current = false
        setIsSceneChanging(true) // Trigger AnimationController

        applyScene(scene)
        // Single rAF is sufficient - AnimationController uses Zustand subscribe
        // which fires synchronously when setIsSceneChanging(true) is called above
        requestAnimationFrame(() => {
          setIsSceneChanging(false)
          useCallbackStore.getState().onSceneChangeEnd()
        })
        return
      }

      // Add to queue
      console.debug("[SCENE CONTROLLER] Adding scene to queue:", scene.id)
      state.addSceneToQueue({ scene, options })

      if (!isProcessingRef.current) {
        // Not processing yet — enter hyperspace, then start the hold timer
        console.debug("[SCENE CONTROLLER] Starting hyperspace enter")
        isProcessingRef.current = true
        enterCompleteRef.current = false
        state.setLookAtTarget(undefined)
        setIsSceneChanging(true)
        useCallbackStore.getState().onSceneChangeStart()

        const { hyperspaceEnterTime = 1500 } = state.starfieldConfig

        // Wait for enter animation to complete, then start hold timer
        enterTimerRef.current = setTimeout(() => {
          console.debug(
            "[SCENE CONTROLLER] Enter complete, starting hold timer"
          )
          enterCompleteRef.current = true
          enterTimerRef.current = null
          startHoldTimer()
        }, hyperspaceEnterTime)
      } else if (enterCompleteRef.current) {
        // Already in hyperspace and enter is done — reset the hold timer
        console.debug(
          "[SCENE CONTROLLER] New scene during hold, resetting timer"
        )
        startHoldTimer()
      } else {
        // Still in enter animation — scene is queued, timer will start
        // after enter completes (no action needed)
        console.debug(
          "[SCENE CONTROLLER] New scene during enter, queued for hold"
        )
      }
    },
    [applyScene, startHoldTimer, setIsSceneChanging]
  )

  // Expose enqueueScene via callback store for external use
  useEffect(() => {
    useCallbackStore.setState({ enqueueScene })
  }, [enqueueScene])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current)
      if (enterTimerRef.current !== null) clearTimeout(enterTimerRef.current)
    }
  }, [])

  return null
}

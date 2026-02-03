import { useCallback, useEffect, useRef } from "react"
import { deepmerge } from "deepmerge-ts"

import type {
  GameObject,
  Scene,
  SceneChangeOptions,
  StarfieldConfig,
} from "@/types"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

export function SceneController() {
  const isProcessingRef = useRef(false)
  const isFirstSceneRef = useRef(true) // First scene applies immediately, no transition wait
  const processNextInQueueRef = useRef<(() => void) | null>(null)
  const sceneChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enterTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const setIsSceneChanging = useGameStore((state) => state.setIsSceneChanging)

  // Start or reset the timer to set isSceneChanging to false
  const startSceneChangeCompleteTimer = useCallback(() => {
    // Clear any existing timer
    if (sceneChangeTimerRef.current) {
      clearTimeout(sceneChangeTimerRef.current)
      sceneChangeTimerRef.current = null
    }

    // Use hyperspaceExitTime from config as the delay
    const { starfieldConfig } = useGameStore.getState()
    const delay = starfieldConfig.hyperspaceExitTime ?? 1500

    console.debug(
      "[SCENE CONTROLLER] Starting scene change complete timer:",
      delay
    )

    sceneChangeTimerRef.current = setTimeout(() => {
      const state = useGameStore.getState()

      // Only set to false if the queue is still empty
      if (state.sceneQueue.length === 0 && !isProcessingRef.current) {
        console.debug(
          "[SCENE CONTROLLER] Timer complete, queue empty - setting isSceneChanging to false"
        )
        setIsSceneChanging(false)
      } else {
        console.debug(
          "[SCENE CONTROLLER] Timer complete but queue not empty, skipping"
        )
      }

      sceneChangeTimerRef.current = null
    }, delay)
  }, [setIsSceneChanging])

  // Reset timers when new scenes are added
  const resetSceneChangeTimer = useCallback(() => {
    if (sceneChangeTimerRef.current) {
      console.debug("[SCENE CONTROLLER] Resetting scene change complete timer")
      clearTimeout(sceneChangeTimerRef.current)
      sceneChangeTimerRef.current = null
    }
    if (enterTransitionTimerRef.current) {
      console.debug("[SCENE CONTROLLER] Resetting enter transition timer")
      clearTimeout(enterTransitionTimerRef.current)
      enterTransitionTimerRef.current = null
    }
  }, [])

  // Apply scene changes immediately
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

    // Map game objects with default positions
    const positionedObjects = scene.gameObjects.map((obj: GameObject) => ({
      ...obj,
      position: [0, 0, 0] as [number, number, number],
    }))
    state.setPositionedGameObjects(positionedObjects)
  }, [])

  // Helper to finish processing after scene is applied
  const finishSceneProcessing = useCallback(() => {
    // Process next scene if any remain
    if (useGameStore.getState().sceneQueue.length > 0) {
      // Use requestAnimationFrame to allow React to process state updates
      requestAnimationFrame(() => {
        processNextInQueueRef.current?.()
      })
    } else {
      isProcessingRef.current = false
      // Start timer to set isSceneChanging to false after delay
      startSceneChangeCompleteTimer()
    }
  }, [startSceneChangeCompleteTimer])

  // Process the next scene in queue
  const processNextInQueue = useCallback(() => {
    const state = useGameStore.getState()
    const callbacks = useCallbackStore.getState()

    if (state.sceneQueue.length === 0) {
      isProcessingRef.current = false
      return
    }

    // Signal start of scene change when we begin processing
    if (!isProcessingRef.current) {
      setIsSceneChanging(true)
      callbacks.onSceneChangeStart()
    }

    isProcessingRef.current = true

    const queuedScene = state.removeSceneFromQueue()
    if (!queuedScene) {
      isProcessingRef.current = false
      return
    }

    console.debug("[SCENE CONTROLLER] Processing scene:", queuedScene.scene.id)

    // First scene: apply immediately (initial animation handles the reveal)
    if (isFirstSceneRef.current) {
      console.debug("[SCENE CONTROLLER] First scene, applying immediately")
      isFirstSceneRef.current = false
      applyScene(queuedScene.scene)
      isProcessingRef.current = false
      // Defer isSceneChanging = false so AnimationController can see true first
      // No timer needed - initial animation handles the reveal, no exit transition
      requestAnimationFrame(() => {
        setIsSceneChanging(false)
      })
      return
    }

    // Subsequent scenes: wait for enter transition before applying
    const { starfieldConfig } = useGameStore.getState()
    const enterDelay = starfieldConfig.hyperspaceEnterTime ?? 1500

    // Clear any existing enter timer
    if (enterTransitionTimerRef.current) {
      clearTimeout(enterTransitionTimerRef.current)
    }

    enterTransitionTimerRef.current = setTimeout(() => {
      enterTransitionTimerRef.current = null
      // Apply the scene at transition apex (screen is dimmed)
      applyScene(queuedScene.scene)
      finishSceneProcessing()
    }, enterDelay)
  }, [applyScene, setIsSceneChanging, finishSceneProcessing])

  // Keep ref updated
  useEffect(() => {
    processNextInQueueRef.current = processNextInQueue
  }, [processNextInQueue])

  // Enqueue a scene for processing
  const enqueueScene = useCallback(
    (scene: Scene, options?: SceneChangeOptions) => {
      console.debug("[SCENE CONTROLLER] Enqueuing scene:", scene.id, options)
      const state = useGameStore.getState()

      // Check first if we're in a ready state before enqueuing
      if (!useGameStore.getState().isReady) {
        console.debug("[SCENE CONTROLLER] Not ready, ignoring scene:", scene.id)
        return
      }

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

      console.debug("[SCENE CONTROLLER] Adding scene to queue:", scene.id)
      state.addSceneToQueue({ scene, options })

      // Reset the scene change complete timer since we have new work
      resetSceneChangeTimer()

      // Start processing if not already in progress
      if (!isProcessingRef.current) {
        console.debug(
          "[SCENE CONTROLLER] Starting to process queue immediately"
        )
        processNextInQueue()
      }
    },
    [processNextInQueue, resetSceneChangeTimer]
  )

  // Expose enqueueScene via callback store for external use
  useEffect(() => {
    useCallbackStore.setState({ enqueueScene })
  }, [enqueueScene])

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (sceneChangeTimerRef.current) {
        clearTimeout(sceneChangeTimerRef.current)
      }
      if (enterTransitionTimerRef.current) {
        clearTimeout(enterTransitionTimerRef.current)
      }
    }
  }, [])

  return null
}

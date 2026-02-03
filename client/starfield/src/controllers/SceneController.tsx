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
 * Flow:
 * - Scene arrives → add to queue → start processing if not already
 * - Processing: wait enterTime → apply → wait exitTime → process next
 * - isSceneChanging stays true until queue is empty
 */
export function SceneController() {
  const isProcessingRef = useRef(false)
  const isFirstSceneRef = useRef(true) // First scene applies immediately
  const processNextRef = useRef<() => void>(() => {})
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

  // Process one scene through full cycle: enter → apply → exit → next
  const processNextScene = useCallback(() => {
    const queuedScene = useGameStore.getState().removeSceneFromQueue()

    if (!queuedScene) {
      // Queue empty - done processing
      console.debug(
        "[SCENE CONTROLLER] Queue empty, setting isSceneChanging to false"
      )
      isProcessingRef.current = false
      setIsSceneChanging(false)
      return
    }

    console.debug("[SCENE CONTROLLER] Processing scene:", queuedScene.scene.id)

    const { hyperspaceEnterTime = 1500, hyperspaceExitTime = 1500 } =
      useGameStore.getState().starfieldConfig

    // Wait for enter time, then apply scene
    setTimeout(() => {
      console.debug(
        "[SCENE CONTROLLER] Enter time complete, applying scene:",
        queuedScene.scene.id
      )
      applyScene(queuedScene.scene)

      // Wait for exit time, then process next scene
      setTimeout(() => {
        console.debug("[SCENE CONTROLLER] Exit time complete, checking queue")
        processNextRef.current()
      }, hyperspaceExitTime)
    }, hyperspaceEnterTime)
  }, [applyScene, setIsSceneChanging])

  // Keep ref updated for recursive calls (avoids circular useCallback deps)
  useEffect(() => {
    processNextRef.current = processNextScene
  }, [processNextScene])

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
        // Defer isSceneChanging = false so AnimationController sees true first
        requestAnimationFrame(() => {
          setIsSceneChanging(false)
        })
        return
      }

      // Add to queue
      console.debug("[SCENE CONTROLLER] Adding scene to queue:", scene.id)
      state.addSceneToQueue({ scene, options })

      // Start processing if not already in progress
      if (!isProcessingRef.current) {
        console.debug("[SCENE CONTROLLER] Starting queue processing")
        isProcessingRef.current = true
        setIsSceneChanging(true)
        useCallbackStore.getState().onSceneChangeStart()
        processNextScene()
      } else {
        console.debug("[SCENE CONTROLLER] Already processing, scene queued")
      }
    },
    [applyScene, processNextScene, setIsSceneChanging]
  )

  // Expose enqueueScene via callback store for external use
  useEffect(() => {
    useCallbackStore.setState({ enqueueScene })
  }, [enqueueScene])

  return null
}

import { useCallback, useEffect, useRef } from "react"
import { useThree } from "@react-three/fiber"
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
  const { invalidate } = useThree()

  const isProcessingRef = useRef(false)
  const processNextInQueueRef = useRef<(() => void) | null>(null)

  // Apply scene changes immediately
  const applyScene = useCallback(
    (scene: Scene) => {
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

      invalidate()
    },
    [invalidate]
  )

  // Process the next scene in queue
  const processNextInQueue = useCallback(() => {
    const state = useGameStore.getState()

    if (state.sceneQueue.length === 0) {
      isProcessingRef.current = false
      return
    }

    isProcessingRef.current = true

    const queuedScene = state.removeSceneFromQueue()
    if (queuedScene) {
      console.debug(
        "[SCENE CONTROLLER] Processing scene:",
        queuedScene.scene.id
      )
      applyScene(queuedScene.scene)
    }

    // Process next scene if any remain
    if (state.sceneQueue.length > 0) {
      // Use requestAnimationFrame to allow React to process state updates
      requestAnimationFrame(() => {
        processNextInQueueRef.current?.()
      })
    } else {
      isProcessingRef.current = false
    }
  }, [applyScene])

  // Keep ref updated
  useEffect(() => {
    processNextInQueueRef.current = processNextInQueue
  }, [processNextInQueue])

  // Enqueue a scene for processing
  const enqueueScene = useCallback(
    (scene: Scene, options?: SceneChangeOptions) => {
      console.debug("[SCENE CONTROLLER] Enqueuing scene:", scene.id, options)
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

      console.debug("[SCENE CONTROLLER] Adding scene to queue:", scene.id)
      state.addSceneToQueue({ scene, options })

      // Start processing if not already in progress
      if (!isProcessingRef.current) {
        console.debug(
          "[SCENE CONTROLLER] Starting to process queue immediately"
        )
        processNextInQueue()
      }
    },
    [processNextInQueue]
  )

  // Expose enqueueScene via callback store for external use
  useEffect(() => {
    useCallbackStore.setState({ enqueueScene })
  }, [enqueueScene])

  return null
}

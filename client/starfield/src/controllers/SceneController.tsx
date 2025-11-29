import { useCallback, useEffect, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { deepmerge } from "deepmerge-ts"

import { SCENE_TRANSITION_TIMING } from "@/constants"
import { useWarpAnimation } from "@/hooks/animations"
import type {
  GameObject,
  Scene,
  SceneChangeOptions,
  StarfieldConfig,
} from "@/types"
import { useAnimationStore } from "@/useAnimationStore"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

export function SceneController() {
  const { invalidate } = useThree()

  const isSceneChanging = useGameStore(
    (state: { isSceneChanging: boolean }) => state.isSceneChanging
  )

  // Warp animation
  const { progress: warpProgress, isWarping } = useWarpAnimation()
  const startWarp = useAnimationStore((state) => state.startWarp)
  const stopWarp = useAnimationStore((state) => state.stopWarp)
  const sceneAppliedRef = useRef(false)
  const completingRef = useRef(false)
  const processNextInQueueRef = useRef<(() => void) | null>(null)

  // Apply scene changes (no guards, just applies the scene)
  const applySceneChanges = useCallback(() => {
    const state = useGameStore.getState()
    const queuedScene = state.removeSceneFromQueue()

    if (queuedScene) {
      const { scene } = queuedScene
      console.debug("[SCENE CONTROLLER] Applying scene:", scene.id)

      // Update current scene
      state.setCurrentScene(scene)

      // Apply config changes at the white flash moment
      const mergedConfig = deepmerge(
        state.starfieldConfig,
        scene.config
      ) as StarfieldConfig
      state.setStarfieldConfig(mergedConfig)

      // Map game objects with default positions
      const positionedObjects = scene.gameObjects.map((obj: GameObject) => ({
        ...obj,
        position: [0, 0, 0] as [number, number, number],
      }))
      state.setPositionedObjects(positionedObjects)
    }
  }, [])

  // Process the next scene in queue with proper animation handling
  const processNextInQueue = useCallback(() => {
    const state = useGameStore.getState()

    if (state.sceneQueue.length === 0) return

    const nextQueuedScene = state.sceneQueue[0]

    // Check if this scene should bypass animation
    if (nextQueuedScene.options?.bypassAnimation) {
      console.debug(
        "[SCENE CONTROLLER] Processing scene without animation:",
        nextQueuedScene.scene.id
      )

      // Mark as changing to prevent other scenes from starting immediately
      state.setIsSceneChanging(true)

      // Apply the scene directly
      applySceneChanges()

      // Wait for the pause duration before processing next
      setTimeout(() => {
        console.debug(
          "[SCENE CONTROLLER] Instant scene pause complete, checking queue"
        )
        state.setIsSceneChanging(false)

        // Process next scene if any
        const updatedState = useGameStore.getState()
        if (updatedState.sceneQueue.length > 0) {
          console.debug(
            "[SCENE CONTROLLER] Processing next queued scene after instant transition"
          )
          processNextInQueueRef.current?.()
        }
      }, SCENE_TRANSITION_TIMING.POST_INSTANT_PAUSE)
    } else {
      console.debug(
        "[SCENE CONTROLLER] Processing scene with warp:",
        nextQueuedScene.scene.id
      )

      // Start warp animation for this scene
      state.setIsSceneChanging(true)
      sceneAppliedRef.current = false
      completingRef.current = false
      startWarp()
    }
  }, [startWarp, applySceneChanges])

  // Keep ref updated
  useEffect(() => {
    processNextInQueueRef.current = processNextInQueue
  }, [processNextInQueue])

  // Complete scene transition and start next if queued
  const completeSceneTransition = useCallback(() => {
    console.debug("[SCENE CONTROLLER] Completing scene transition")
    const state = useGameStore.getState()

    // Check if there are more scenes to process
    if (state.sceneQueue.length > 0) {
      console.debug(
        `[SCENE CONTROLLER] More scenes queued, waiting ${SCENE_TRANSITION_TIMING.POST_WARP_PAUSE}ms before next...`
      )
      // Keep isSceneChanging true during the pause to block new scenes
      setTimeout(() => {
        console.debug(
          "[SCENE CONTROLLER] Post-warp pause complete, processing next scene"
        )
        const updatedState = useGameStore.getState()
        updatedState.setIsSceneChanging(false)
        processNextInQueueRef.current?.()
      }, SCENE_TRANSITION_TIMING.POST_WARP_PAUSE)
    } else {
      // No more scenes, mark as complete immediately
      state.setIsSceneChanging(false)
    }
  }, [])

  // Orchestration logic: enqueue scene
  const enqueueScene = useCallback(
    (scene: Scene, options?: SceneChangeOptions) => {
      console.debug("[SCENE CONTROLLER] Enqueuing scene:", scene.id, options)
      const state = useGameStore.getState()

      // Check if this would be a duplicate
      // Prevent same scene from being enqueued if it's currently active or last in queue
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
      // Store scene with its options
      state.addSceneToQueue({ scene, options })

      // If no scene is currently being processed AND no warp animation in progress,
      // start processing immediately
      if (!state.isSceneChanging && !isWarping) {
        console.debug(
          "[SCENE CONTROLLER] Starting to process queue immediately"
        )
        processNextInQueue()
      } else {
        console.debug(
          `[SCENE CONTROLLER] Waiting - isSceneChanging: ${state.isSceneChanging}, isWarping: ${isWarping}`
        )
      }
    },
    [processNextInQueue, isWarping]
  )

  // Watch warp progress - apply scene at peak
  useFrame(() => {
    if (isSceneChanging && isWarping && !sceneAppliedRef.current) {
      const currentProgress = warpProgress.get()
      if (currentProgress >= 0.99) {
        console.debug("[SCENE CONTROLLER] Warp at peak, applying scene")
        sceneAppliedRef.current = true
        applySceneChanges()

        // TODO: Replace timeout with component ready check
        setTimeout(() => {
          console.debug(
            "[SCENE CONTROLLER] Components settled, starting warp exit"
          )
          stopWarp()
        }, SCENE_TRANSITION_TIMING.WARP_PEAK_SETTLE_TIME)
      }
    }
  })

  // Watch for warp exit animation to fully complete (reach 0)
  useFrame(() => {
    if (
      isSceneChanging &&
      !isWarping &&
      sceneAppliedRef.current &&
      !completingRef.current
    ) {
      const currentProgress = warpProgress.get()
      if (currentProgress <= 0.01) {
        console.debug(
          "[SCENE CONTROLLER] Warp exit animation complete, finalizing"
        )
        completingRef.current = true // Prevent multiple calls
        completeSceneTransition()
        invalidate()
      }
    }
  })

  // Keep rendering while there are scenes in the queue
  useFrame(() => {
    const state = useGameStore.getState()
    if (state.sceneQueue.length > 0) {
      invalidate()
    }
  })

  // Expose enqueueScene via callback store for external use
  useEffect(() => {
    useCallbackStore.setState({ enqueueScene })
  }, [enqueueScene])

  return null
}

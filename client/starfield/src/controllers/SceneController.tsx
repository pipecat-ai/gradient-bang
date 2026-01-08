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
  const setIsShaking = useAnimationStore((state) => state.setIsShaking)

  // Warp animation
  const { progress: warpProgress, isWarping } = useWarpAnimation()
  const startWarp = useAnimationStore((state) => state.startWarp)
  const onWarpAnimationStart = useCallbackStore(
    (state) => state.onWarpAnimationStart
  )
  const stopWarp = useAnimationStore((state) => state.stopWarp)
  const setIsPaused = useGameStore((state) => state.setIsPaused)
  const sceneAppliedRef = useRef(false)
  const completingRef = useRef(false)
  const processNextInQueueRef = useRef<(() => void) | null>(null)

  // Track timeouts for cleanup on unmount
  const timeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Warp cooldown timeout tracking
  const warpCooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // Helper to track timeouts and prevent memory leaks
  const setTrackedTimeout = useCallback(
    (callback: () => void, delay: number) => {
      const timeout = setTimeout(() => {
        timeoutsRef.current.delete(timeout)
        callback()
      }, delay)
      timeoutsRef.current.add(timeout)
      return timeout
    },
    []
  )

  // Start warp cooldown timer (or skip if WARP_COOLDOWN is 0)
  const startWarpCooldown = useCallback(() => {
    if (SCENE_TRANSITION_TIMING.WARP_COOLDOWN <= 0) return

    console.debug(
      `[SCENE CONTROLLER] Starting warp cooldown for ${SCENE_TRANSITION_TIMING.WARP_COOLDOWN}ms`
    )

    const state = useGameStore.getState()
    state.setIsWarpCooldownActive(true)

    // Clear any existing cooldown
    if (warpCooldownTimeoutRef.current) {
      clearTimeout(warpCooldownTimeoutRef.current)
    }

    // Start new cooldown
    warpCooldownTimeoutRef.current = setTrackedTimeout(() => {
      console.debug(
        "[SCENE CONTROLLER] Warp cooldown expired, animations enabled"
      )
      const updatedState = useGameStore.getState()
      updatedState.setIsWarpCooldownActive(false)
      warpCooldownTimeoutRef.current = null
    }, SCENE_TRANSITION_TIMING.WARP_COOLDOWN)
  }, [setTrackedTimeout])

  // Reset warp cooldown timer when new scene is enqueued
  const resetWarpCooldown = useCallback(() => {
    if (SCENE_TRANSITION_TIMING.WARP_COOLDOWN <= 0) return

    const state = useGameStore.getState()
    if (!state.isWarpCooldownActive) return

    console.debug("[SCENE CONTROLLER] Resetting warp cooldown timer")

    // Clear existing cooldown
    if (warpCooldownTimeoutRef.current) {
      clearTimeout(warpCooldownTimeoutRef.current)
    }

    // Start fresh cooldown
    warpCooldownTimeoutRef.current = setTrackedTimeout(() => {
      console.debug(
        "[SCENE CONTROLLER] Warp cooldown expired, animations enabled"
      )
      const updatedState = useGameStore.getState()
      updatedState.setIsWarpCooldownActive(false)
      warpCooldownTimeoutRef.current = null
    }, SCENE_TRANSITION_TIMING.WARP_COOLDOWN)
  }, [setTrackedTimeout])

  // Cleanup all pending timeouts on unmount
  useEffect(() => {
    const timeouts = timeoutsRef.current
    return () => {
      timeouts.forEach(clearTimeout)
      timeouts.clear()

      // Clean up cooldown timeout
      if (warpCooldownTimeoutRef.current) {
        clearTimeout(warpCooldownTimeoutRef.current)
      }
    }
  }, [])

  // Automatically manage shake state: on during all scene changes
  useEffect(() => {
    if (isSceneChanging) {
      // Scene is changing - shake should be active for all transitions
      setIsShaking(true)
    } else {
      // No scene change in progress - shake should be off
      setIsShaking(false)
    }
  }, [isSceneChanging, setIsShaking])

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

    // Force bypass animation if in warp cooldown or explicitly requested
    const shouldBypass =
      nextQueuedScene.options?.bypassAnimation || state.isWarpCooldownActive

    if (shouldBypass) {
      if (state.isWarpCooldownActive) {
        console.debug(
          "[SCENE CONTROLLER] Forcing bypass due to warp cooldown:",
          nextQueuedScene.scene.id
        )
      }
      console.debug(
        "[SCENE CONTROLLER] Processing scene without animation:",
        nextQueuedScene.scene.id
      )

      // Mark as changing to prevent other scenes from starting immediately
      state.setIsSceneChanging(true)

      // Reset state flags for new scene
      sceneAppliedRef.current = false
      completingRef.current = false

      // Wait before applying scene changes (gives shaking time to be visible)
      setTrackedTimeout(() => {
        console.debug(
          "[SCENE CONTROLLER] Pre-instant delay complete, applying scene"
        )

        // Apply the scene changes
        applySceneChanges()

        // Wait for the pause duration before processing next
        setTrackedTimeout(() => {
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
      }, SCENE_TRANSITION_TIMING.PRE_INSTANT_DELAY)
    } else {
      console.debug(
        "[SCENE CONTROLLER] Processing scene with warp:",
        nextQueuedScene.scene.id
      )

      // Start warp animation for this scene
      state.setIsSceneChanging(true)

      // Reset state flags for new scene
      sceneAppliedRef.current = false
      completingRef.current = false

      startWarp()
      onWarpAnimationStart()
    }
  }, [startWarp, applySceneChanges, setTrackedTimeout, onWarpAnimationStart])

  // Keep ref updated
  useEffect(() => {
    processNextInQueueRef.current = processNextInQueue
  }, [processNextInQueue])

  // Complete scene transition and start next if queued
  const completeSceneTransition = useCallback(() => {
    console.debug("[SCENE CONTROLLER] Completing scene transition")
    const state = useGameStore.getState()

    // Start warp cooldown after completing a warp animation
    startWarpCooldown()

    // Check if there are more scenes to process
    if (state.sceneQueue.length > 0) {
      console.debug(
        `[SCENE CONTROLLER] More scenes queued, waiting ${SCENE_TRANSITION_TIMING.POST_WARP_PAUSE}ms before next...`
      )
      // Keep isSceneChanging true during the pause to block new scenes
      setTrackedTimeout(() => {
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
  }, [setTrackedTimeout, startWarpCooldown])

  // Orchestration logic: enqueue scene
  const enqueueScene = useCallback(
    (scene: Scene, options?: SceneChangeOptions) => {
      console.debug("[SCENE CONTROLLER] Enqueuing scene:", scene.id, options)
      const state = useGameStore.getState()

      // Reset warp cooldown timer when new scene is added to queue
      resetWarpCooldown()

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
    [processNextInQueue, isWarping, resetWarpCooldown]
  )

  // Watch warp progress - apply scene at peak
  useFrame(() => {
    if (isSceneChanging && isWarping && !sceneAppliedRef.current) {
      const currentProgress = warpProgress.get()
      if (currentProgress >= 0.99) {
        console.debug("[SCENE CONTROLLER] Warp at peak, applying scene")
        sceneAppliedRef.current = true
        applySceneChanges()

        // @TODO: Replace timeout with component ready check
        setIsPaused(true)

        setTrackedTimeout(() => {
          console.debug(
            "[SCENE CONTROLLER] Components settled, starting warp exit"
          )
          setIsPaused(false)
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

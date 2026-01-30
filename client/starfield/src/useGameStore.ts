import { deepmerge } from "deepmerge-ts"
import { produce } from "immer"
import { create } from "zustand"

import { defaultProfile } from "@/profiles"

import {
  type GameObject,
  type PerformanceProfile,
  type PositionedGameObject,
  type QueuedScene,
  type Scene,
  type StarfieldConfig,
  type StarfieldState,
} from "./types"

interface AppState {
  starfieldConfig: StarfieldConfig
  setStarfieldConfig: (
    config: Partial<StarfieldConfig>,
    deepMerge?: boolean
  ) => void
  performanceProfile: PerformanceProfile
  setPerformanceProfile: (profile: PerformanceProfile) => void

  // State
  isReady: boolean
  setIsReady: (isReady: boolean) => void
  isPaused: boolean
  setIsPaused: (isPaused: boolean) => void
  togglePause: () => void
  sceneState: StarfieldState
  setSceneState: (state: StarfieldState) => void

  // Scene elements
  readyFlags: Record<string, boolean>
  setComponentReady: (componentId: string, ready: boolean) => void
  resetReadyFlags: () => void
  allComponentsReady: () => boolean

  // Game Objects (input - may or may not have positions)
  gameObjects: GameObject[]
  setGameObjects: (objects: GameObject[]) => void
  // Positioned Game Objects (output - always have positions, set by controller)
  positionedGameObjects: PositionedGameObject[]
  setPositionedGameObjects: (objects: PositionedGameObject[]) => void
  // Camera look-at target (game object ID or null)
  lookAtTarget: string | null
  setLookAtTarget: (target: string | null) => void
  // Camera transition state
  isCameraTransitioning: boolean
  setIsCameraTransitioning: (transitioning: boolean) => void

  // Scene Transition
  isSceneChanging: boolean
  setIsSceneChanging: (changing: boolean) => void
  isWarpCooldownActive: boolean
  setIsWarpCooldownActive: (active: boolean) => void

  // Scene Queue
  sceneQueue: QueuedScene[]
  currentScene: Scene | null
  setCurrentScene: (scene: Scene | null) => void
  addSceneToQueue: (queuedScene: QueuedScene) => void
  removeSceneFromQueue: () => QueuedScene | undefined
  clearSceneQueue: () => void
}

export const useGameStore = create<AppState>(
  (set, get): AppState => ({
    starfieldConfig: {
      ...defaultProfile,
    },
    setStarfieldConfig: (config: Partial<StarfieldConfig>, deepMerge = false) =>
      set(
        produce((draft) => {
          // Extract imageAssets - these should always replace, never merge
          const { imageAssets, ...restConfig } = config

          if (deepMerge) {
            // Deep merge everything except imageAssets
            draft.starfieldConfig = deepmerge(
              draft.starfieldConfig,
              restConfig
            ) as StarfieldConfig
            // Only update imageAssets if explicitly provided
            if (imageAssets !== undefined) {
              draft.starfieldConfig.imageAssets = imageAssets
            }
          } else {
            draft.starfieldConfig = {
              ...draft.starfieldConfig,
              ...config,
            }
          }
        })
      ),

    performanceProfile: "high",
    setPerformanceProfile: (profile: PerformanceProfile) =>
      profile !== get().performanceProfile &&
      set({ performanceProfile: profile }),

    // State
    isReady: false,
    setIsReady: (isReady: boolean) => set({ isReady }),
    isPaused: false,
    setIsPaused: (isPaused) =>
      set(
        produce((draft) => {
          draft.isPaused = isPaused
        })
      ),
    togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

    // Scene State
    sceneState: "idle",
    setSceneState: (state: StarfieldState) =>
      set(
        produce((draft) => {
          draft.sceneState = state
        })
      ),

    // Game Objects (input)
    gameObjects: [],
    setGameObjects: (gameObjects: GameObject[]) =>
      set(
        produce((draft) => {
          draft.gameObjects = gameObjects
        })
      ),
    // Positioned Game Objects (output)
    positionedGameObjects: [],
    setPositionedGameObjects: (positionedGameObjects: PositionedGameObject[]) =>
      set(
        produce((draft) => {
          draft.positionedGameObjects = positionedGameObjects
        })
      ),
    // Camera look-at target
    lookAtTarget: null,
    setLookAtTarget: (target: string | null) =>
      set(
        produce((draft) => {
          draft.lookAtTarget = target
        })
      ),
    // Camera transition state
    isCameraTransitioning: false,
    setIsCameraTransitioning: (transitioning: boolean) =>
      set(
        produce((draft) => {
          draft.isCameraTransitioning = transitioning
        })
      ),

    // Scene elements
    readyFlags: {},
    setComponentReady: (componentId: string, ready: boolean) =>
      set(
        produce((draft) => {
          draft.readyFlags[componentId] = ready
        })
      ),
    resetReadyFlags: () => set({ readyFlags: {} }),
    allComponentsReady: () => true,

    // Scene Transition
    isSceneChanging: false,
    setIsSceneChanging: (changing: boolean) =>
      set(
        produce((draft) => {
          draft.isSceneChanging = changing
        })
      ),
    isWarpCooldownActive: false,
    setIsWarpCooldownActive: (active: boolean) =>
      set(
        produce((draft) => {
          draft.isWarpCooldownActive = active
        })
      ),

    // Scene Queue
    sceneQueue: [],
    currentScene: null,
    setCurrentScene: (scene: Scene | null) =>
      set(
        produce((draft) => {
          draft.currentScene = scene
        })
      ),
    addSceneToQueue: (queuedScene: QueuedScene) =>
      set(
        produce((draft) => {
          draft.sceneQueue.push(queuedScene)
        })
      ),
    removeSceneFromQueue: () => {
      const nextQueuedScene = get().sceneQueue[0]
      if (nextQueuedScene) {
        set(
          produce((draft) => {
            draft.sceneQueue.shift()
          })
        )
      }
      return nextQueuedScene
    },
    clearSceneQueue: () =>
      set(
        produce((draft) => {
          draft.sceneQueue = []
        })
      ),
  })
)

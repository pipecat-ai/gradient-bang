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
  debug: boolean
  setDebug: (debug: boolean) => void
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
  lookAtTarget: string | undefined
  setLookAtTarget: (target: string | undefined) => void
  // Camera transition state
  isCameraTransitioning: boolean
  setIsCameraTransitioning: (transitioning: boolean) => void

  // Scene Transition
  isSceneChanging: boolean
  setIsSceneChanging: (changing: boolean) => void
  isSceneCooldownActive: boolean
  setIsSceneCooldownActive: (active: boolean) => void

  // Scene Queue
  sceneQueue: QueuedScene[]
  currentScene: Scene | null
  setCurrentScene: (scene: Scene | null) => void
  addSceneToQueue: (queuedScene: QueuedScene) => void
  removeSceneFromQueue: () => QueuedScene | undefined
  clearSceneQueue: () => void

  reset: () => void
}

export const useGameStore = create<AppState>(
  (set, get): AppState => ({
    starfieldConfig: {
      ...defaultProfile,
    },
    debug: false,
    setDebug: (debug: boolean) => set({ debug }),
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
    setGameObjects: (gameObjects: GameObject[]) => {
      // Remove lookAtTarget if it's no longer in the game objects
      if (
        get().lookAtTarget &&
        !gameObjects.some((obj) => obj.id === get().lookAtTarget)
      ) {
        set(
          produce((draft) => {
            draft.lookAtTarget = undefined
          })
        )
      }
      set(
        produce((draft) => {
          draft.gameObjects = gameObjects
        })
      )
    },
    // Positioned Game Objects (output)
    positionedGameObjects: [],
    setPositionedGameObjects: (positionedGameObjects: PositionedGameObject[]) =>
      set(
        produce((draft) => {
          draft.positionedGameObjects = positionedGameObjects
        })
      ),
    // Camera look-at target
    lookAtTarget: undefined,
    setLookAtTarget: (target: string | undefined) => {
      // Lookup target game object
      const targetGameObject = get().gameObjects.find(
        (obj) => obj.id === target
      )
      if (targetGameObject) {
        set(
          produce((draft) => {
            draft.lookAtTarget = targetGameObject.id
          })
        )
      } else {
        set(
          produce((draft) => {
            draft.lookAtTarget = undefined
          })
        )
      }
    },
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
    isSceneCooldownActive: false,
    setIsSceneCooldownActive: (active: boolean) =>
      set(
        produce((draft) => {
          draft.isSceneCooldownActive = active
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
    reset: () =>
      set({
        starfieldConfig: {
          ...defaultProfile,
        },
        debug: false,
        performanceProfile: "high",
        isReady: false,
        isPaused: false,
        gameObjects: [],
        positionedGameObjects: [],
        lookAtTarget: undefined,
        isCameraTransitioning: false,
        isSceneChanging: false,
        isSceneCooldownActive: false,
        sceneQueue: [],
        currentScene: null,
      }),
  })
)

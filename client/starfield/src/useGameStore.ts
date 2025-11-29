import { deepmerge } from "deepmerge-ts"
import { produce } from "immer"
import { create } from "zustand"

import { defaultProfile } from "@/profiles"

import {
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

  // Game Objects
  positionedObjects: PositionedGameObject[]
  setPositionedObjects: (objects: PositionedGameObject[]) => void

  // Scene Transition
  isSceneChanging: boolean
  setIsSceneChanging: (changing: boolean) => void

  // Scene Queue
  sceneQueue: QueuedScene[]
  currentScene: Scene | null
  setCurrentScene: (scene: Scene | null) => void
  addSceneToQueue: (queuedScene: QueuedScene) => void
  removeSceneFromQueue: () => QueuedScene | undefined
  clearSceneQueue: () => void
}

export const useGameStore = create<AppState>(
  (set): AppState => ({
    starfieldConfig: {
      ...defaultProfile,
    },
    setStarfieldConfig: (config: Partial<StarfieldConfig>, deepMerge = false) =>
      set(
        produce((draft) => {
          draft.starfieldConfig = deepMerge
            ? (deepmerge(draft.starfieldConfig, config) as StarfieldConfig)
            : {
                ...draft.starfieldConfig,
                ...config,
              }
        })
      ),

    performanceProfile: "high",
    setPerformanceProfile: (profile: PerformanceProfile) =>
      profile !== useGameStore.getState().performanceProfile &&
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

    // Game Objects
    positionedObjects: [],
    setPositionedObjects: (objects) =>
      set(
        produce((draft) => {
          draft.positionedObjects = objects
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
      const state = useGameStore.getState()
      const nextQueuedScene = state.sceneQueue[0]
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

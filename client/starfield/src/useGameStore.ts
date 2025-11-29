import { deepmerge } from "deepmerge-ts"
import { produce } from "immer"
import { create } from "zustand"

import { defaultProfile } from "@/profiles"

import {
  type GameObject,
  type PerformanceProfile,
  type PositionedGameObject,
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
  completeSceneChange: () => void

  // Scene Queue
  sceneQueue: Scene[]
  currentScene: Scene | null
  enqueueScene: (scene: Scene) => void
  processNextScene: () => void
  clearSceneQueue: () => void
}

export const useGameStore = create<AppState>((set) => ({
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
  completeSceneChange: () => {
    set(
      produce((draft) => {
        // Mark scene change as complete - this triggers flash-out animation
        draft.isSceneChanging = false
        // Resume rendering (for testing)
        draft.isPaused = false
        // Clear current scene
        draft.currentScene = null
      })
    )

    // Process next scene in queue if any
    const state = useGameStore.getState()
    if (state.sceneQueue.length > 0) {
      console.log("[SCENE QUEUE] Processing next scene from queue")
      state.processNextScene()
    }
  },

  // Scene Queue
  sceneQueue: [],
  currentScene: null,
  enqueueScene: (scene: Scene) =>
    set(
      produce((draft) => {
        // Check if this would be a sequential duplicate
        // Allow same scene ID in queue, just not back-to-back
        const lastInQueue = draft.sceneQueue[draft.sceneQueue.length - 1]
        const isSequentialDuplicate =
          draft.currentScene?.id === scene.id || lastInQueue?.id === scene.id

        if (isSequentialDuplicate) {
          console.log(
            "[SCENE QUEUE] Sequential duplicate detected, ignoring:",
            scene.id
          )
          return
        }

        console.log("[SCENE QUEUE] Enqueuing scene:", scene.id)
        draft.sceneQueue.push(scene)

        // If no scene is currently being processed, start processing immediately
        if (!draft.isSceneChanging && !draft.currentScene) {
          const nextScene = draft.sceneQueue.shift()
          if (nextScene) {
            console.log(
              "[SCENE QUEUE] Starting scene immediately:",
              nextScene.id
            )
            draft.currentScene = nextScene
            // Start scene change - this triggers flash-in animation
            draft.isSceneChanging = true
            // Pause rendering during scene change (for testing)
            draft.isPaused = true

            // Apply config changes immediately after setting isSceneChanging
            // NOTE: In the future, this should be deferred until after the flash
            // animation fully covers the screen to prevent visible jank
            draft.starfieldConfig = deepmerge(
              draft.starfieldConfig,
              nextScene.config
            ) as StarfieldConfig

            draft.positionedObjects = nextScene.gameObjects.map(
              (obj: GameObject) => ({
                ...obj,
                position: [0, 0, 0] as [number, number, number],
              })
            )
          }
        }
      })
    ),
  processNextScene: () =>
    set(
      produce((draft) => {
        if (draft.isSceneChanging) {
          console.log(
            "[SCENE QUEUE] Scene change already in progress, waiting..."
          )
          return
        }

        const nextScene = draft.sceneQueue.shift()
        if (nextScene) {
          console.log("[SCENE QUEUE] Processing next scene:", nextScene.id)
          draft.currentScene = nextScene
          // Start scene change - this triggers flash-in animation
          draft.isSceneChanging = true
          // Pause rendering during scene change (for testing)
          draft.isPaused = true

          // Apply config changes immediately after setting isSceneChanging
          // NOTE: In the future, this should be deferred until after the flash
          // animation fully covers the screen to prevent visible jank
          draft.starfieldConfig = deepmerge(
            draft.starfieldConfig,
            nextScene.config
          ) as StarfieldConfig

          draft.positionedObjects = nextScene.gameObjects.map(
            (obj: GameObject) => ({
              ...obj,
              position: [0, 0, 0] as [number, number, number],
            })
          )
        } else {
          console.log("[SCENE QUEUE] Queue empty, no scenes to process")
          draft.currentScene = null
        }
      })
    ),
  clearSceneQueue: () =>
    set(
      produce((draft) => {
        console.log("[SCENE QUEUE] Clearing queue")
        draft.sceneQueue = []
      })
    ),
}))

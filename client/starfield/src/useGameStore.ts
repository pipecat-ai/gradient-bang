import { produce } from "immer"
import { create } from "zustand"

import {
  type GameObject,
  type PositionedGameObject,
  type Scene,
  type SceneConfig,
  type StarfieldConfig,
  type StarfieldState,
} from "./types"

interface AppState {
  starfieldConfig: StarfieldConfig
  setStarfieldConfig: (config: Partial<StarfieldConfig>) => void

  // State
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

  // Scene Config
  sceneConfig?: SceneConfig
  setSceneConfig: (config: Partial<SceneConfig>) => void
  isSceneChanging: boolean
  startSceneChange: (newConfig: SceneConfig) => void
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
    cameraBaseFov: 85,
    vignetteAmount: 0.65,
    hyperspaceEnterTime: 3000,
    hyperspaceExitTime: 2000,
    hyperspaceDuration: 1000,
    hyperspaceCooldown: 10000,
    hyerpspaceUniforms: {
      vignetteAmount: 1,
      vignetteOffset: 0,
      cameraFov: 145,
      bloomIntensity: 50,
      bloomRadius: 1,
    },
    shakeIntensity: 1,
    shakeRelaxTime: 1000,
    shockwaveSpeed: 1.25,
  },
  setStarfieldConfig: (config: Partial<StarfieldConfig>) =>
    set(
      produce((draft) => {
        draft.starfieldConfig = {
          ...draft.starfieldConfig,
          ...config,
        }
      })
    ),

  // State
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

  // Scene Config
  sceneConfig: undefined,
  setSceneConfig: (config: Partial<SceneConfig>) =>
    set(
      produce((draft) => {
        draft.sceneConfig = {
          ...draft.sceneConfig,
          ...config,
          nebula: {
            ...draft.sceneConfig?.nebula,
            ...config.nebula,
          },
          stars: {
            ...draft.sceneConfig?.stars,
            ...config.stars,
          },
          skybox: {
            ...draft.sceneConfig?.skybox,
            ...config.skybox,
          },
        }
      })
    ),
  isSceneChanging: false,
  startSceneChange: (newConfig: SceneConfig) =>
    set(
      produce((draft) => {
        draft.isSceneChanging = true
        draft.sceneConfig = newConfig
      })
    ),
  completeSceneChange: () => {
    // First mark the current scene as complete
    set(
      produce((draft) => {
        draft.isSceneChanging = false
      })
    )

    // Then process the next scene in the queue (if any)
    // We need to do this in a separate set call to ensure state updates correctly
    setTimeout(() => {
      const state = useGameStore.getState()
      if (state.sceneQueue.length > 0) {
        console.log("[SCENE QUEUE] Scene completed, processing next in queue")
        state.processNextScene()
      } else {
        console.log("[SCENE QUEUE] Scene completed, queue is empty")
        set({ currentScene: null })
      }
    }, 0)
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
            draft.isSceneChanging = true
            draft.sceneConfig = nextScene.config
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
          draft.isSceneChanging = true
          draft.sceneConfig = nextScene.config
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

import { produce } from "immer"
import { create } from "zustand"
import type { PositionedGameObject, SceneConfig } from "./types"

interface AppState {
  // State
  isPaused: boolean
  setIsPaused: (isPaused: boolean) => void
  togglePause: () => void

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
}

export const useGameStore = create<AppState>((set) => ({
  // State
  isPaused: false,
  setIsPaused: (isPaused) =>
    set(
      produce((draft) => {
        draft.isPaused = isPaused
      })
    ),
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

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
  completeSceneChange: () =>
    set(
      produce((draft) => {
        draft.isSceneChanging = false
      })
    ),
}))

import { produce } from "immer";
import { create } from "zustand";
import { PositionedGameObject, SceneConfig } from "../types";

interface AppState {
  // State
  isPaused: boolean;
  setIsPaused: (isPaused: boolean) => void;
  togglePause: () => void;

  // Game Objects
  positionedObjects: PositionedGameObject[];
  setPositionedObjects: (objects: PositionedGameObject[]) => void;

  // Scene Config
  sceneConfig?: SceneConfig;
  setSceneConfig: (config: Partial<SceneConfig>) => void;
}

export const useGameStore = create<AppState>((set) => ({
  // State
  isPaused: false,
  setIsPaused: (isPaused) =>
    set(
      produce((draft) => {
        draft.isPaused = isPaused;
      })
    ),
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

  // Game Objects
  positionedObjects: [],
  setPositionedObjects: (objects) =>
    set(
      produce((draft) => {
        draft.positionedObjects = objects;
      })
    ),

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
        };
      })
    ),
}));

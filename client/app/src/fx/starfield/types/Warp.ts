import type { StarfieldSceneConfig } from "../constants";
import type { GameObjectBaseConfig } from "../types/GameObject";

export interface WarpOptions {
  id?: string;
  name?: string;
  sceneConfig?: Partial<StarfieldSceneConfig>;
  gameObjects?: GameObjectBaseConfig[];
  bypassAnimation?: boolean;
  bypassFlash?: boolean;
}

export interface InitializeSceneOptions {
  id?: string;
  sceneConfig?: Partial<StarfieldSceneConfig>;
  gameObjects?: GameObjectBaseConfig[];
}

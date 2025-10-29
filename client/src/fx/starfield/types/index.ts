import type { WarpPhase } from "../constants";
import type { GameObjectInstance } from "./GameObject";

export type StarfieldState = "idle" | "shake" | "warping";

export type GalaxyStarfieldEvents = {
  gameObjectInView: GameObjectInstance;
  gameObjectSelected: GameObjectInstance;
  gameObjectCleared: void;
  warpStart: { willPlayAnimation: boolean };
  warpComplete: number;
  warpCancel: void;
  warpQueue: number;
  sceneIsLoading: void;
  sceneReady: { isInitialRender: boolean; sceneId: string | null };
};

export interface FrameState {
  currentState: StarfieldState;
  currentShakeIntensity: number;
  shakePhase: number;
  cloudsShakeProgress: number;
  warpProgress: number;
  tunnelEffectValue: number;
  warpPhase: WarpPhase;
  cameraRotation: {
    x: number;
    y: number;
    z: number;
  };
}

export interface CachedUniforms {
  shakeIntensity: number;
  warpProgress: number;
  tunnelEffect: number;
  forwardOffset: number;
}

export interface CachedConfig {
  shakeIntensity: number;
  shakeSpeed: number;
  forwardDriftIdle: number;
  forwardDriftShake: number;
  idleSwayRandomSpeed: number;
  idleSwayRandomIntensity: number;
  warpFOVMax: number;
}

export interface PerformanceStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  frameTime: number;
  lastFrameStart: number;
  geometries: number;
  textures: number;
}

export interface SelectionOptions {
  animate?: boolean;
  duration?: number;
  zoom?: boolean;
  focus?: boolean;
  zoomFactor?: number;
  [key: string]: unknown;
}

export interface LookAtOptions {
  duration?: number;
  zoom?: boolean;
  easing?: string;
  zoomFactor?: number;
  onComplete?: () => void;
  [key: string]: unknown;
}

export type {
  GameObjectBaseConfig,
  GameObjectConfig,
  GameObjectInstance,
  GameObjectSpawnRules,
  GameObjectStats,
  GameObjectTypeConfig,
  GameObjectTypes,
  GeometryType,
  ObjectTypeData,
  SelectionResult,
} from "./GameObject";

export type { RGBAColor, RGBColor } from "./color";

export type { InitializeSceneOptions, WarpOptions } from "./Warp";

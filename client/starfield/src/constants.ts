import type { GameObject, PerformanceProfile } from "./types"

export const LAYERS = {
  DEFAULT: 0, // Main scene objects
  SKYBOX: 1, // Nebula
  BACKGROUND: 2, // Skybox (Planet, Shadow)
  FOREGROUND: 3, // Sun, Volumetrics
  GAMEOBJECTS: 4, // GameObjects
  OVERLAY: 5, // Tunnel (rendered after post-processing)
  DEBUG: 31, // Grid, debug helpers
} as const

export const PANEL_ORDERING = {
  SCENE_SETTINGS: -1,
  GAME_OBJECTS: 0,
  RENDERING: 99,
  PERFORMANCE: 99,
}

export const SCENE_TRANSITION_TIMING = {
  // Time to wait at scene change peak for components to settle before starting exit
  SCENE_CHANGE_PEAK_SETTLE_TIME: 500,
  // Time to wait between scenes after a scene change animation completes
  POST_SCENE_CHANGE_PAUSE: 2000,
  // Time to wait between scenes for instant (bypassed) transitions
  POST_SCENE_CHANGE_INSTANT_PAUSE: 500,
  // Time to wait before applying instant (non-animated) scene changes
  PRE_SCENE_CHANGE_INSTANT_DELAY: 800,
  // Cooldown period after scene change where all scenes bypass animation (0 = disabled)
  SCENE_CHANGE_COOLDOWN: 15000,
} as const

export const PERFORMANCE_PROFILES: PerformanceProfile[] = [
  "auto",
  "low",
  "mid",
  "high",
] as const

export const DEFAULT_DPR: Record<PerformanceProfile, number> = {
  auto: 2,
  low: 1,
  mid: 1.5,
  high: 2,
}

export const GAME_OBJECT_TYPES: GameObject["type"][] = [
  "port",
  "ship",
  "garrison",
  "salvage",
]

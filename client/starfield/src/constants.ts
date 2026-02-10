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

export const PERFORMANCE_PROFILES: PerformanceProfile[] = [
  "auto",
  "low",
  "mid",
  "high",
  "extreme",
] as const

export const DEFAULT_DPR: Record<PerformanceProfile, number> = {
  auto: 1,
  low: 0.5,
  mid: 1,
  high: 1.5,
  extreme: 1.5,
}

export const GAME_OBJECT_TYPES: GameObject["type"][] = [
  "port",
  "ship",
  "garrison",
  "salvage",
]

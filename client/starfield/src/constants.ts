export const LAYERS = {
  DEFAULT: 0, // Main scene objects
  SKYBOX: 1, // Nebula
  BACKGROUND: 2, // Skybox (Planet, Shadow)
  FOREGROUND: 3, // Sun, Volumentrics
  GAMEOBJECTS: 4, // GameObjects
  DEBUG: 31, // Grid, debug helpers
} as const

export const PANEL_ORDERING = {
  SCENE_SETTINGS: -1,
  RENDERING: 99,
  TRIGGERS: -1,
  PERFORMANCE: 99,
}

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

export const SCENE_TRANSITION_TIMING = {
  // Time to wait at warp peak for components to settle before starting exit
  WARP_PEAK_SETTLE_TIME: 500,
  // Time to wait between scenes after a warp animation completes
  POST_WARP_PAUSE: 2000,
  // Time to wait between scenes for instant (bypassed) transitions
  POST_INSTANT_PAUSE: 2000,
} as const

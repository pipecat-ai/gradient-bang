import * as THREE from "three"

export interface StarfieldConfig {
  useASCIIRenderer: boolean
  cameraBaseFov: number
  hyperspaceEnterTime?: number
  hyperspaceExitTime?: number
  hyperspaceDuration?: number
  hyperspaceCooldown?: number
  hyerpspaceUniforms: {
    vignetteAmount: number
    vignetteOffset: number
    cameraFov: number
    bloomIntensity: number
    bloomRadius: number
  }
  shakeIntensity?: number
  shakeRelaxTime?: number
  layerDimDuration?: number
  shockwave: {
    shockwaveEnabled?: boolean
    shockwaveSpeed?: number
    shockwaveMaxRadius?: number
    shockwaveWaveSize?: number
    shockwaveAmplitude?: number
    shockwaveDistance?: number
  }
  dithering: {
    ditheringEnabled: true
    ditheringGridSize?: number
    ditheringPixelSizeRatio?: number
    ditheringGrayscaleOnly?: boolean
  }
  sharpening: {
    sharpeningEnabled?: boolean
    sharpeningIntensity?: number
    sharpeningRadius?: number
    sharpeningThreshold?: number
  }
  vignette: {
    vignetteEnabled?: boolean
    vignetteOffset?: number
    vignetteDarkness?: number
  }
  scanlines: {
    scanlinesEnabled?: boolean
    scanlinesIntensity?: number
    scanlinesFrequency?: number
  }
  stars?: {
    enabled?: boolean
    radius?: number
    depth?: number
    count?: number
    factor?: number
    saturation?: number
    fade?: boolean
    speed?: number
  }
  dust?: {
    enabled?: boolean
  }
  fog?: {
    enabled?: boolean
    color?: string
    near?: number
    far?: number
  }
  planet?: {
    enabled?: boolean
    imageIndex?: number
    scale?: number
    opacity?: number
    position?: { x: number; y: number }
    shadowEnabled?: boolean
    shadowRadius?: number
    shadowOpacity?: number
    shadowFalloff?: number
    shadowColor?: string
  }
  grading: {
    enabled?: boolean
    brightness?: number
    contrast?: number
    saturation?: number
    tintEnabled?: boolean
    tintIntensity?: number
    tintContrast?: number
    tintColorPrimary?: string
    tintColorSecondary?: string
  }
  nebula?: Partial<NebulaConfig>
}

export type PerformanceProfile = "low" | "mid" | "high"

export type StarfieldState =
  | "idle"
  | "entering_hyperspace"
  | "in_hyperspace"
  | "exiting_hyperspace"
  | "combat"

/**
 * Represents a game object in the scene
 */
export interface GameObject {
  id: string
  type?: string
}

/**
 * Represents a positioned game object in 3D space
 */
export interface PositionedGameObject extends GameObject {
  position: [number, number, number]
}

/**
 * Configuration for game object bounds
 */
export interface GameObjectBounds {
  x: [number, number]
  y: [number, number]
  z: [number, number]
}

/**
 * Configuration for game object positioning
 */
export interface GameObjectConfig {
  bounds: GameObjectBounds
  minDistance: number
  maxAttempts?: number
}

/**
 * Base interface for world objects that can be configured asynchronously
 */
export interface WorldObject<T = unknown> {
  /**
   * Load a new configuration for this object
   * @param config - Partial configuration to apply
   * @returns Promise that resolves when the object is ready with the new config
   */
  loadConfig(config: Partial<T>): Promise<void>
}

/**
 * Configuration for Nebula object
 */
export interface NebulaConfig {
  enabled: boolean
  noiseResolution: number
  intensity: number
  speed: number
  color: THREE.Color
  primaryColor: THREE.Color
  secondaryColor: THREE.Color
  domainScale: number
  iterPrimary: number
  iterSecondary: number
  parallaxAmount: number
  noiseUse: number
}
/**
 * Configuration for Stars object
 */
export interface StarsConfig {
  enabled: boolean
  count: number
  radius: number
  size: number
  color: string
  fogEnabled: boolean
  fogNear: number
  fogFar: number
  fogColor: string
}

/**
 * Configuration for Skybox object
 */
export interface SkyboxConfig {
  enabled: boolean
  imageUrl: string
  count: number
  distance: number
  minScale: number
  maxScale: number
  horizontalSpread: number
  verticalSpread: number
}

/**
 * Scene configuration with nested object configs
 */
export interface SceneConfig {
  nebula?: Partial<NebulaConfig>
  stars?: Partial<StarsConfig>
  skybox?: Partial<SkyboxConfig>
}

/**
 * Overarching scene configuration
 */
export interface Scene {
  id: string
  gameObjects: GameObject[]
  config: SceneConfig
}

export interface NebulaPalette {
  name: string
  c1: string // hex color
  c2: string // hex color
}

export const NEBULA_PALETTES: readonly NebulaPalette[] = [
  {
    name: "tealOrange",
    c1: "#1aa6b3", // Teal
    c2: "#fa9433", // Orange
  },
  {
    name: "magentaGreen",
    c1: "#bf26bf", // Magenta
    c2: "#33d973", // Green
  },
  {
    name: "blueGold",
    c1: "#2659f2", // Blue
    c2: "#f2c740", // Gold
  },
  {
    name: "cyanRed",
    c1: "#1ad9e6", // Cyan
    c2: "#e63340", // Red
  },
  {
    name: "violetAmber",
    c1: "#8c40d9", // Violet
    c2: "#fab333", // Amber
  },
  {
    name: "emeraldRose",
    c1: "#1abf80", // Emerald
    c2: "#f27399", // Rose
  },
  {
    name: "indigoPeach",
    c1: "#3340b3", // Indigo
    c2: "#ffb38c", // Peach
  },
  {
    name: "mintCoral",
    c1: "#80f2cc", // Mint
    c2: "#ff7373", // Coral
  },
] as const

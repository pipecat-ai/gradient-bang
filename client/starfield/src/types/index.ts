export interface StarfieldConfig {
  cameraBaseFov: number
  vignetteAmount: number
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
  shockwaveSpeed?: number
  shockwaveEnabled?: boolean
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
  }
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
  primaryColor: string
  secondaryColor: string
  globalColor: string
  domainScale: number
  iterPrimary: number
  iterSecondary: number
  parallaxAmount: number
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

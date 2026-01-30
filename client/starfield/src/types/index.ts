import * as THREE from "three"

export interface StarfieldConfig {
  palette?: string
  imageAssets?: string[]
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
  exposureDuration?: number
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
    size?: number
    count?: number
    factor?: number
    saturation?: number
    fade?: boolean
    speed?: number
  }
  dust?: Partial<DustConfig>
  fog?: Partial<FogConfig>
  planet?: Partial<PlanetConfig>
  sun?: Partial<SunConfig>
  grading: Partial<GradingConfig>
  nebula?: Partial<NebulaConfig>
  milkyWay?: Partial<MilkyWayConfig>
  tunnel?: Partial<TunnelConfig>
  volumetricClouds?: Partial<VolumetricCloudsConfig>
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
export type GameObjectType = "port" | "ship" | "planet" | "garrison" | "salvage"
export interface GameObject {
  id: string
  type?: GameObjectType
  scale?: number
  opacity?: number
  enabled?: boolean
  label?: string
  meta?: Record<string, unknown>
}

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
  intensity: number
  color: THREE.Color
  primaryColor: THREE.Color
  secondaryColor: THREE.Color
  domainScale: number
  iterPrimary: number
  iterSecondary: number
  seed1: number
  seed2: number
  seed3: number
  rotation: [number, number, number]
  warpDecay: number
}

/**
 * Configuration for MilkyWay object
 */
export interface MilkyWayConfig {
  enabled: boolean
  intensity: number
  // Galaxy axis
  axisX: number
  axisY: number
  axisZ: number
  // Band
  bandColor: THREE.Color
  bandWidth: number
  bandFalloff: number
  bandCoverage: number
  bandCoverageFalloff: number
  bandRotation: number
  // Core
  coreColor: THREE.Color
  coreWidth: number
  coreIntensity: number
  coreFalloff: number
  // Distortion
  distortionAmount: number
  distortionScale: number
}

/**
 * Configuration for Tunnel object
 */
export interface TunnelConfig {
  enabled: boolean
  showDuringWarp: boolean
  speed: number
  rotationSpeed: number
  tunnelDepth: number
  color: THREE.Color
  whiteoutPeriod: number
  enableWhiteout: boolean
  blendMode: "additive" | "normal" | "multiply" | "screen"
  noiseAnimationSpeed: number
  opacity: number
  contrast: number
  centerHole: number
  centerSoftness: number
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
 * Configuration for Planet object
 */
export interface PlanetConfig {
  enabled: boolean
  imageIndex: number
  scale: number
  opacity: number
  position: { x: number; y: number }
  tintColor: string
  tintIntensity: number
  shadowEnabled: boolean
  shadowRadius: number
  shadowOpacity: number
  shadowFalloff: number
  shadowColor: string
}

/**
 * Configuration for VolumetricClouds object
 */
export interface VolumetricCloudsConfig {
  enabled: boolean
  count: number
  radius: number
  size: number
  opacity: number
  color: string
  blendMode: "additive" | "normal"
  minDistance: number
  fadeRange: number
}

/**
 * Configuration for Sun object
 */
export interface SunConfig {
  enabled: boolean
  position: { x: number; y: number; z: number }
  scale: number
  intensity: number
  color: string
  coronaColor: string
}

/**
 * Configuration for color grading and post-processing effects
 */
export interface GradingConfig {
  enabled: boolean
  brightness: number
  contrast: number
  saturation: number
  tintEnabled: boolean
  tintIntensity: number
  tintContrast: number
  tintColorPrimary: string
  tintColorSecondary: string
}

/**
 * Configuration for Dust particles
 */
export interface DustConfig {
  enabled: boolean
  opacity: number
  count: number
  radius: number
  size: number
  minDistance: number
  fadeRange: number
}

/**
 * Configuration for Fog effect
 */
export interface FogConfig {
  enabled: boolean
  color: string
  near: number
  far: number
}

/**
 * Scene configuration with nested object configs
 */
export interface SceneConfig {
  palette?: string
  nebula?: Partial<NebulaConfig>
  milkyWay?: Partial<MilkyWayConfig>
  stars?: Partial<StarsConfig>
  skybox?: Partial<SkyboxConfig>
  planet?: Partial<PlanetConfig>
  tunnel?: Partial<TunnelConfig>
  volumetricClouds?: Partial<VolumetricCloudsConfig>
  sun?: Partial<SunConfig>
  grading?: Partial<GradingConfig>
  dust?: Partial<DustConfig>
  fog?: Partial<FogConfig>
}

/**
 * Overarching scene configuration
 */
export interface Scene {
  id: string
  gameObjects: GameObject[]
  config: SceneConfig
}

/**
 * Options for scene changes
 */
export interface SceneChangeOptions {
  bypassAnimation?: boolean
}

/**
 * Scene with options for queue processing
 */
export interface QueuedScene {
  scene: Scene
  options?: SceneChangeOptions
}

import * as THREE from "three"

export interface ImageAsset {
  type: "skybox" | "port" | "ship" | "planet" | string
  url: string
}

/**
 * Configuration for Shockwave effect
 */
export interface ShockwaveConfig {
  enabled: boolean
  speed: number
  maxRadius: number
  waveSize: number
  amplitude: number
  distance: number
}

/**
 * Configuration for Dithering effect
 */
export interface DitheringConfig {
  enabled: boolean
  gridSize: number
  pixelSizeRatio: number
  grayscaleOnly: boolean
}

/**
 * Configuration for Sharpening effect
 */
export interface SharpeningConfig {
  enabled: boolean
  intensity: number
  radius: number
  threshold: number
}

/**
 * Configuration for Exposure effect
 */
export interface ExposureConfig {
  enabled: boolean
  startAmount: number
}

export interface StarfieldConfig {
  palette?: string
  imageAssets?: ImageAsset[]
  cameraBaseFov: number
  hyperspaceEnterTime?: number
  hyperspaceExitTime?: number
  hyperspaceDuration?: number
  hyperspaceCooldown?: number
  hyperspaceFovShift?: number
  shakeIntensity?: number
  shakeRelaxTime?: number
  layerDimDuration?: number
  exposureDuration?: number
  shockwave?: Partial<ShockwaveConfig>
  dithering?: Partial<DitheringConfig>
  sharpening?: Partial<SharpeningConfig>
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
  exposure?: Partial<ExposureConfig>
  dust?: Partial<DustConfig>
  fog?: Partial<FogConfig>
  planet?: Partial<PlanetConfig>
  sun?: Partial<SunConfig>
  grading?: Partial<GradingConfig>
  nebula?: Partial<NebulaConfig>
  tunnel?: Partial<TunnelConfig>
  volumetricClouds?: Partial<VolumetricCloudsConfig>
  galaxy?: Partial<GalaxyConfig>
  lensFlare?: Partial<LensFlareConfig>
}

export type PerformanceProfile = "auto" | "low" | "mid" | "high"

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
  rotationX: number
  rotationY: number
  rotationZ: number
  warpDecay: number
  warpOffsetX: number
  warpOffsetY: number
  warpOffsetZ: number
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
  pixelation: number
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
 * Configuration for Galaxy object
 */
export interface GalaxyConfig {
  enabled: boolean
  intensity?: number
  spread?: number // Controls width of galaxy band (higher = wider)
  rotation?: number
  offsetX?: number // Horizontal position: -1 to +1 maps to -180° to +180°
  offsetY?: number // Vertical position: -1 to +1 maps to -90° to +90°
  octaves?: number // FBM octaves (1-5), controls detail vs performance
}

/**
 * Configuration for LensFlare object
 */
export interface LensFlareConfig {
  enabled: boolean
  intensity?: number
  ghostIntensity?: number // Intensity of ghost reflections
  haloIntensity?: number // Intensity of halo rings
  streakIntensity?: number // Intensity of streak artifacts
  quality?: number // 0 = low (halos only), 1 = medium (+ghosts/streaks), 2 = high (all)
  lightX?: number // Light source X position (-1 to 1)
  lightY?: number // Light source Y position (-1 to 1)
  trackGalaxy?: boolean // Whether to track the Galaxy object position
}

/**
 * Scene configuration with nested object configs
 */
export interface SceneConfig {
  palette?: string
  galaxy?: Partial<GalaxyConfig>
  nebula?: Partial<NebulaConfig>
  stars?: Partial<StarsConfig>
  skybox?: Partial<SkyboxConfig>
  planet?: Partial<PlanetConfig>
  tunnel?: Partial<TunnelConfig>
  volumetricClouds?: Partial<VolumetricCloudsConfig>
  grading?: Partial<GradingConfig>
  dust?: Partial<DustConfig>
  fog?: Partial<FogConfig>
  lensFlare?: Partial<LensFlareConfig>
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

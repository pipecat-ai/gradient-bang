import { images } from "@/assets";
import * as THREE from "three";
import {
  type GameObjectSpawnRules,
  type GameObjectTypes,
  type RGBColor,
} from "./types";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Nebula color palette definition */
export interface NebulaPalette {
  name: string;
  c1: RGBColor;
  c2: RGBColor;
  mid: RGBColor;
}

/** Blend mode options (simplified to use Three.js constants directly) */
export type BlendMode = THREE.Blending;

/** Warp animation phases */
export type WarpPhase =
  | "IDLE"
  | "CHARGING"
  | "BUILDUP"
  | "CLIMAX"
  | "FLASH"
  | "COOLDOWN";

/** Star LOD layer configuration */
export interface StarLODLayer {
  enabled: boolean;
  count: number;
  minDistance: number;
  maxDistance: number;
  baseSize: number;
  twinkleIntensity: number;
  twinkleSpeed: number;
  colorVariation: boolean;
  motionBlur: boolean;
}

/** Complete star LOD system configuration */
export interface StarLODConfig {
  hero: StarLODLayer;
  mid: StarLODLayer;
  far: StarLODLayer;
}

/** Debug game object counts */
export interface DebugGameObjectCounts {
  playerShip: number;
  port: number;
  npc: number;
}

/**
 * Scene-specific configuration (properties that vary per scene)
 * This is a lightweight subset used for scene transitions via warpToSector
 * All properties are optional - missing properties get random defaults
 */
export interface StarfieldSceneConfig {
  // Nebula variant (colors, intensity, visual properties)
  nebulaColor1?: RGBColor;
  nebulaColor2?: RGBColor;
  nebulaColorMid?: RGBColor;
  nebulaIntensity?: number;
  nebulaDarkLaneStrength?: number;
  nebulaDomainWarpStrength?: number;
  nebulaIdleNoiseSpeed?: number;
  nebulaAnisotropy?: number;
  nebulaFilamentContrast?: number;

  // Clouds variant (colors, iteration counts, visual properties)
  cloudsIntensity?: number;
  cloudsColorPrimary?: RGBColor;
  cloudsColorSecondary?: RGBColor;
  cloudsIterPrimary?: number;
  cloudsIterSecondary?: number;
  cloudsDomainScale?: number;
  cloudsSpeed?: number;

  // Planet variant (image, position, scale)
  planetImageUrl?: string;
  planetImageIndex?: number;
  planetScale?: number;
  planetPositionX?: number;
  planetPositionY?: number;

  // Star size variant (slight variation per sector)
  starSize?: number;
}

/** Main galaxy starfield configuration interface */
export interface GalaxyStarfieldConfig {
  // === STARFIELD SETTINGS ===
  starSize: number;
  starMinDistance: number;
  starMaxDistance: number;
  motionBlurIntensity: number;

  // === STAR LOD SYSTEM ===
  starLOD: StarLODConfig;

  // === FOG & ATMOSPHERE ===
  fogNear: number;
  fogFar: number;
  fogDensity: number;
  nearFadeEndMultiplier: number;

  // === CAMERA SWAY ===
  cameraSwayIntensity: number;
  cameraSwaySpeed: number;
  cameraSwayEnabled: boolean;
  cameraZoomFactor: number;

  shakeIntensity: number;
  shakeSpeed: number;
  shakeAmplitude: number;
  shakeTransitionTimeSec: number;

  // === WARP EFFECT ===
  warpDurationSec: number;
  warpFOVMax: number;
  warpCooldownSec: number;
  queueProcessingDelaySec: number;

  // === NEBULA SETTINGS ===
  nebulaEnabled: boolean;
  nebulaColor1: RGBColor;
  nebulaColor2: RGBColor;
  nebulaColorMid: RGBColor;
  nebulaIntensity: number;
  nebulaBlending: BlendMode;
  nebulaIdleNoiseSpeed: number;
  nebulaDriftSpeed: number;
  nebulaAnisotropy: number;
  nebulaDomainWarpStrength: number;
  nebulaFilamentContrast: number;
  nebulaDarkLaneStrength: number;
  nebulaPosterizeLevels: number;
  nebulaDitherAmount: number;
  nebulaPixelateScale: number;

  // === CLOUDS SETTINGS ===
  cloudsEnabled: boolean;
  cloudsIntensity: number;
  cloudsColor: RGBColor;
  cloudsColorPrimary: RGBColor;
  cloudsColorSecondary: RGBColor;
  cloudsSpeed: number;
  cloudsIterPrimary: number;
  cloudsIterSecondary: number;
  cloudsDomainScale: number;
  cloudWarpSpeed: number;
  cloudShakeSpeed: number;
  cloudsShakeWarpIntensity: number;
  cloudsShakeWarpRampTime: number;
  cloudsBlending: BlendMode;
  cloudsParallaxAmount: number;
  cloudsNoiseReduction: number;

  // === PLANET SETTINGS ===
  planetEnabled: boolean;
  planetImageUrl: string;
  planetOpacity: number;
  planetBlendMode: BlendMode;
  planetScale: number;
  planetZ: number;
  planetSpawnRangeX: number;
  planetSpawnRangeY: number;
  planetPositionX: number;
  planetPositionY: number;

  // === PLANET SHADOW SETTINGS ===
  planetShadowEnabled: boolean;
  planetShadowRadius: number;
  planetShadowOpacity: number;
  planetShadowSoftness: number;

  // === TERMINAL EFFECT SETTINGS ===
  terminalEnabled: boolean;
  terminalIntensity: number;
  terminalCellSize: number;
  terminalCharacterDensity: number;
  terminalContrast: number;
  terminalScanlineIntensity: number;
  terminalScanlineFrequency: number;
  terminalScanlinesEnabled: boolean;
  terminalColorPrimary: RGBColor;
  terminalColorSecondary: RGBColor;

  // === SHARPENING EFFECT SETTINGS ===
  sharpenEnabled: boolean;
  sharpenIntensity: number;
  sharpenRadius: number;
  sharpenThreshold: number;

  // === COLOR ADJUSTMENT EFFECT SETTINGS ===
  colorAdjustEnabled: boolean;
  colorAdjustBrightness: number;
  colorAdjustContrast: number;
  colorAdjustSaturation: number;
  colorAdjustGamma: number;
  colorAdjustShadows: RGBColor;
  colorAdjustMidtones: RGBColor;
  colorAdjustHighlights: RGBColor;

  // === GAME OBJECT SETTINGS ===
  gameObjectsEnabled: boolean;
  gameObjectSpawnRules: GameObjectSpawnRules;
  gameObjectTypes: GameObjectTypes;

  // === LAYER DIMMING SETTINGS ===
  layerDimmingEnabled: boolean;
  layerDimOpacity: number;
  layerDimDuration: number;

  // Debug mode settings
  debugMode: boolean;

  // Rendering control
  renderingEnabled: boolean;
  debugGameObjectCounts: DebugGameObjectCounts;
}

// ============================================================================
// NEBULA PALETTES
// ============================================================================
export const NEBULA_PALETTES: readonly NebulaPalette[] = [
  {
    name: "tealOrange",
    c1: { r: 0.1, g: 0.65, b: 0.7 },
    c2: { r: 0.98, g: 0.58, b: 0.2 },
    mid: { r: 0.8, g: 0.75, b: 0.65 },
  },
  {
    name: "magentaGreen",
    c1: { r: 0.75, g: 0.15, b: 0.75 },
    c2: { r: 0.2, g: 0.85, b: 0.45 },
    mid: { r: 0.6, g: 0.55, b: 0.7 },
  },
  {
    name: "blueGold",
    c1: { r: 0.15, g: 0.35, b: 0.95 },
    c2: { r: 0.95, g: 0.78, b: 0.25 },
    mid: { r: 0.7, g: 0.72, b: 0.8 },
  },
  {
    name: "cyanRed",
    c1: { r: 0.1, g: 0.85, b: 0.9 },
    c2: { r: 0.9, g: 0.2, b: 0.25 },
    mid: { r: 0.75, g: 0.65, b: 0.7 },
  },
  {
    name: "violetAmber",
    c1: { r: 0.55, g: 0.25, b: 0.85 },
    c2: { r: 0.98, g: 0.7, b: 0.2 },
    mid: { r: 0.8, g: 0.7, b: 0.85 },
  },
  {
    name: "emeraldRose",
    c1: { r: 0.1, g: 0.75, b: 0.5 },
    c2: { r: 0.95, g: 0.45, b: 0.6 },
    mid: { r: 0.7, g: 0.75, b: 0.75 },
  },
  {
    name: "indigoPeach",
    c1: { r: 0.2, g: 0.25, b: 0.7 },
    c2: { r: 1.0, g: 0.7, b: 0.55 },
    mid: { r: 0.75, g: 0.7, b: 0.8 },
  },
  {
    name: "mintCoral",
    c1: { r: 0.5, g: 0.95, b: 0.8 },
    c2: { r: 1.0, g: 0.45, b: 0.45 },
    mid: { r: 0.85, g: 0.8, b: 0.8 },
  },
] as const;

// Random nebula palette selection
export const RAND_NEB: NebulaPalette =
  NEBULA_PALETTES[Math.floor(Math.random() * NEBULA_PALETTES.length)];

// ============================================================================
// PLANET IMAGES
// ============================================================================
export const PLANET_IMAGES: readonly string[] = [
  images.skybox1,
  images.skybox2,
  images.skybox3,
  images.skybox4,
  images.skybox5,
  images.skybox6,
  images.skybox7,
  images.skybox8,
  images.skybox9,
] as const;

// ============================================================================
// CONFIGURATION
// ============================================================================

export const DEFAULT_GALAXY_CONFIG: GalaxyStarfieldConfig = {
  // === STARFIELD SETTINGS ===
  starSize: 1, // Base star size multiplier
  starMinDistance: 60, // Minimum distance from camera
  starMaxDistance: 1000, // Maximum distance from camera (updated to match far LOD layer)
  motionBlurIntensity: 1.0, // Intensity of motion blur effect during warp (0-1)

  // === STAR LOD SYSTEM ===
  starLOD: {
    hero: {
      enabled: true, // Enable/disable hero star layer
      count: 1000, // Number of high-quality hero stars
      minDistance: 20, // Closer minimum for immediate foreground
      maxDistance: 400, // Much deeper to handle camera forward movement
      baseSize: 1.0,
      twinkleIntensity: 0.25,
      twinkleSpeed: 0.5, // Slower twinkling for close stars
      colorVariation: true,
      motionBlur: true,
    },
    mid: {
      enabled: true, // Enable/disable mid star layer
      count: 5000, // Number of medium-quality mid stars
      minDistance: 400, // Seamless transition from hero
      maxDistance: 1200, // Extended range to cover more background area
      baseSize: 0.6, // Base size multiplier for mid stars
      twinkleIntensity: 0.8,
      twinkleSpeed: 1.5, // Medium twinkling speed for mid-distance stars
      colorVariation: true,
      motionBlur: false,
    },
    far: {
      enabled: false, // Enable/disable far star layer (often redundant - try with just 2 layers)
      count: 12000, // Number of low-quality far stars
      minDistance: 500, // Deep background starts here
      maxDistance: 1000, // Very deep background for exploration
      baseSize: 0.4, // Base size multiplier for far stars
      twinkleIntensity: 0.0,
      twinkleSpeed: 2.0, // Faster twinkling for distant stars (when enabled)
      colorVariation: false,
      motionBlur: false,
    },
  },

  // === FOG & ATMOSPHERE ===
  fogNear: 800, // Fog start distance (after mid stars begin to preserve visibility)
  fogFar: 1500, // Fog end distance (well beyond far stars for proper fade)
  fogDensity: 0.000001, // Exponential fog density
  nearFadeEndMultiplier: 2, // Multiplier for star near-fade distance

  // === CAMERA SWAY ===
  cameraSwayIntensity: 2, // Spaceship sway intensity (0-2)
  cameraSwaySpeed: 0.15, // Sway animation speed multiplier (slower = smoother)
  cameraSwayEnabled: true, // Enable/disable camera sway
  cameraZoomFactor: 0.5, // How much to zoom toward selected objects (0.1-0.5)

  shakeIntensity: 0.5, // Intensity of camera shake effect
  shakeSpeed: 0.1, // Speed of shake animation
  shakeAmplitude: 0.02, // Amplitude for image/pixel wobble during shake
  shakeTransitionTimeSec: 0.5, // Time to fade between idle and shake

  // === WARP EFFECT ===
  warpDurationSec: 3, // Warp sequence duration in seconds
  warpFOVMax: 140, // Maximum FOV during warp effect
  warpCooldownSec: 10, // Cooldown period after warp animation before next animation can play
  queueProcessingDelaySec: 1, // Delay between processing queued warp requests (fast sequential loading)

  // === NEBULA SETTINGS ===
  nebulaEnabled: true, // Enable/disable nebula rendering
  nebulaColor1: RAND_NEB.c1, // Primary nebula color (randomized)
  nebulaColor2: RAND_NEB.c2, // Secondary nebula color (randomized)
  nebulaColorMid: RAND_NEB.mid, // Middle color for 3-point gradient
  nebulaIntensity: Math.random() * 2 + 0.15, // Overall nebula brightness
  nebulaBlending: THREE.AdditiveBlending, // Should be screen
  nebulaIdleNoiseSpeed: 0.25, // Speed of nebula evolution during idle
  nebulaDriftSpeed: 0.000005, // Speed of nebula UV drift
  nebulaAnisotropy: 2.2, // Stretch factor along galactic band (1.0 = circular)
  nebulaDomainWarpStrength: 0.12, // Amount of noise domain warping (0-1)
  nebulaFilamentContrast: 0.65, // Mix amount for ridged filament structures (0-1)
  nebulaDarkLaneStrength: 0.35 + Math.random() * 0.65, // Strength of dark dust lane effect (0-1)
  nebulaPosterizeLevels: 0, // Posterization levels (0 = disabled)
  nebulaDitherAmount: 0, // Dithering amount for retro look (0 = disabled)
  nebulaPixelateScale: 0, // Pixelation scale (0 = disabled)

  // === CLOUDS SETTINGS ===
  cloudsEnabled: true, // Enable/disable background clouds
  cloudsIntensity: 0.22 + Math.random() * 0.65, // Cloud brightness (randomized)
  cloudsColor: { r: 0.9, g: 0.95, b: 1.0 }, // Global cloud tint color
  cloudsColorPrimary: RAND_NEB.c1, // Primary cloud color (matches nebula)
  cloudsColorSecondary: RAND_NEB.c2, // Secondary cloud color (matches nebula)
  cloudsSpeed: 0.0025, // Speed of cloud animation
  cloudsIterPrimary: Math.floor(Math.random() * 20) + 10, // Primary fractal iterations
  cloudsIterSecondary: Math.floor(Math.random() * 10) + 1, // Secondary fractal iterations
  cloudsDomainScale: 0.5 + Math.random() * 0.99, // Domain scaling for cloud noise
  cloudWarpSpeed: 25.0, // Cloud animation speed multiplier during warp
  cloudShakeSpeed: 50.0, // Cloud animation speed multiplier during shake
  cloudsShakeWarpIntensity: 0.03, // Intensity of flow field warping during shake (0-1)
  cloudsShakeWarpRampTime: 5.0, // Time in seconds for shake warping to reach full intensity
  cloudsBlending: THREE.AdditiveBlending, // Blend mode using Three.js constants
  cloudsParallaxAmount: 1, // Parallax effect strength for camera movement (0 = none, 1 = strong)
  cloudsNoiseReduction: 0.3, // Noise threshold for high intensities (0 = none, 0.3 = aggressive)

  // === PLANET SETTINGS ===
  planetEnabled: true, // Enable/disable planet rendering
  planetImageUrl:
    PLANET_IMAGES[Math.floor(Math.random() * PLANET_IMAGES.length)], // Randomly selected planet image
  planetOpacity: 1, // Planet opacity (0-1)
  planetBlendMode: THREE.AdditiveBlending, // Planet blend mode using Three.js constants
  planetScale: Math.random() * 4 + 2, // Planet scale multiplier
  planetZ: -300, // Planet Z position (depth)
  planetSpawnRangeX: 400, // X spawn range (±400 units)
  planetSpawnRangeY: 400, // Y spawn range (±400 units)
  planetPositionX: (Math.random() - 0.5) * 400, // Planet X position (randomized)
  planetPositionY: (Math.random() - 0.5) * 400, // Planet Y position (randomized)

  // === PLANET SHADOW SETTINGS ===
  planetShadowEnabled: true, // Enable/disable shadow masking on clouds and nebula
  planetShadowRadius: 0.05, // Shadow radius multiplier
  planetShadowOpacity: 0.7, // Shadow opacity (0-1)
  planetShadowSoftness: 0.5, // Shadow edge softness (0 = hard, 1 = very soft)

  // === TERMINAL EFFECT SETTINGS ===
  terminalEnabled: true, // Enable/disable terminal pixelation effect
  terminalIntensity: 1, // Terminal effect intensity (0-1)
  terminalCellSize: 4, // Size of terminal cells (pixels)
  terminalCharacterDensity: 0.0, // Density of ASCII characters (0-1)
  terminalContrast: 1.2, // Contrast boost for terminal effect
  terminalScanlineIntensity: 0.3, // Scanline effect intensity (0-1)
  terminalScanlineFrequency: 1.3, // Scanline frequency multiplier
  terminalScanlinesEnabled: true, // Enable/disable scanlines separately
  terminalColorPrimary: { r: 0.0, g: 0.8, b: 0.2 }, // Primary terminal color (green)
  terminalColorSecondary: { r: 1.0, g: 0.8, b: 0.0 }, // Secondary terminal color (amber)

  // === SHARPENING EFFECT SETTINGS ===
  sharpenEnabled: true, // Enable/disable sharpening post-processing effect
  sharpenIntensity: 1, // Sharpening intensity (0-2, higher = more sharp)
  sharpenRadius: 3.0, // Blur radius for unsharp mask (0.5-3, higher = wider sharpening)
  sharpenThreshold: 0.0, // Threshold to avoid sharpening noise (0-0.5, higher = less noise)

  // === COLOR ADJUSTMENT EFFECT SETTINGS ===
  colorAdjustEnabled: true, // Enable/disable color adjustment post-processing effect
  colorAdjustBrightness: 0.0, // Brightness adjustment (-1 to 1)
  colorAdjustContrast: 1.05, // Contrast adjustment (0 to 3, 1 = normal)
  colorAdjustSaturation: 1.2, // Saturation adjustment (0 to 3, 1 = normal)
  colorAdjustGamma: 1.0, // Gamma correction (0.1 to 3, 1 = normal)
  colorAdjustShadows: { r: 1.0, g: 1.0, b: 1.0 }, // Shadows color multiplier
  colorAdjustMidtones: { r: 1.0, g: 1.0, b: 1.0 }, // Midtones color multiplier
  colorAdjustHighlights: { r: 1.0, g: 1.0, b: 1.0 }, // Highlights color multiplier

  // === GAME OBJECT SETTINGS ===
  gameObjectsEnabled: true, // Enable/disable game object rendering

  // Global spawn rules for all game objects
  gameObjectSpawnRules: {
    spawnRange: { x: 200, y: 150, z: 200 }, // Spawn range from player
    minDistance: 50, // Minimum distance from player
    maxDistance: 200, // Maximum distance from player
  },

  // Game object type definitions (geometry, materials, behavior)
  gameObjectTypes: {
    playerShip: {
      rotationSpeed: 0.5, // Rotation speed in radians per second
      scale: 4.0, // Size of the ship
      color: { r: 0.2, g: 0.8, b: 1.0 }, // Blue color for player ships
      geometry: "box", // box, octahedron, sphere, etc.
    },
    port: {
      rotationSpeed: 0.3, // Rotation speed in radians per second
      scale: 4.0, // Size of the starport
      color: { r: 1.0, g: 0.8, b: 0.2 }, // Gold color for starports
      geometry: "octahedron", // Diamond shape
    },
    npc: {
      rotationSpeed: 0.4, // Rotation speed in radians per second
      scale: 2.0, // Size of NPC ships
      color: { r: 0.8, g: 0.2, b: 0.2 }, // Red color for NPCs
      geometry: "box", // Box shape
    },
  },

  // === LAYER DIMMING SETTINGS ===
  layerDimmingEnabled: true,
  layerDimOpacity: 0.4,
  layerDimDuration: 3,

  // === DEBUG ===
  debugMode: false,

  renderingEnabled: true,

  debugGameObjectCounts: {
    playerShip: 1,
    port: 2,
    npc: 5,
  },
};

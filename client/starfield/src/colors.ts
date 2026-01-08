import * as THREE from "three"

/**
 * Starfield color palette defining a cohesive color scheme for the scene
 */
export interface StarfieldPalette {
  name: string
  c1: THREE.Color // Primary color (nebula primary, sun core, tint primary)
  c2: THREE.Color // Secondary color (nebula secondary, sun corona, tint secondary)
  tint: THREE.Color // Global tint color (nebula global tint, effects)
  base: THREE.Color // Dark base color (fog, planet shadow)
  saturation: number // Post-processing saturation adjustment
  contrast: number // Post-processing contrast adjustment
}

/**
 * Collection of predefined color palettes optimized for space scenes
 */
export const STARFIELD_PALETTES: readonly StarfieldPalette[] = [
  {
    name: "celestialBlue",
    c1: new THREE.Color("#4a90e2"), // Soft blue
    c2: new THREE.Color("#e8885d"), // Muted orange
    tint: new THREE.Color("#d4e6f1"), // Very light blue tint
    base: new THREE.Color("#000000"), // Pure black
    saturation: 0.0,
    contrast: 0.15,
  },
  {
    name: "deepSpace",
    c1: new THREE.Color("#5d6d8e"), // Steel blue
    c2: new THREE.Color("#8b6f9e"), // Muted purple
    tint: new THREE.Color("#bdc3d1"), // Pale blue-gray
    base: new THREE.Color("#0a0a14"), // Very dark blue-black
    saturation: -0.1,
    contrast: 0.2,
  },
  {
    name: "nebulaDust",
    c1: new THREE.Color("#7c5e99"), // Dusty purple
    c2: new THREE.Color("#d4847c"), // Dusty rose
    tint: new THREE.Color("#e8d5e5"), // Pale lavender
    base: new THREE.Color("#0d0a0f"), // Dark purple-black
    saturation: 0.1,
    contrast: 0.18,
  },
  {
    name: "cosmicTeal",
    c1: new THREE.Color("#4a8a8f"), // Muted teal
    c2: new THREE.Color("#c89b6f"), // Warm tan
    tint: new THREE.Color("#c7e3e6"), // Pale cyan
    base: new THREE.Color("#0a0e10"), // Dark blue-black
    saturation: 0.3,
    contrast: 0.16,
  },
  {
    name: "stellarGold",
    c1: new THREE.Color("#c4a35a"), // Muted gold
    c2: new THREE.Color("#8b7a99"), // Muted lavender
    tint: new THREE.Color("#f0e8d4"), // Pale cream
    base: new THREE.Color("#0f0d0a"), // Dark warm black
    saturation: 0.08,
    contrast: 0.2,
  },
  {
    name: "terminalGreen",
    c1: new THREE.Color("#5a9e7c"), // Phosphor green
    c2: new THREE.Color("#d4956f"), // Warm copper accent
    tint: new THREE.Color("#c5e8d6"), // Pale green tint
    base: new THREE.Color("#0a120e"), // Dark green-black
    saturation: 0.25,
    contrast: 0.18,
  },
  {
    name: "amberMonitor",
    c1: new THREE.Color("#b8945f"), // Warm amber
    c2: new THREE.Color("#8a9e8e"), // Dusty sage
    tint: new THREE.Color("#e8dcc7"), // Pale amber
    base: new THREE.Color("#100e0a"), // Dark warm black
    saturation: 0.15,
    contrast: 0.17,
  },
  {
    name: "cyberCyan",
    c1: new THREE.Color("#4a9da6"), // Electric teal
    c2: new THREE.Color("#c58a7a"), // Coral accent
    tint: new THREE.Color("#c7e8eb"), // Pale cyan-blue
    base: new THREE.Color("#0a0f12"), // Dark cyan-black
    saturation: 0.35,
    contrast: 0.19,
  },
] as const

/**
 * Get a palette by name, falling back to the default palette if not found
 */
export function getPalette(name?: string): StarfieldPalette {
  if (!name) {
    return STARFIELD_PALETTES[0]
  }

  const palette = STARFIELD_PALETTES.find((p) => p.name === name)
  return palette ?? STARFIELD_PALETTES[0]
}

/**
 * Get all available palette names
 */
export function getPaletteNames(): string[] {
  return STARFIELD_PALETTES.map((p) => p.name)
}

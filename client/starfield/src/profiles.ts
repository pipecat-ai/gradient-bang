import type { StarfieldConfig } from "./types"

export const defaultProfile: StarfieldConfig = {
  cameraBaseFov: 85,
  hyperspaceEnterTime: 2000,
  hyperspaceExitTime: 2000,
  hyperspaceDuration: 1000,
  hyperspaceCooldown: 10000,
  hyerpspaceUniforms: {
    vignetteAmount: 0,
    vignetteOffset: 0,
    cameraFov: 165,
    bloomIntensity: 50,
    bloomRadius: 1,
  },
  shakeIntensity: 1,
  shakeRelaxTime: 1000,
  layerDimDuration: 300,
  shockwave: {
    shockwaveEnabled: true,
    shockwaveSpeed: 1.4,
    shockwaveMaxRadius: 0.45,
    shockwaveWaveSize: 0.25,
    shockwaveAmplitude: 0.1,
    shockwaveDistance: 2.0,
  },
  dithering: {
    ditheringEnabled: true,
    ditheringGridSize: 3,
    ditheringPixelSizeRatio: 1,
    ditheringGrayscaleOnly: false,
  },
  sharpening: {
    sharpeningEnabled: true,
    sharpeningIntensity: 2.0,
    sharpeningRadius: 4.0,
    sharpeningThreshold: 0.0,
  },
  vignette: {
    vignetteEnabled: true,
    vignetteOffset: 0.7,
    vignetteDarkness: 0.3,
  },
  scanlines: {
    scanlinesEnabled: false,
    scanlinesIntensity: 0.3,
    scanlinesFrequency: 1.3,
  },
  stars: {
    enabled: true,
    count: 3000,
    radius: 20,
    depth: 35,
    size: 1.6,
  },
  dust: {
    enabled: true,
    opacity: 0.3,
  },
  fog: {
    enabled: true,
    color: "#000000",
    near: 0,
    far: 80,
  },
  planet: {
    enabled: true,
    imageIndex: 0,
    scale: 100,
    opacity: 1,
    position: { x: 0, y: 0 },
    shadowEnabled: true,
    shadowRadius: 0.7,
    shadowOpacity: 0.9,
    shadowFalloff: 0.7,
    shadowColor: "#000000",
  },
  sun: {
    enabled: true,
    position: { x: 30, y: 30, z: -80 },
    scale: 100,
    intensity: 1,
    color: "#ffe8a3",
    coronaColor: "#ff6b35",
  },
  grading: {
    enabled: true,
    brightness: 0.0,
    contrast: 0.15,
    saturation: 0,
  },
  nebula: {
    enabled: true,
    intensity: 0.5,
    domainScale: 1,
  },
  volumetricClouds: {
    enabled: true,
    count: 500,
    radius: 300,
    size: 40,
    opacity: 0.03,
    color: "#ffffff",
    blendMode: "normal",
    minDistance: 10,
    fadeRange: 3,
  },
  useASCIIRenderer: false,
}

export const lowProfile: Partial<StarfieldConfig> = {
  ...defaultProfile,
  fog: {
    enabled: false,
  },
  dust: {
    enabled: false,
  },
  volumetricClouds: {
    enabled: false,
  },
}

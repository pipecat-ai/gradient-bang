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
    shockwaveSpeed: 1.5,
    shockwaveMaxRadius: 0.8,
    shockwaveWaveSize: 0.25,
    shockwaveAmplitude: 0.15,
    shockwaveDistance: 2.5,
  },
  dithering: {
    ditheringEnabled: true,
    ditheringGridSize: 3,
    ditheringPixelSizeRatio: 1,
    ditheringGrayscaleOnly: false,
  },
  sharpening: {
    sharpeningEnabled: true,
    sharpeningIntensity: 1.0,
    sharpeningRadius: 3.0,
    sharpeningThreshold: 0.0,
  },
  vignette: {
    vignetteEnabled: true,
    vignetteOffset: 0,
    vignetteDarkness: 0.5,
  },
  stars: {
    enabled: true,
  },
  dust: {
    enabled: true,
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
    scale: 50,
    opacity: 1,
    position: { x: 0, y: 0 },
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
}

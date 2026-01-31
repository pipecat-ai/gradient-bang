import type { StarfieldConfig } from "./types"

export const defaultProfile: StarfieldConfig = {
  palette: "cosmicTeal",
  imageAssets: [
    { type: "skybox", url: "/test-skybox-1.png" },
    { type: "skybox", url: "/test-skybox-2.png" },
    { type: "port", url: "/test-port-1.png" },
    { type: "port", url: "/test-port-2.png" },
  ],
  cameraBaseFov: 85,
  hyperspaceEnterTime: 1500,
  hyperspaceExitTime: 1500,
  hyperspaceDuration: 100,
  hyperspaceCooldown: 10000,
  hyerpspaceUniforms: {
    vignetteAmount: 0.5,
    vignetteOffset: 1,
    cameraFov: 165,
    bloomIntensity: 20,
    bloomRadius: 1,
  },
  shakeIntensity: 1,
  shakeRelaxTime: 1000,
  layerDimDuration: 5000,
  shockwave: {
    shockwaveEnabled: true,
    shockwaveSpeed: 1,
    shockwaveMaxRadius: 0.6,
    shockwaveWaveSize: 0.15,
    shockwaveAmplitude: 0.1,
    shockwaveDistance: 4,
  },
  dithering: {
    ditheringEnabled: true,
  },
  sharpening: {
    sharpeningEnabled: true,
  },
  vignette: {
    vignetteEnabled: false,
    vignetteOffset: 0.7,
    vignetteDarkness: 0.3,
  },
  scanlines: {
    scanlinesEnabled: false,
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
  },
  sun: {
    enabled: true,
    position: { x: 30, y: 30, z: -80 },
    scale: 100,
    intensity: 0.5,
  },
  grading: {
    enabled: true,
  },
  nebula: {
    enabled: true,
    intensity: 0.5,
    domainScale: 2,
  },
  volumetricClouds: {
    enabled: true,
    count: 500,
    radius: 300,
    size: 40,
    opacity: 0.03,
    blendMode: "normal",
    minDistance: 10,
    fadeRange: 3,
  },
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

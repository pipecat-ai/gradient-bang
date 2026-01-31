import type { StarfieldConfig } from "./types"

export const defaultProfile: StarfieldConfig = {
  cameraBaseFov: 50,
  palette: "cosmicTeal",
  imageAssets: [
    { type: "skybox", url: "/test-skybox-1.png" },
    { type: "skybox", url: "/test-skybox-2.png" },
    { type: "port", url: "/test-port-1.png" },
    { type: "port", url: "/test-port-2.png" },
    { type: "port", url: "/test-port-3.png" },
  ],
  hyperspaceEnterTime: 1500,
  hyperspaceExitTime: 1500,
  hyperspaceDuration: 100,
  hyperspaceCooldown: 10000,
  hyperspaceFovShift: 120,
  shakeIntensity: 1,
  shakeRelaxTime: 1000,
  layerDimDuration: 5000,
  shockwave: {
    enabled: true,
  },
  dithering: {
    enabled: true,
  },
  sharpening: {
    enabled: true,
  },
  exposure: {
    enabled: true,
    startAmount: -1, // Start faded to black, animations restore to default (0)
  },
  stars: {
    enabled: true,
  },
  dust: {
    enabled: true,
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

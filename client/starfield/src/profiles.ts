import type { PerformanceProfile, StarfieldConfig } from "./types"

// Keys excluded from profile merging (preserve user/scene settings)
export const EXCLUDED_PROFILE_KEYS = [
  "cameraBaseFov",
  "palette",
  "imageAssets",
  "shakeIntensity",
  "shakeRelaxTime",
  "layerDimDuration",
  "hyperspaceEnterTime",
  "hyperspaceExitTime",
  "hyperspaceDuration",
  "hyperspaceCooldown",
  "hyperspaceFovShift",
] as const

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
  hyperspaceFovShift: 100,
  shakeIntensity: 1,
  shakeRelaxTime: 1000,
  layerDimDuration: 5000,
  galaxy: {
    enabled: true,
  },
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
  },
  stars: {
    enabled: true,
    count: 6000,
  },
  dust: {
    enabled: true,
  },
  planet: {
    enabled: true,
  },
  sun: {
    enabled: true,
  },
  grading: {
    enabled: true,
  },
  nebula: {
    enabled: true,
  },
  volumetricClouds: {
    enabled: true,
  },
  tunnel: {
    enabled: true,
  },
  lensFlare: {
    enabled: true,
    quality: 2,
  },
}

export const midProfile: Partial<StarfieldConfig> = {
  ...defaultProfile,
  volumetricClouds: {
    enabled: false,
  },
  shockwave: {
    enabled: false,
  },
  stars: {
    count: 3000,
  },
  tunnel: {
    enabled: false,
    showDuringWarp: false,
  },
  lensFlare: {
    enabled: true,
    quality: 1,
  },
  galaxy: {
    enabled: true,
    octaves: 3,
  },
}

export const lowProfile: Partial<StarfieldConfig> = {
  ...midProfile,
  nebula: {
    enabled: false,
  },
  volumetricClouds: {
    enabled: false,
  },
  shockwave: {
    enabled: false,
  },
  stars: {
    enabled: false,
  },
  sun: {
    enabled: false,
  },
  tunnel: {
    enabled: false,
    showDuringWarp: false,
  },
  galaxy: {
    enabled: false,
  },
  lensFlare: {
    enabled: false,
  },
}

export const PROFILE_MAP: Record<
  PerformanceProfile,
  Partial<StarfieldConfig>
> = {
  low: lowProfile,
  mid: midProfile,
  auto: defaultProfile,
  high: defaultProfile,
}

import type { StarfieldConfig } from "./types"

export const defaultProfile: StarfieldConfig = {
  cameraBaseFov: 85,
  vignetteAmount: 0.5,
  hyperspaceEnterTime: 2000,
  hyperspaceExitTime: 2000,
  hyperspaceDuration: 1000,
  hyperspaceCooldown: 10000,
  hyerpspaceUniforms: {
    vignetteAmount: 1,
    vignetteOffset: 0,
    cameraFov: 165,
    bloomIntensity: 50,
    bloomRadius: 1,
  },
  shakeIntensity: 1,
  shakeRelaxTime: 1000,
  shockwaveSpeed: 1.5,
  shockwaveEnabled: true,
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

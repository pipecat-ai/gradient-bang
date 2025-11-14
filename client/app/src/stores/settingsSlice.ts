import { produce } from "immer"
import { type StateCreator } from "zustand"

import { getLocalSettings, setLocalSettings } from "@/utils/settings"

export interface SettingsSlice {
  settings: {
    useDevTools: boolean
    ambienceVolume: number
    disabledAmbience: boolean
    disabledSoundFX: boolean
    disableMusic: boolean
    disableRemoteAudio: boolean
    enableMic: boolean
    musicVolume: number
    remoteAudioVolume: number
    renderStarfield: boolean
    soundFXVolume: number
    startMuted: boolean
    fxBypassFlash: boolean
    fxBypassAnimation: boolean
    qualityPreset: "text" | "low" | "high" | "auto"
    saveSettings: boolean
    showMobileWarning: boolean
    bypassAssetCache: boolean
  }
  setSettings: (settings: SettingsSlice["settings"]) => void
}

const defaultSettings = {
  useDevTools: true,
  ambienceVolume: 0.5,
  disabledAmbience: false,
  disabledSoundFX: false,
  disableMusic: false,
  disableRemoteAudio: false,
  enableMic: true,
  musicVolume: 0.5,
  remoteAudioVolume: 1,
  renderStarfield: true,
  soundFXVolume: 0.5,
  startMuted: false,
  fxBypassFlash: false,
  fxBypassAnimation: false,
  qualityPreset: "high" as const,
  saveSettings: true,
  showMobileWarning: true,
  bypassAssetCache: false,
}

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  settings: {
    ...defaultSettings,
    ...getLocalSettings(),
  },
  setSettings: (settings: SettingsSlice["settings"]) => {
    setLocalSettings(settings)
    set(
      produce((state) => {
        state.settings = settings
      })
    )
  },
})

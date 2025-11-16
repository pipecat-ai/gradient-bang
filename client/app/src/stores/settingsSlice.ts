import { produce } from "immer"
import { type StateCreator } from "zustand"
import { type APIRequest } from "@pipecat-ai/client-js"

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

  botConfig: {
    startBotParams: APIRequest
    transportType: "smallwebrtc" | "daily"
  }
  setBotConfig: (
    startBotParams: APIRequest,
    transportType: "smallwebrtc" | "daily"
  ) => void
  getBotStartParams: (characterId: string) => APIRequest
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

export const createSettingsSlice: StateCreator<SettingsSlice> = (set, get) => ({
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
  botConfig: {
    startBotParams: {
      endpoint: "",
      requestData: {},
    },
    transportType: "smallwebrtc",
  },
  setBotConfig: (
    startBotParams: APIRequest,
    transportType: "smallwebrtc" | "daily"
  ) => {
    set(
      produce((state) => {
        state.botConfig = {
          startBotParams,
          transportType,
        }
      })
    )
  },
  getBotStartParams: (characterId: string): APIRequest => {
    const params = get().botConfig.startBotParams
    const transportType = get().botConfig.transportType
    const requestData = {
      ...(transportType === "daily"
        ? {
            createDailyRoom: true,
            dailyRoomProperties: {
              start_video_off: true,
              eject_at_room_exp: true,
            },
          }
        : { createDailyRoom: false, enableDefaultIceServers: true }),
    }
    return {
      endpoint: params.endpoint,
      requestData: {
        ...requestData,
        body: {
          character_id: characterId,
        },
      },
    }
  },
})

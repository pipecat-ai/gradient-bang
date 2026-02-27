import { produce } from "immer"
import { type StateCreator } from "zustand"
import type { PerformanceProfile } from "@gradient-bang/starfield"
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
    qualityPreset: PerformanceProfile
    saveSettings: boolean
    bypassAssetCache: boolean
    bypassTitle: boolean
    defaultUIMode: UIMode
  }
  setSettings: (settings: SettingsSlice["settings"]) => void

  botConfig: {
    startBotParams: APIRequest
    transportType: "smallwebrtc" | "daily"
  }
  setBotConfig: (startBotParams: APIRequest, transportType: "smallwebrtc" | "daily") => void
  getBotStartParams: (characterId?: string, accessToken?: string) => APIRequest
}

const defaultSettings = {
  useDevTools: false,
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
  qualityPreset: "auto",
  saveSettings: true,
  bypassAssetCache: false,
  bypassTitle: false,
  defaultUIMode: "tasks",
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
  setBotConfig: (startBotParams: APIRequest, transportType: "smallwebrtc" | "daily") => {
    set(
      produce((state) => {
        state.botConfig = {
          startBotParams,
          transportType,
        }
      })
    )
  },
  getBotStartParams: (characterId?: string, accessToken?: string): APIRequest => {
    const params = get().botConfig.startBotParams
    const transportType = get().botConfig.transportType
    const requestData = {
      ...(transportType === "daily" ?
        {
          createDailyRoom: true,
          dailyRoomProperties: {
            start_video_off: true,
            eject_at_room_exp: true,
          },
        }
      : {
          createDailyRoom: false,
          enableDefaultIceServers: true,
        }),
      ...(characterId && { body: { character_id: characterId } }),
    }

    return {
      endpoint: params.endpoint,
      requestData: {
        ...requestData,
      },
      headers: new Headers({
        Authorization: `Bearer ${accessToken}`,
      }),
    }
  },
})

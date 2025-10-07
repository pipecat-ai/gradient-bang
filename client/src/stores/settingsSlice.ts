import { type StateCreator } from "zustand";

import { getLocalSettings } from "@/utils/settings";

export interface SettingsSlice {
  settings: {
    ambienceVolume: number;
    disabledAmbience: boolean;
    disabledSoundFX: boolean;
    disableMusic: boolean;
    disableRemoteAudio: boolean;
    enableMic: boolean;
    musicVolume: number;
    remoteAudioVolume: number;
    renderStarfield: boolean;
    soundFXVolume: number;
    startMuted: boolean;
    qualityPreset: "text" | "low" | "high";
    saveSettings: boolean;
  };
}

const defaultSettings = {
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
  qualityPreset: "high" as const,
  saveSettings: true,
};

export const createSettingsSlice: StateCreator<SettingsSlice> = () => ({
  settings: {
    ...defaultSettings,
    ...getLocalSettings(),
  },
});

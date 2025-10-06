import { type StateCreator } from "zustand";
import LocalSettings from "../settings.json";

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
};

export const createSettingsSlice: StateCreator<SettingsSlice> = () => ({
  settings: {
    ...defaultSettings,
    ...LocalSettings,
  },
});

// stores/settingsSlice.ts
import { type StateCreator } from "zustand";
import settings from "../settings.json";

export interface SettingsSlice {
  settings: {
    startMuted: boolean;
    enableMic: boolean;
    disabledSounds: boolean;
    disableAudioOutput: boolean;
    renderStarfield: boolean;
    debugMode: boolean;
    qualityPreset: "text" | "low" | "medium" | "high";
  };
}

export const createSettingsSlice: StateCreator<SettingsSlice> = () => ({
  settings: {
    ...settings,
    qualityPreset: settings.qualityPreset as "text" | "low" | "medium" | "high",
  },
});

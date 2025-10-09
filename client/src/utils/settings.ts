import Settings from "@/settings.json";
import type { SettingsSlice } from "@/stores/settingsSlice";

export function getLocalSettings() {
  console.debug("[GAME SETTINGS] Getting local settings", Settings);

  // Check if we have a settings blob in local storage
  const localSettings = localStorage.getItem("gb-settings");
  if (localSettings) {
    console.debug("[GAME SETTINGS] Found local settings", localSettings);
    // Merge with default settings
    // json file overrides take priority
    return {
      ...JSON.parse(localSettings),
      ...Settings,
    };
  }

  return Settings;
}

export function setLocalSettings(settings: SettingsSlice["settings"]) {
  if (!settings.saveSettings) {
    removeLocalSettings();
    return;
  }

  console.debug("[GAME SETTINGS] Setting local settings", settings);
  localStorage.setItem("gb-settings", JSON.stringify(settings));
}

export function removeLocalSettings() {
  localStorage.removeItem("gb-settings");
}

import Settings from "@/settings.json"
import type { SettingsSlice } from "@/stores/settingsSlice"

export function getLocalSettings() {
  const localSettings = localStorage.getItem("gb-settings")
  if (localSettings) {
    const s = JSON.parse(localSettings)
    return {
      ...s,
      ...Settings,
    }
  }

  return Settings
}

export function setLocalSettings(settings: SettingsSlice["settings"]) {
  if (!settings.saveSettings) {
    removeLocalSettings()
    return
  }

  console.debug("[GAME SETTINGS] Setting local settings", settings)
  localStorage.setItem("gb-settings", JSON.stringify(settings))
}

export function updateLocalSettings(settings: Partial<SettingsSlice["settings"]>) {
  const localSettings = getLocalSettings()
  setLocalSettings({
    ...localSettings,
    ...settings,
  })
}

export function removeLocalSettings() {
  localStorage.removeItem("gb-settings")
}

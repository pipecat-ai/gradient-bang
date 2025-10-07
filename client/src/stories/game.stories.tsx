import MiniMap from "@/hud/MiniMap";
import useGameStore from "@/stores/game";
import type { SettingsSlice } from "@/stores/settingsSlice";
import { removeLocalSettings, setLocalSettings } from "@/utils/settings";
import type { Story } from "@ladle/react";
import { useEffect, useState } from "react";

export const Init: Story = () => {
  const player = useGameStore((state) => state.player);
  const ship = useGameStore((state) => state.ship);
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);

  return (
    <>
      <p className="story-description">
        We expect to receive a full status hydration from the server on connect,
        and local map data.
      </p>
      <div className="story-card">
        <h3 className="story-heading">Player:</h3>
        {player && (
          <ul className="story-value-list">
            {Object.entries(player).map(([key, value]) => (
              <li key={key}>
                <span>{key}</span> <span>{value?.toString()}</span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="story-heading">Ship:</h3>
        {ship && (
          <ul className="story-value-list">
            {Object.entries(ship).map(([key, value]) => (
              <li key={key}>
                <span className="flex-1">{key}</span>
                <span className="flex-1">
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : value.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="story-heading">Sector:</h3>
        {sector && (
          <ul className="story-value-list">
            {Object.entries(sector).map(([key, value]) => (
              <li key={key}>
                <span className="flex-1">{key}</span>
                <span className="flex-1">
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : value.toString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="story-card  bg-card">
          <h3 className="story-heading">Local Area Map:</h3>
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector.id}
              map_data={localMapData}
              width={440}
              height={440}
              maxDistance={3}
            />
          )}
        </div>
      </div>
    </>
  );
};

Init.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  messages: [["Fetch current status", "Tell me my current status."]],
};

export const Settings: Story = () => {
  const storeSettings = useGameStore.use.settings();
  const [settings, setSettings] =
    useState<SettingsSlice["settings"]>(storeSettings);

  // Automatically save settings to localStorage when they change
  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleVolumeChange = (
    key: keyof SettingsSlice["settings"],
    value: number
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleBooleanChange = (
    key: keyof SettingsSlice["settings"],
    value: boolean
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleQualityChange = (value: "text" | "low" | "high") => {
    setSettings((prev) => ({ ...prev, qualityPreset: value }));
  };

  return (
    <>
      <p className="story-description">
        Story shows the client's current settings. This is derived from the
        store defaults, and any overrides defined in `settings.json` file.
      </p>
      <div className="story-card" style={{ maxWidth: "600px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* Volume Controls */}
          <h3 className="story-heading">Volume Controls</h3>
          {[
            "ambienceVolume",
            "musicVolume",
            "remoteAudioVolume",
            "soundFXVolume",
          ].map((key) => (
            <div
              key={key}
              style={{ display: "flex", alignItems: "center", gap: "1rem" }}
            >
              <label style={{ flex: "0 0 180px" }}>{key}:</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={settings[key as keyof typeof settings] as number}
                onChange={(e) =>
                  handleVolumeChange(
                    key as keyof typeof settings,
                    parseFloat(e.target.value)
                  )
                }
                style={{ flex: 1 }}
              />
              <span style={{ width: "40px", textAlign: "right" }}>
                {(settings[key as keyof typeof settings] as number).toFixed(1)}
              </span>
            </div>
          ))}

          {/* Boolean Toggles */}
          <h3 className="story-heading" style={{ marginTop: "1rem" }}>
            Toggles
          </h3>
          {[
            "disabledAmbience",
            "disabledSoundFX",
            "disableMusic",
            "disableRemoteAudio",
            "enableMic",
            "renderStarfield",
            "startMuted",
          ].map((key) => (
            <div
              key={key}
              style={{ display: "flex", alignItems: "center", gap: "1rem" }}
            >
              <label style={{ flex: "0 0 180px" }}>{key}:</label>
              <input
                type="checkbox"
                checked={settings[key as keyof typeof settings] as boolean}
                onChange={(e) =>
                  handleBooleanChange(
                    key as keyof typeof settings,
                    e.target.checked
                  )
                }
              />
            </div>
          ))}

          {/* Quality Preset */}
          <h3 className="story-heading" style={{ marginTop: "1rem" }}>
            Quality
          </h3>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <label style={{ flex: "0 0 180px" }}>qualityPreset:</label>
            <select
              value={settings.qualityPreset}
              onChange={(e) =>
                handleQualityChange(e.target.value as "text" | "low" | "high")
              }
              style={{ flex: 1 }}
            >
              <option value="text">Text</option>
              <option value="low">Low</option>
              <option value="high">High</option>
            </select>
          </div>

          {/* Display Current State */}
          <h3 className="story-heading" style={{ marginTop: "1rem" }}>
            Current State (JSON)
          </h3>
          <pre
            style={{
              background: "#1e1e1e",
              padding: "1rem",
              borderRadius: "4px",
              overflow: "auto",
            }}
          >
            {JSON.stringify(settings, null, 2)}
          </pre>

          {/* Actions */}
          <div style={{ marginTop: "1rem" }}>
            <button
              onClick={() => {
                removeLocalSettings();
                setSettings(storeSettings);
                alert("Local settings cleared from localStorage!");
              }}
              style={{
                padding: "0.5rem 1rem",
                background: "#dc2626",
                color: "white",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              Clear Local Settings
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

Settings.meta = {
  disconnectedStory: true,
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
};

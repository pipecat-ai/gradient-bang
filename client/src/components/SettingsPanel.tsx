import { SliderControl } from "@/components/primitives/SliderControl";
import { ToggleControl } from "@/components/primitives/ToggleControl";
import useGameStore from "@/stores/game";
import type { SettingsSlice } from "@/stores/settingsSlice";
import {
  Button,
  CardContent,
  CardFooter,
  Divider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pipecat-ai/voice-ui-kit";
import { useEffect, useState } from "react";

const SettingSelect = ({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) => {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="w-full bg-black dark:bg-black"
        variant="secondary"
      >
        <SelectValue placeholder="Please select" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const SettingSlider = ({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) => {
  return (
    <div className="flex items-center gap-4">
      <label className="w-44 text-sm opacity-80">{label}</label>
      <SliderControl
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(values) => onChange(values[0])}
        className="flex-1"
      />
      <span className="w-10 text-right text-sm">{value.toFixed(1)}</span>
    </div>
  );
};

const SettingSwitch = ({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) => {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm opacity-80">{label}</label>
      <ToggleControl checked={checked} onCheckedChange={onChange} />
    </div>
  );
};

interface SettingsPanelProps {
  onSave?: () => void;
}

export const SettingsPanel = ({ onSave }: SettingsPanelProps) => {
  const storeSettings = useGameStore.use.settings();

  const [formSettings, setFormSettings] =
    useState<SettingsSlice["settings"]>(storeSettings);

  useEffect(() => {
    setFormSettings(storeSettings);
  }, [storeSettings]);

  const handleSave = () => {
    useGameStore.getState().setSettings(formSettings);
    onSave?.();
  };

  return (
    <>
      <CardContent>
        <div className="flex flex-col gap-6">
          {/* Audio */}
          <div>
            <div className="text-xs uppercase tracking-wider opacity-70 mb-2">
              Audio
            </div>
            <div className="flex flex-col gap-4">
              {/* Remote Audio */}
              <div className="flex flex-col gap-2">
                <SettingSwitch
                  label="Enable Remote Audio"
                  checked={!formSettings.disableRemoteAudio}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disableRemoteAudio: !enabled,
                    }))
                  }
                />
                {!formSettings.disableRemoteAudio && (
                  <SettingSlider
                    label="Remote Audio"
                    value={formSettings.remoteAudioVolume}
                    onChange={(value) =>
                      setFormSettings((prev) => ({
                        ...prev,
                        remoteAudioVolume: value,
                      }))
                    }
                  />
                )}
              </div>

              {/* Music */}
              <div className="flex flex-col gap-2">
                <SettingSwitch
                  label="Enable Music"
                  checked={!formSettings.disableMusic}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disableMusic: !enabled,
                    }))
                  }
                />
                {!formSettings.disableMusic && (
                  <SettingSlider
                    label="Music"
                    value={formSettings.musicVolume}
                    onChange={(value) =>
                      setFormSettings((prev) => ({
                        ...prev,
                        musicVolume: value,
                      }))
                    }
                  />
                )}
              </div>

              {/* Ambience */}
              <div className="flex flex-col gap-2">
                <SettingSwitch
                  label="Enable Ambience"
                  checked={!formSettings.disabledAmbience}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disabledAmbience: !enabled,
                    }))
                  }
                />
                {!formSettings.disabledAmbience && (
                  <SettingSlider
                    label="Ambience"
                    value={formSettings.ambienceVolume}
                    onChange={(value) =>
                      setFormSettings((prev) => ({
                        ...prev,
                        ambienceVolume: value,
                      }))
                    }
                  />
                )}
              </div>

              {/* Sound FX */}
              <div className="flex flex-col gap-2">
                <SettingSwitch
                  label="Enable Sound FX"
                  checked={!formSettings.disabledSoundFX}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disabledSoundFX: !enabled,
                    }))
                  }
                />
                {!formSettings.disabledSoundFX && (
                  <SettingSlider
                    label="Sound FX"
                    value={formSettings.soundFXVolume}
                    onChange={(value) =>
                      setFormSettings((prev) => ({
                        ...prev,
                        soundFXVolume: value,
                      }))
                    }
                  />
                )}
              </div>
            </div>
          </div>

          <Divider variant="dashed" />

          {/* Visuals */}
          <div>
            <div className="text-xs uppercase tracking-wider opacity-70 mb-2">
              Visuals
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <SettingSelect
                  options={["text", "low", "high"]}
                  value={formSettings.qualityPreset}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      qualityPreset:
                        value as SettingsSlice["settings"]["qualityPreset"],
                    }))
                  }
                />
              </div>
              <SettingSwitch
                label="Bypass Flash Effects"
                checked={formSettings.fxBypassFlash}
                onChange={(value) =>
                  setFormSettings((prev) => ({
                    ...prev,
                    fxBypassFlash: value,
                  }))
                }
              />
              <SettingSwitch
                label="Render Starfield"
                checked={formSettings.renderStarfield}
                onChange={(value) =>
                  setFormSettings((prev) => ({
                    ...prev,
                    renderStarfield: value,
                  }))
                }
              />
            </div>
          </div>

          <Divider variant="dashed" />

          {/* Input */}
          <div>
            <div className="text-xs uppercase tracking-wider opacity-70 mb-2">
              Input
            </div>
            <div className="flex flex-col gap-3">
              <SettingSwitch
                label="Enable Microphone"
                checked={formSettings.enableMic}
                onChange={(value) =>
                  setFormSettings((prev) => ({
                    ...prev,
                    enableMic: value,
                  }))
                }
              />
              <SettingSwitch
                label="Start Muted"
                checked={formSettings.startMuted}
                onChange={(value) =>
                  setFormSettings((prev) => ({
                    ...prev,
                    startMuted: value,
                  }))
                }
              />
            </div>
          </div>

          <Divider variant="dashed" />

          {/* Persistence */}
          <div className="flex flex-col gap-3">
            <SettingSwitch
              label="Save Settings to Device"
              checked={formSettings.saveSettings}
              onChange={(value) =>
                setFormSettings((prev) => ({
                  ...prev,
                  saveSettings: value,
                }))
              }
            />
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex flex-col gap-6">
        <Divider decoration="plus" />
        <Button onClick={handleSave} isFullWidth>
          Save & Close
        </Button>
      </CardFooter>
    </>
  );
};

import { Button } from "@/components/primitives/Button";
import { ScrollArea } from "@/components/primitives/ScrollArea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/primitives/Select";
import { SliderControl } from "@/components/primitives/SliderControl";
import { ToggleControl } from "@/components/primitives/ToggleControl";
import useGameStore from "@/stores/game";
import type { SettingsSlice } from "@/stores/settingsSlice";
import { CardContent, CardFooter } from "@pipecat-ai/voice-ui-kit";
import { useEffect, useState } from "react";
import { Divider } from "./primitives/Divider";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldValue,
} from "./primitives/Field";
import { Separator } from "./primitives/Separator";

const SettingSelect = ({
  label,
  id,
  options,
  value,
  placeholder = "Please select",
  onChange,
}: {
  label: string;
  id: string;
  options: string[];
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) => {
  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
};

const SettingSlider = ({
  id,
  label,
  value,
  min = 0,
  max = 1,
  step = 0.1,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) => {
  return (
    <Field orientation="horizontal" variant={disabled ? "disabled" : "default"}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldContent className="min-w-48">
        <FieldValue>{value.toFixed(1)}</FieldValue>
        <SliderControl
          id={id}
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(values) => onChange(values[0])}
          className="flex-1"
          disabled={disabled}
        />
      </FieldContent>
    </Field>
  );
};

const SettingSwitch = ({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) => {
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>

      <FieldContent>
        <FieldValue>{checked ? "On" : "Off"}</FieldValue>
        <ToggleControl id={id} checked={checked} onCheckedChange={onChange} />
      </FieldContent>
    </Field>
  );
};

interface SettingsPanelProps {
  onSave?: () => void;
  onCancel?: () => void;
}

export const SettingsPanel = ({ onSave, onCancel }: SettingsPanelProps) => {
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
      <div className="flex-1 overflow-y-auto">
        <ScrollArea className="w-full h-full dotted-mask-42 dotted-mask-black">
          <CardContent className="flex flex-col gap-6 pb-6">
            {/* AI */}
            <FieldSet>
              <FieldLegend>AI Personality</FieldLegend>
              <FieldGroup>
                <SettingSelect
                  label="Voice"
                  id="voice"
                  value=""
                  options={["male", "female"]}
                  placeholder="Select a voice"
                  onChange={() => null}
                />
              </FieldGroup>
            </FieldSet>

            <Separator decorative variant="dashed" />

            {/* Audio */}
            <FieldSet>
              <FieldLegend>Audio</FieldLegend>
              {/* Remote Audio */}
              <FieldGroup>
                <SettingSwitch
                  label="AI Speech Enabled"
                  id="enable-remote-audio"
                  checked={!formSettings.disableRemoteAudio}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disableRemoteAudio: !enabled,
                    }))
                  }
                />
                <SettingSlider
                  id="remote-audio"
                  label="AI Speech Volume"
                  value={formSettings.remoteAudioVolume}
                  disabled={formSettings.disableRemoteAudio}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      remoteAudioVolume: value,
                    }))
                  }
                />

                {/* Music */}
                <SettingSwitch
                  label="Music Enabled"
                  id="enable-music"
                  checked={!formSettings.disableMusic}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disableMusic: !enabled,
                    }))
                  }
                />
                <SettingSlider
                  id="music"
                  label="Music Volume"
                  disabled={formSettings.disableMusic}
                  value={formSettings.musicVolume}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      musicVolume: value,
                    }))
                  }
                />

                {/* Ambience */}
                <SettingSwitch
                  label="Ambience Enabled"
                  id="enable-ambience"
                  checked={!formSettings.disabledAmbience}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disabledAmbience: !enabled,
                    }))
                  }
                />
                <SettingSlider
                  id="ambience"
                  label="Ambience Volume"
                  disabled={formSettings.disabledAmbience}
                  value={formSettings.ambienceVolume}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      ambienceVolume: value,
                    }))
                  }
                />

                {/* Sound FX */}
                <SettingSwitch
                  label="Sound FX Enabled"
                  id="enable-sound-fx"
                  checked={!formSettings.disabledSoundFX}
                  onChange={(enabled) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      disabledSoundFX: !enabled,
                    }))
                  }
                />
                <SettingSlider
                  id="sound-fx"
                  label="Sound FX Volume"
                  disabled={formSettings.disabledSoundFX}
                  value={formSettings.soundFXVolume}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      soundFXVolume: value,
                    }))
                  }
                />
              </FieldGroup>
            </FieldSet>

            <Separator decorative variant="dashed" />

            {/* Visuals */}
            <FieldSet>
              <FieldLegend>Visuals</FieldLegend>
              <FieldGroup>
                <SettingSelect
                  label="Quality Preset"
                  id="quality-preset"
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
                <SettingSwitch
                  label="Render 3D Starfield"
                  id="render-starfield"
                  checked={formSettings.renderStarfield}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      renderStarfield: value,
                    }))
                  }
                />

                <SettingSwitch
                  label="Bypass Flashing Effects"
                  id="bypass-flash-effects"
                  checked={formSettings.fxBypassFlash}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      fxBypassFlash: value,
                    }))
                  }
                />

                <SettingSwitch
                  label="Bypass Warp Animation"
                  id="bypass-warp-animation"
                  checked={formSettings.fxBypassAnimation}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      fxBypassAnimation: value,
                    }))
                  }
                />
              </FieldGroup>
            </FieldSet>

            <Separator decorative variant="dashed" />

            {/* Input */}
            <FieldSet>
              <FieldLegend>User Input</FieldLegend>
              <FieldGroup>
                <SettingSwitch
                  label="Enable Microphone"
                  id="enable-microphone"
                  checked={formSettings.enableMic}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      enableMic: value,
                    }))
                  }
                />
                <SettingSwitch
                  label="Start Audio Muted"
                  id="start-muted"
                  checked={formSettings.startMuted}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      startMuted: value,
                    }))
                  }
                />
              </FieldGroup>
            </FieldSet>

            <Separator decorative variant="dashed" />

            {/* Persistence */}
            <div className="flex flex-col gap-3">
              <SettingSwitch
                label="Use Local Storage"
                id="save-settings-to-device"
                checked={formSettings.saveSettings}
                onChange={(value) =>
                  setFormSettings((prev) => ({
                    ...prev,
                    saveSettings: value,
                  }))
                }
              />
            </div>
          </CardContent>
        </ScrollArea>
      </div>
      <CardFooter className="flex flex-col gap-6">
        <Divider decoration="plus" />
        <div className="flex flex-row gap-3">
          <Button onClick={onCancel} variant="secondary" className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleSave} className="flex-1">
            Save & Close
          </Button>
        </div>
      </CardFooter>
    </>
  );
};

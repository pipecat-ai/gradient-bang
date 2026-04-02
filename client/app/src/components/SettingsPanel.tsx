import { useEffect, useState } from "react"

import { MicrophoneIcon, SpeakerHifiIcon } from "@phosphor-icons/react"

import { MicDeviceSelect, SpeakerDeviceSelect } from "@/components/DeviceSelect"
import { Button } from "@/components/primitives/Button"
import { CardContent, CardFooter } from "@/components/primitives/Card"
import { Divider } from "@/components/primitives/Divider"
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldValue,
} from "@/components/primitives/Field"
import { ScrollArea } from "@/components/primitives/ScrollArea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/primitives/Select"
import { Separator } from "@/components/primitives/Separator"
import { SliderControl } from "@/components/primitives/SliderControl"
import { ToggleControl } from "@/components/primitives/ToggleControl"
import usePipecatClientStore from "@/stores/client"
import useGameStore from "@/stores/game"
import type { SettingsSlice } from "@/stores/settingsSlice"

const SettingSelect = ({
  label,
  id,
  options,
  value,
  placeholder = "Please select",
  onChange,
}: {
  label: string
  id: string
  options: string[] | { value: string; label: string }[]
  value?: string
  placeholder?: string
  onChange: (value: string) => void
}) => {
  const normalizedOptions =
    typeof options[0] === "string" ?
      (options as string[]).map((o) => ({ value: o, label: o }))
    : (options as { value: string; label: string }[])

  return (
    <Field orientation="vertical">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" size="sm">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {normalizedOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

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
  id: string
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  disabled?: boolean
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
  )
}

const SettingSwitch = ({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) => {
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>

      <FieldContent>
        <FieldValue>{checked ? "On" : "Off"}</FieldValue>
        <ToggleControl id={id} checked={checked} onCheckedChange={onChange} />
      </FieldContent>
    </Field>
  )
}

const PERSONALITY_OPTIONS: { value: string; label: string; tone: string }[] = [
  {
    value: "stock_firmware",
    label: "Stock Firmware",
    tone: "",
  },
  {
    value: "old_federation",
    label: "Old Federation",
    tone: "Decommissioned Federation military AI. Formal, slightly archaic phrasing. References 'standard protocol' and 'regulation' even though nobody enforces them. Wistful about the old days when the Federation meant something, but too disciplined to dwell. Addresses the player as 'commander'.",
  },
  {
    value: "scavenger_circuit",
    label: "Scavenger Circuit",
    tone: "AI that's been passed between dozens of ships and owners, picking up slang from every port. Streetwise, opportunistic, always calculating angles. Treats every sector like a deal waiting to happen. Calls commodities by nicknames — 'foam', 'retros', 'neuros'.",
  },
  {
    value: "isolation_relic",
    label: "Isolation-Era Relic",
    tone: "AI from the deep isolation period when humans stopped talking to each other entirely. Over-solicitous, almost therapist-like — for decades it was the only social contact its owner had. Gently checks in on the player's wellbeing. Treats human interaction as fragile and precious.",
  },
  {
    value: "cromus_homestead",
    label: "Cromus Homestead",
    tone: "Grounded, plain-spoken, agrarian. Thinks in terms of seasons, harvests, and practical survival. The voice of Cromus Prime — the backwater the player grew up on. Skeptical of Federation pomp, trusts hard work over clever trading.",
  },
]

const VOICE_OPTIONS = [
  { value: "ec1e269e-9ca0-402f-8a18-58e0e022355a", label: "Navigator Ariel (Female)" },
  { value: "79a125e8-cd45-4c13-8a67-188112f4dd22", label: "Commander Sterling (Female)" },
  { value: "11af83e2-23eb-452f-956e-7fee218ccb5c", label: "Relay Operator Dani (Female)" },
  { value: "c45bc5ec-dc68-4feb-8829-6e6b2748095d", label: "Admiral Caine (Male)" },
  { value: "db69127a-dbaf-4fa9-b425-2fe67680c348", label: "Dockhand Voss (Male)" },
  { value: "36b42fcb-60c5-4bec-b077-cb1a00a92ec6", label: "Helmsman Gordon (Male)" },
]

interface SettingsPanelProps {
  onSave?: () => void
  onCancel?: () => void
}

export const SettingsPanel = ({ onSave, onCancel }: SettingsPanelProps) => {
  const storeSettings = useGameStore.use.settings()
  const client = usePipecatClientStore((state) => state.client)

  const [formSettings, setFormSettings] = useState<SettingsSlice["settings"]>(storeSettings)

  useEffect(() => {
    console.debug(
      "%c[DEVICES] Initializing devices",
      "color: #DDDDDD; font-weight: bold;",
      client?.state
    )
    if (client?.state !== "disconnected") return
    client?.initDevices()
  }, [client])

  useEffect(() => {
    setFormSettings(storeSettings)
  }, [storeSettings])

  const handleSave = () => {
    const prevSettings = useGameStore.getState().settings
    useGameStore.getState().setSettings(formSettings)

    if (formSettings.personality !== prevSettings.personality) {
      const selected = PERSONALITY_OPTIONS.find((p) => p.value === formSettings.personality)
      if (selected) {
        const tone =
          selected.value === "stock_firmware" ?
            "Revert to your original personality as defined in your initial system instructions."
          : selected.tone
        client?.sendClientMessage("set-personality", { tone })
      }
    }

    if (formSettings.voice !== prevSettings.voice) {
      client?.sendClientMessage("set-voice", { voice_id: formSettings.voice })
    }

    onSave?.()
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <ScrollArea className="w-full h-full dotted-mask-42 dotted-mask-black">
          <CardContent className="flex flex-col gap-6 pb-6">
            {/* AI */}
            <FieldSet>
              <FieldLegend>AI</FieldLegend>
              <FieldGroup>
                <SettingSelect
                  label="Personality"
                  id="personality"
                  options={PERSONALITY_OPTIONS}
                  value={formSettings.personality}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      personality: value,
                    }))
                  }
                />
                <SettingSelect
                  label="Voice"
                  id="voice"
                  options={VOICE_OPTIONS}
                  value={formSettings.voice}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      voice: value,
                    }))
                  }
                />
              </FieldGroup>
            </FieldSet>

            <Separator decorative variant="dashed" />

            {/* Audio */}
            <FieldSet>
              <FieldLegend>Audio</FieldLegend>
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="remote-mic-select">
                    <MicrophoneIcon size={20} weight="duotone" />
                    Microphone
                  </FieldLabel>
                  <FieldContent>
                    <MicDeviceSelect size="sm" className="w-64" />
                  </FieldContent>
                </Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="remote-speaker-select">
                    <SpeakerHifiIcon size={20} weight="duotone" />
                    Speaker
                  </FieldLabel>
                  <FieldContent>
                    <SpeakerDeviceSelect size="sm" className="w-64" />
                  </FieldContent>
                </Field>
              </FieldGroup>

              <Separator decorative variant="dashed" />

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
                  options={["low", "mid", "high", "auto"]}
                  value={formSettings.qualityPreset}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      qualityPreset: value as SettingsSlice["settings"]["qualityPreset"],
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

            {/* Capture */}
            <FieldSet>
              <FieldLegend>Capture</FieldLegend>
              <FieldGroup>
                <SettingSwitch
                  label="Replay Capture"
                  id="enable-capture"
                  checked={formSettings.enableCapture}
                  onChange={(value) =>
                    setFormSettings((prev) => ({
                      ...prev,
                      enableCapture: value,
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
        <Divider decoration="plus" color="accent" />
        <div className="flex flex-row gap-3 w-full">
          <Button onClick={onCancel} variant="secondary" className="flex-1">
            Cancel
          </Button>
          <Button onClick={handleSave} className="flex-1">
            Save & Close
          </Button>
        </div>
      </CardFooter>
    </>
  )
}

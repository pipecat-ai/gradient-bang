import { usePipecatClientMediaDevices } from "@pipecat-ai/client-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  type SelectTriggerProps,
  SelectValue,
} from "@/components/primitives/Select"

export const MicDeviceSelect = ({
  className,
  ...props
}: SelectTriggerProps & { className?: string }) => {
  const { availableMics, selectedMic, updateMic } = usePipecatClientMediaDevices()

  const placeholder = availableMics?.length > 0 ? "Use default" : "Loading devices..."
  const selectedValue = selectedMic?.deviceId ?? ""

  return (
    <Select value={selectedValue} onValueChange={(v) => updateMic?.(v)}>
      <SelectTrigger id="remote-mic-select" className={className} {...props}>
        <SelectValue placeholder={placeholder} className="truncate">
          <span className="truncate">{selectedMic?.label ?? placeholder}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {availableMics?.map((mic) => (
          <SelectItem key={mic.deviceId} value={mic.deviceId}>
            {mic.label || `Device ${mic.deviceId.slice(0, 5)}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export const SpeakerDeviceSelect = ({
  className,
  ...props
}: SelectTriggerProps & { className?: string }) => {
  const { availableSpeakers, selectedSpeaker, updateSpeaker } = usePipecatClientMediaDevices()

  const placeholder = availableSpeakers?.length > 0 ? "Use default" : "Loading devices..."
  const selectedValue = selectedSpeaker?.deviceId ?? ""

  return (
    <Select value={selectedValue} onValueChange={(v) => updateSpeaker?.(v)}>
      <SelectTrigger id="remote-mic-select" className={className} {...props}>
        <SelectValue placeholder={placeholder} className="truncate">
          <span className="truncate">{selectedSpeaker?.label ?? placeholder}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {availableSpeakers?.map((speaker) => (
          <SelectItem key={speaker.deviceId} value={speaker.deviceId}>
            {speaker.label || `Device ${speaker.deviceId.slice(0, 5)}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

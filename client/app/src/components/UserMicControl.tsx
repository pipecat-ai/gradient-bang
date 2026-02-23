import React, { useCallback } from "react"

import { MicrophoneIcon, MicrophoneSlashIcon } from "@phosphor-icons/react"
import {
  usePipecatClientMicControl,
  usePipecatClientTransportState,
} from "@pipecat-ai/client-react"

import { cn } from "@/utils/tailwind"

import { Button } from "./primitives/Button"
import { ShipOSDVisualizer } from "./ShipOSDVisualizer"

export interface PipecatClientMicToggleProps {
  /**
   * Callback fired when microphone state changes
   */
  onMicEnabledChanged?: (enabled: boolean) => void

  /**
   * Optional prop to disable the mic toggle.
   * When disabled, changes are not applied to the client.
   * @default false
   */
  disabled?: boolean

  /**
   * Remote mute state signalled by Bot / RTVI
   */
  isRemoteMuted?: boolean

  /**
   * Optional class name to apply to the component.
   */
  className?: string
}

/**
 * Headless component for controlling microphone state
 */
export const UserMicControl: React.FC<PipecatClientMicToggleProps> = ({
  onMicEnabledChanged,
  disabled = false,
  isRemoteMuted = false,
  className,
}) => {
  const { enableMic, isMicEnabled } = usePipecatClientMicControl()
  const transportState = usePipecatClientTransportState()

  const initializing = transportState === "disconnected" || transportState === "initializing"

  const handleToggleMic = useCallback(() => {
    if (disabled || isRemoteMuted) return

    const newEnabledState = !isMicEnabled
    enableMic(newEnabledState)
    onMicEnabledChanged?.(newEnabledState)
  }, [disabled, enableMic, isMicEnabled, onMicEnabledChanged, isRemoteMuted])

  return (
    <>
      <Button
        variant={
          initializing ? "micLoading"
          : isRemoteMuted ?
            "micRemoteMuted"
          : isMicEnabled ?
            "micEnabled"
          : "micDisabled"
        }
        onClick={handleToggleMic}
        disabled={disabled || initializing || isRemoteMuted}
        loader="icon"
        isLoading={initializing && !disabled}
        className={cn("flex flex-row gap-2 items-center shrink-0", className)}
      >
        {(() => {
          if (disabled) return <MicrophoneSlashIcon weight="bold" />
          if (isRemoteMuted) return "Please wait"
          if (initializing) return null
          return (
            <>
              {isMicEnabled ?
                <MicrophoneIcon weight="bold" />
              : <MicrophoneSlashIcon weight="bold" />}
              <ShipOSDVisualizer
                disablePeakLines
                participantType="local"
                backgroundColor="transparent"
                barCount={8}
                barGap={3}
                barMaxHeight={28}
                barOrigin="center"
                barWidth={3}
                barLineCap="square"
                barColor={isMicEnabled ? "--color-success" : "--color-destructive"}
                className="hidden @2xl/main:block"
              />
            </>
          )
        })()}
      </Button>
    </>
  )
}

import React, { useCallback } from "react";
import { Button } from "./primitives/Button";

import { MicrophoneIcon, MicrophoneSlashIcon } from "@phosphor-icons/react";
import {
  usePipecatClientMicControl,
  usePipecatClientTransportState,
} from "@pipecat-ai/client-react";
import { cn, VoiceVisualizer } from "@pipecat-ai/voice-ui-kit";

export interface PipecatClientMicToggleProps {
  /**
   * Callback fired when microphone state changes
   */
  onMicEnabledChanged?: (enabled: boolean) => void;

  /**
   * Optional prop to disable the mic toggle.
   * When disabled, changes are not applied to the client.
   * @default false
   */
  disabled?: boolean;

  /**
   * Optional class name to apply to the component.
   */
  className?: string;
}

/**
 * Headless component for controlling microphone state
 */
export const UserMicControl: React.FC<PipecatClientMicToggleProps> = ({
  onMicEnabledChanged,
  disabled = false,
  className,
}) => {
  const { enableMic, isMicEnabled } = usePipecatClientMicControl();
  const transportState = usePipecatClientTransportState();

  const initializing =
    transportState === "disconnected" || transportState === "initializing";

  const handleToggleMic = useCallback(() => {
    if (disabled) return;

    const newEnabledState = !isMicEnabled;
    enableMic(newEnabledState);
    onMicEnabledChanged?.(newEnabledState);
  }, [disabled, enableMic, isMicEnabled, onMicEnabledChanged]);

  return (
    <Button
      variant={
        initializing ? "secondary" : isMicEnabled ? "micEnabled" : "micDisabled"
      }
      onClick={handleToggleMic}
      disabled={disabled || initializing}
      loader="icon"
      isLoading={initializing}
      className={cn("flex flex-row gap-2 items-center shrink-0", className)}
    >
      {initializing ? (
        <></>
      ) : (
        <>
          {isMicEnabled ? (
            <MicrophoneIcon weight="bold" />
          ) : (
            <MicrophoneSlashIcon weight="bold" />
          )}
          <VoiceVisualizer
            participantType="local"
            backgroundColor="transparent"
            barCount={8}
            barGap={3}
            barMaxHeight={28}
            barOrigin="center"
            barWidth={3}
            barColor={isMicEnabled ? "--color-success" : "--color-destructive"}
            className="mx-auto"
          />
        </>
      )}
    </Button>
  );
};

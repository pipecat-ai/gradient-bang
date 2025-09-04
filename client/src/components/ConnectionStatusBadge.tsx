import { RTVIEvent, type TransportState } from "@pipecat-ai/client-js";
import { useRTVIClientEvent } from "@pipecat-ai/client-react";
import { Badge } from "@pipecat-ai/voice-ui-kit";
import { useCallback, useState } from "react";

export const ConnectionStatusBadge = () => {
  const [transportState, setTransportState] =
    useState<TransportState>("disconnected");

  useRTVIClientEvent(RTVIEvent.TransportStateChanged, (newState) => {
    setTransportState(newState);
  });

  const statusBadgeProps = useCallback(() => {
    let props = {
      color: "secondary",
      variant: "bracket",
      className: "",
    };
    switch (transportState) {
      case "disconnected":
      case "initialized":
      case "initializing":
        props = {
          color: "secondary",
          variant: "bracket",
          className: "",
        };
        break;
      case "authenticating":
      case "authenticated":
      case "connecting":
        props = {
          color: "warning",
          variant: "bracket",
          className: "animate-pulse",
        };
        break;
      default:
        props = {
          color: "active",
          variant: "bracket",
          className: "",
        };
        break;
    }
    return props;
  }, [transportState]);

  return (
    <Badge size="lg" {...statusBadgeProps()}>
      Status: {transportState}
    </Badge>
  );
};

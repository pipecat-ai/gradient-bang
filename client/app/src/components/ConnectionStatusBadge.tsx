import { Badge, usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

export const ConnectionStatusBadge = () => {
  const { state } = usePipecatConnectionState();

  return <Badge variant="bracket">Status: {state}</Badge>;
};

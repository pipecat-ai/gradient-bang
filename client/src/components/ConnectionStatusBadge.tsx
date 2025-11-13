import { Badge } from "@/components/primitives/Badge";
import { usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

export const ConnectionStatusBadge = () => {
  const { state } = usePipecatConnectionState();

  return <Badge variant="secondary">Status: {state}</Badge>;
};

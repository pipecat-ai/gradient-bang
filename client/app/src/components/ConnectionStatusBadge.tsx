import { usePipecatConnectionState } from "@pipecat-ai/voice-ui-kit";

import { Badge } from "@/components/primitives/Badge";

export const ConnectionStatusBadge = () => {
  const { state } = usePipecatConnectionState();

  return <Badge variant="secondary">Status: {state}</Badge>;
};

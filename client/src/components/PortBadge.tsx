import { Badge } from "@pipecat-ai/voice-ui-kit";
import usePortStore from "../stores/port";
import useSectorStore from "../stores/sector";

export const PortBadge = () => {
  const { port } = usePortStore();
  const { isAtPort } = useSectorStore();

  return (
    <Badge
      size="lg"
      variant="bracket"
      className={isAtPort() ? "flex-1" : "flex-1 text-subtle"}
      color={isAtPort() ? "agent" : "primary"}
    >
      {isAtPort() ? `Port ${port?.code}` : "No Port"}
    </Badge>
  );
};

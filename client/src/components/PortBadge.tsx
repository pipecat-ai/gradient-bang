import { Badge } from "@pipecat-ai/voice-ui-kit";
import useSectorStore from "../stores/sector";

export const PortBadge = () => {
  const { isAtPort } = useSectorStore();

  return (
    <Badge
      size="lg"
      variant="bracket"
      className={isAtPort() ? "flex-1" : "flex-1 text-subtle"}
      color={isAtPort() ? "agent" : "primary"}
    >
      {isAtPort() ? "At Port" : "No Port"}
    </Badge>
  );
};

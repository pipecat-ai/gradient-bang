import { Badge } from "@pipecat-ai/voice-ui-kit";
import useGameStore from "../stores/game";

export const PortBadge = () => {
  const sector = useGameStore.use.sector();
  const isAtPort = sector?.id === 0 || sector?.port;
  const isMegaPort = sector?.id === 0;

  return (
    <Badge
      size="lg"
      variant="bracket"
      className={isAtPort ? "flex-1" : "flex-1 text-subtle"}
      color={isAtPort ? "agent" : "primary"}
    >
      {isMegaPort
        ? "Mega Port"
        : isAtPort
        ? `Port ${sector?.port?.code}`
        : "No Port"}
    </Badge>
  );
};

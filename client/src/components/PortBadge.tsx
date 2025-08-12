import { Badge } from "@pipecat-ai/voice-ui-kit";

export const PortBadge = ({ isAtPort }: { isAtPort: boolean }) => {
  return (
    <Badge
      size="lg"
      variant="bracket"
      className={isAtPort ? "flex-1" : "flex-1 vkui:text-subtle"}
      color={isAtPort ? "agent" : "primary"}
    >
      {isAtPort ? "At Port" : "No Port"}
    </Badge>
  );
};

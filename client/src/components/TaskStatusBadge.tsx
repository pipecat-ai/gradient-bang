import { Badge } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";

export const TaskStatusBadge = () => {
  const active = false;
  const status = "idle";

  const badgeColor = useMemo(() => {
    if (!active && !status) return "secondary";
    if (!status && active) return "warning";
    /*switch (status) {
      case "paused":
        return "primary";
      case "completed":
        return "active";
      case "cancelled":
      case "failed":
        return "inactive";
    }*/
  }, [status, active]);

  const badgeLabel = useMemo(() => {
    if (!active && !status) return "idle";
    if (!status && active) return "working";
    return status || "idle";
  }, [status, active]);

  return (
    <Badge
      size="lg"
      variant="elbow"
      className={`w-full ${active ? "animate-pulse" : ""}`}
      color={badgeColor}
    >
      <span className="font-extrabold uppercase">{badgeLabel}</span>
    </Badge>
  );
};

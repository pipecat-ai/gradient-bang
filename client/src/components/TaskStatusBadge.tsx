import { Badge } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";
import { useGameManager } from "../hooks/useGameManager";

export const TaskStatusBadge = () => {
  const { game } = useGameManager();

  const badgeColor = useMemo(() => {
    switch (game.taskStatus) {
      case "idle":
        return "primary";
      case "working":
        return "warning";
      case "completed":
        return "active";
      case "failed":
        return "inactive";
    }
  }, [game.taskStatus]);

  return (
    <Badge
      className={`w-full ${
        game.taskStatus === "working" ? "animate-pulse" : ""
      }`}
      color={badgeColor}
    >
      <span className="font-extrabold">{game.taskStatus}</span>
    </Badge>
  );
};

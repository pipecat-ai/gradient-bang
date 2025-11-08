import { Badge } from "@/components/primitives/Badge";
import useGameStore from "@/stores/game";
import { useMemo } from "react";

export const TaskStatusBadge = () => {
  const taskInProgress = useGameStore.use.taskInProgress?.();

  const badgeLabel = useMemo(() => {
    if (!taskInProgress) return "idle";
    if (taskInProgress) return "working";
    return "idle";
  }, [taskInProgress]);

  return (
    <Badge
      size="lg"
      className={`w-full ${taskInProgress ? "animate-pulse" : ""}`}
      variant={taskInProgress ? "success" : "default"}
      border={taskInProgress ? "bracket" : "bracket"}
    >
      <span className="font-extrabold uppercase">{badgeLabel}</span>
    </Badge>
  );
};

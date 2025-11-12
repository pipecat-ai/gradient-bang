import { Badge } from "@/components/primitives/Badge";
import useGameStore from "@/stores/game";
import { cn } from "@/utils/tailwind";
import { TracingBorder } from "@fx/TracingBorder";
import { useEffect, useMemo } from "react";

const taskIdleCX = "bg-muted/50";
const taskInProgressCX =
  "bracket-success -bracket-offset-3 bg-success-background stripe-bar stripe-bar-success/20 stripe-bar-8 stripe-bar-animate-1";
const taskCancelledCX = "bg-warning-background bracket-warning";

export const TaskStatusBadge = () => {
  const taskInProgress = useGameStore.use.taskInProgress?.();
  const taskWasCancelled = useGameStore.use.taskWasCancelled?.();
  const setTaskWasCancelled = useGameStore.use.setTaskWasCancelled?.();

  useEffect(() => {
    if (taskWasCancelled && !taskInProgress) {
      const timeoutId = setTimeout(() => {
        setTaskWasCancelled(false);
      }, 5000);

      return () => clearTimeout(timeoutId);
    }
  }, [taskWasCancelled, taskInProgress, setTaskWasCancelled]);

  const badgeLabel = useMemo(() => {
    if (!taskInProgress && !taskWasCancelled) return "idle";
    if (taskInProgress) return "working";
    if (taskWasCancelled) return "cancelled";

    return "idle";
  }, [taskInProgress, taskWasCancelled]);

  return (
    <TracingBorder active={taskInProgress}>
      <Badge
        className={cn(
          "w-full duration-1000 text-xs tracking-widest",
          taskInProgress
            ? taskInProgressCX
            : taskWasCancelled
            ? taskCancelledCX
            : taskIdleCX
        )}
        variant={
          taskInProgress ? "success" : taskWasCancelled ? "warning" : "default"
        }
        border="bracket"
      >
        Task Agent:
        <span
          className={cn(
            "font-extrabold uppercase",
            taskInProgress
              ? "text-success-foreground animate-pulse"
              : taskWasCancelled
              ? "text-warning-foreground animate-pulse"
              : "text-foreground"
          )}
        >
          {badgeLabel}
        </span>
      </Badge>
    </TracingBorder>
  );
};

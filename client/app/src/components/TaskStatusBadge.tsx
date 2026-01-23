import { useEffect, useMemo } from "react"

import { Badge } from "@/components/primitives/Badge"
import { Button } from "@/components/primitives/Button"
import { TracingBorder } from "@/fx/TracingBorder"
import { useGameContext } from "@/hooks/useGameContext"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const taskIdleCX = "bg-muted/50"
const taskInProgressCX =
  "bracket-success -bracket-offset-3 bg-success-background stripe-bar stripe-bar-success/20 stripe-bar-8 stripe-bar-animate-1"
const taskCancelledCX = "bg-warning-background bracket-warning"

export const TaskStatusBadge = () => {
  const taskInProgress = useGameStore.use.taskInProgress?.()
  const taskWasCancelled = useGameStore.use.taskWasCancelled?.()
  const setTaskWasCancelled = useGameStore.use.setTaskWasCancelled?.()
  const activeTasks = useGameStore.use.activeTasks?.()
  const { dispatchAction } = useGameContext()

  const activeTaskList = useMemo(
    () => Object.values(activeTasks ?? {}),
    [activeTasks]
  )
  const hasActiveTasks = activeTaskList.length > 0

  useEffect(() => {
    if (taskWasCancelled && !taskInProgress) {
      const timeoutId = setTimeout(() => {
        setTaskWasCancelled(false)
      }, 5000)

      return () => clearTimeout(timeoutId)
    }
  }, [taskWasCancelled, taskInProgress, setTaskWasCancelled])

  const badgeLabel = useMemo(() => {
    if (!hasActiveTasks && !taskInProgress && !taskWasCancelled) return "idle"
    if (hasActiveTasks || taskInProgress) return "working"
    if (taskWasCancelled) return "cancelled"

    return "idle"
  }, [hasActiveTasks, taskInProgress, taskWasCancelled])

  return (
    <TracingBorder active={taskInProgress || hasActiveTasks}>
      <div className="flex flex-col gap-2">
        <Badge
          className={cn(
            "w-full duration-1000 text-xs tracking-widest",
            taskInProgress || hasActiveTasks
              ? taskInProgressCX
              : taskWasCancelled
                ? taskCancelledCX
                : taskIdleCX
          )}
          variant={
            taskInProgress || hasActiveTasks
              ? "success"
              : taskWasCancelled
                ? "warning"
                : "default"
          }
          border="bracket"
        >
          <span className="opacity-50">Task Agent:</span>
          <span
            className={cn(
              "font-extrabold uppercase",
              taskInProgress || hasActiveTasks
                ? "text-success-foreground animate-pulse"
                : taskWasCancelled
                  ? "text-warning-foreground animate-pulse"
                  : "text-foreground"
            )}
          >
            {badgeLabel}
            {hasActiveTasks ? ` (${activeTaskList.length})` : ""}
          </span>
        </Badge>

        {hasActiveTasks && (
          <div className="flex flex-col gap-2 text-xs">
            {activeTaskList.map((task) => (
              <div
                key={task.task_id}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate opacity-80">
                  {task.task_description ||
                    [
                      task.ship_name ||
                        task.ship_type ||
                        (task.ship_id
                          ? `Ship ${task.ship_id.slice(0, 6)}`
                          : null),
                      task.actor_character_name ||
                        (task.actor_character_id
                          ? `Actor ${task.actor_character_id.slice(0, 6)}`
                          : null),
                    ]
                      .filter(Boolean)
                      .join(" • ") ||
                    `Task ${task.task_id.slice(0, 6)}`}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    dispatchAction({
                      type: "cancel-task",
                      payload: { task_id: task.task_id },
                    })
                  }
                >
                  Cancel
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </TracingBorder>
  )
}

import { memo, useEffect } from "react"

import { CopyTaskContextButton } from "@/components/CopyTaskContextButton"
import { ScrollArea } from "@/components/primitives/ScrollArea"
import { ScrollNewItemsButton } from "@/components/ScrollNewItemsButton"
import { useAutoScroll } from "@/hooks/useAutoScroll"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const MAX_TASK_SUMMARY_LENGTH = 100
const EMPTY_OUTPUTS: TaskOutput[] = []

const TaskTypeBadge = ({ type }: { type: Task["type"] }) => {
  return (
    <div
      className={cn(
        "py-0.5 uppercase font-black text-center leading-none text-[10px]",
        type === "FAILED" ?
          "border border-destructive bg-destructive-background text-destructive-foreground"
        : type === "ACTION" ? "bg-fuel-background text-fuel-foreground"
        : type === "EVENT" ? "bg-terminal-background text-terminal"
        : type === "MESSAGE" ?
          "border border-accent-foreground/40 bg-accent-background text-accent-foreground"
        : type === "THINKING" ?
          "border border-muted-foreground/40 bg-subtle-background text-muted-foreground"
        : type === "STEP" ?
          "bg-subtle-background text-muted-foreground border border-subtle-foreground"
        : type === "COMPLETE" ? "border border-success bg-success-background text-success"
        : type === "CANCELLED" ? "border border-warning bg-warning-background text-warning"
        : type === "FINISHED" ? "bg-success-background text-success-foreground"
        : type === "ERROR" ? "bg-destructive-background text-destructive-foreground"
        : "bg-foreground text-background"
      )}
    >
      {type}
    </div>
  )
}

const formatTaskSummary = (summary: string) => {
  const cleaned = summary.replace(/^[0-9]+ - /, "")
  const match = cleaned.match(/^([a-zA-Z_]+\.[a-zA-Z_]+:)\s*/)

  if (match) {
    const prefix = match[1]
    const rest = cleaned.slice(match[0].length)
    return (
      <>
        <span className="text-terminal font-semibold">{prefix}</span> {rest}
      </>
    )
  }

  return cleaned
}

const TaskRow = memo(({ task, className }: { task: TaskOutput; className?: string }) => {
  return (
    <div
      className={cn(
        "flex flex-row gap-4 w-full border-b border-muted last:border-b-0 py-2 last:pb-0 text-[10px] select-none",
        task.task_message_type === "ERROR" && "border-l-2 border-l-destructive pl-2",
        className
      )}
    >
      <div className="flex flex-row gap-3">
        <div className="w-16">
          <TaskTypeBadge type={task.task_message_type.toUpperCase() as TaskType} />
        </div>
        <div
          className={cn(
            "normal-case flex-1 text-pretty",
            task.task_message_type === "ERROR" && "text-destructive-foreground",
            task.task_message_type === "STEP" && "text-accent-foreground",
            task.task_message_type === "MESSAGE" && "text-accent-foreground italic",
            task.task_message_type === "THINKING" && "text-muted-foreground italic"
          )}
        >
          {formatTaskSummary(task.task_message_type === "FAILED" ? "Task cancelled" : task.text)}
        </div>
      </div>
    </div>
  )
})

export const TaskOutputStream = ({
  taskId,
  className,
  showCopyButton = true,
}: {
  taskId?: string | null
  className?: string
  showCopyButton?: boolean
}) => {
  const tasks = useGameStore((state) =>
    taskId ? (state.taskOutputs[taskId] ?? EMPTY_OUTPUTS) : EMPTY_OUTPUTS
  )

  const { scrollRef, contentRef, hasNewItems, dismissLock, scrollToBottom, trackItems } =
    useAutoScroll({ behavior: "instant" })

  useEffect(() => {
    trackItems(tasks.length)
  }, [tasks.length, trackItems])

  // Snap to the bottom when switching tasks so the new stream starts engaged.
  useEffect(() => {
    if (taskId) scrollToBottom()
  }, [taskId, scrollToBottom])

  const visibleTasks = tasks.slice(-MAX_TASK_SUMMARY_LENGTH)
  const visibleStartIndex = Math.max(tasks.length - visibleTasks.length, 0)

  return (
    <div className={cn("group flex flex-col w-full h-full min-h-0 select-none", className)}>
      {taskId && showCopyButton && (
        <div className="absolute right-ui-sm top-ui-sm z-10 pointer-events-auto">
          <CopyTaskContextButton taskId={taskId} />
        </div>
      )}
      <div className="relative flex flex-col flex-1 min-h-0 mask-[linear-gradient(to_bottom,transparent_0px,black_80px)]">
        <ScrollArea className="w-full flex-1 min-h-0" viewportRef={scrollRef}>
          <div className="flex flex-col min-h-full">
            <div className="flex-1" aria-hidden="true" />
            <div ref={contentRef} className="pt-10 pb-1">
              {visibleTasks.map((task, index) => {
                const absoluteIndex = visibleStartIndex + index
                return <TaskRow key={`${task.task_id}-${absoluteIndex}`} task={task} />
              })}
            </div>
          </div>
        </ScrollArea>
        {hasNewItems && <ScrollNewItemsButton onClick={dismissLock} className="bottom-1" />}
      </div>
    </div>
  )
}

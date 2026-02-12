import { memo, useCallback, useEffect, useRef, useState } from "react"

import { ScrollArea } from "@/components/primitives/ScrollArea"
import { ScrollNewItemsButton } from "@/components/ScrollNewItemsButton"
import { useAutoScroll } from "@/hooks/useAutoScroll"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const MAX_TASK_SUMMARY_LENGTH = 100

const TaskTypeBadge = ({ type }: { type: Task["type"] }) => {
  return (
    <div
      className={cn(
        "py-0.5 uppercase font-black text-center leading-none text-[10px]",
        type === "FAILED" ?
          "border border-destructive bg-destructive-background text-destructive-foreground"
        : type === "ACTION" ? "bg-fuel-background text-fuel-foreground"
        : type === "EVENT" ? "bg-terminal-background text-terminal"
        : type === "STEP" ?
          "bg-subtle-background text-muted-foreground border border-subtle-foreground"
        : type === "COMPLETE" ? "border border-success bg-success-background text-success"
        : type === "CANCELLED" ? "border border-warning bg-warning-background text-warning"
        : type === "FINISHED" ? "bg-success-background text-success-foreground"
        : "bg-foreground text-background"
      )}
    >
      {type}
    </div>
  )
}

const formatTaskSummary = (summary: string) => {
  // First remove leading numbers
  const cleaned = summary.replace(/^[0-9]+ - /, "")

  // Match pattern like "movement.complete:" or "map.local:" at the start
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

const TaskRow = memo(
  ({ task, className }: { task: TaskOutput; className?: string }) => {
    return (
      <div
        className={cn(
          "flex flex-row gap-4 w-full border-b border-muted last:border-b-0 py-2 last:pb-0 text-[10px] select-none",
          className
        )}
      >
        <div className="flex flex-row gap-3">
          <div className="w-16">
            <TaskTypeBadge type={task.task_message_type.toUpperCase() as TaskType} />
          </div>
          <div className="normal-case flex-1">
            {formatTaskSummary(task.task_message_type === "FAILED" ? "Task cancelled" : task.text)}
          </div>
        </div>
      </div>
    )
  },
  (prev, next) => prev.task.task_id === next.task.task_id && prev.className === next.className
)

export const TaskOutputStreamComponent = ({
  tasks,
  onResetAutoScroll,
  className,
}: {
  tasks: TaskOutput[]
  onResetAutoScroll?: (reset: () => void) => void
  className?: string
}) => {
  const { scrollRef, contentRef, hasNewItems, dismissLock, resetAutoScroll, trackItems } =
    useAutoScroll({ behavior: "instant" })

  useEffect(() => {
    onResetAutoScroll?.(resetAutoScroll)
  }, [onResetAutoScroll, resetAutoScroll])

  useEffect(() => {
    trackItems(tasks.length)
  }, [tasks.length, trackItems])

  const visibleTasks = tasks.slice(-MAX_TASK_SUMMARY_LENGTH)

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col w-full bg-transparent h-full min-h-0 select-none pointer-events-none",
        className
      )}
    >
      <div className="relative flex flex-col h-full justify-end mask-[linear-gradient(to_bottom,transparent_0px,black_80px)]">
        <ScrollArea
          className="w-full h-full overflow-hidden pointer-events-auto"
          viewportRef={scrollRef}
          fullHeight
          classNames={{ scrollbar: "*:first:bg-white/30" }}
        >
          <div ref={contentRef} className="flex flex-col justify-end min-h-full pt-10">
            {visibleTasks.map((task, index) => {
              return <TaskRow key={`${task.task_id}-${index}`} task={task} />
            })}
          </div>
        </ScrollArea>
        {hasNewItems && (
          <ScrollNewItemsButton onClick={dismissLock} className="bottom-1" />
        )}
      </div>
    </div>
  )
}

const EMPTY_OUTPUTS: TaskOutput[] = []

export const TaskOutputStream = ({
  taskId,
  className,
}: {
  taskId?: string | null
  className?: string
}) => {
  const [cachedOutputs, setCachedOutputs] = useState<TaskOutput[]>([])
  const resetAutoScrollRef = useRef<(() => void) | null>(null)

  const tasks = useGameStore((state) =>
    taskId ? (state.taskOutputs[taskId] ?? EMPTY_OUTPUTS) : EMPTY_OUTPUTS
  )

  // Keep cache in sync with live outputs via store subscription.
  // First callback (fireImmediately) clears/sets cache for the current taskId.
  useEffect(() => {
    if (!taskId) return

    let isFirst = true
    const unsubscribe = useGameStore.subscribe(
      (state) => state.taskOutputs[taskId],
      (outputs) => {
        if (isFirst) {
          isFirst = false
          setCachedOutputs(outputs ?? [])
          return
        }
        if (outputs && outputs.length > 0) {
          setCachedOutputs(outputs)
        }
      },
      { fireImmediately: true }
    )

    return unsubscribe
  }, [taskId])

  // Reset auto-scroll when taskId changes
  useEffect(() => {
    if (taskId) {
      resetAutoScrollRef.current?.()
    }
  }, [taskId])

  // Stable callback to capture reset function
  const handleResetAutoScroll = useCallback((reset: () => void) => {
    resetAutoScrollRef.current = reset
  }, [])

  // Use live outputs if available, otherwise fall back to cached outputs
  const displayTasks = tasks.length > 0 ? tasks : cachedOutputs

  return (
    <TaskOutputStreamComponent
      tasks={displayTasks}
      onResetAutoScroll={handleResetAutoScroll}
      className={className}
    />
  )
}

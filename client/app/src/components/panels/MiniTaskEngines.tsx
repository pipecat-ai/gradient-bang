import { useEffect, useMemo, useRef, useState } from "react"

import { cva } from "class-variance-authority"
import { CircleNotchIcon, LockSimpleIcon, ProhibitIcon } from "@phosphor-icons/react"

import { type TaskEngineState } from "@/components/panels/TaskEnginesPanel"
import { Button } from "@/components/primitives/Button"
import { Divider } from "@/components/primitives/Divider"
import { TaskStatusBadge } from "@/components/TaskStatusBadge"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const stateLabels: Record<TaskEngineState, string> = {
  idle: "Idle",
  active: "Working",
  completed: "Completed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
}

const cx = cva("group w-full flex flex-col gap-ui-sm shrink-0 p-ui-xs select-none", {
  variants: {
    state: {
      idle: "",
      completed: "",
      cancelling: "",
      cancelled: "",
      failed: "",
      active: "",
    },
    subtle: {
      true: "bg-background/80 hover:bg-background",
      false: "bg-background hover:bg-background",
    },
  },

  defaultVariants: {
    state: "idle",
    subtle: false,
  },
})

const MiniEnginePlaceholder = ({ label }: { label: string }) => {
  return (
    <div className="w-full flex flex-col gap-ui-xs">
      <Divider variant="dashed" className="h-[6px] dashed-bg-foreground/30" />
      <div className="flex flex-row gap-2 items-center justify-center p-ui-xs bg-background/80">
        <LockSimpleIcon weight="bold" size={14} />
        <span className="text-xs text-subtle-foreground uppercase">{label}</span>
      </div>
    </div>
  )
}

const MiniTaskDescription = ({
  description,
  placeholder,
  active,
}: {
  description?: string
  placeholder: string
  active: boolean
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  const text = description ?? placeholder

  useEffect(() => {
    const textEl = textRef.current
    const containerEl = containerRef.current
    if (!textEl || !containerEl) return
    setOverflow(Math.max(0, textEl.scrollWidth - containerEl.clientWidth))
  }, [text])

  const duration = overflow > 0 ? overflow / 25 : 0

  return (
    <div className="relative text-xxs flex flex-row gap-1 items-center">
      <div
        ref={containerRef}
        className="overflow-hidden flex-1 self-stretch flex items-center leading-none"
        style={
          overflow > 0 ?
            { maskImage: "linear-gradient(to right, black calc(100% - 24px), transparent)" }
          : undefined
        }
      >
        <span
          ref={textRef}
          className={cn(
            "whitespace-nowrap uppercase inline-block transition-transform duration-0 ease-linear group-hover:delay-200 group-hover:duration-(--marquee-duration) group-hover:transform-[translateX(var(--marquee-offset,0px))]",
            active ? "text-foreground" : "text-foreground/60 group-hover:text-foreground"
          )}
          style={{
            ...(overflow > 0 &&
              ({
                "--marquee-offset": `-${overflow}px`,
                "--marquee-duration": `${duration}s`,
              } as React.CSSProperties)),
          }}
        >
          {text}
        </span>
      </div>
    </div>
  )
}

const MiniEngineBase = ({
  children,
  state,
  subtle,
}: {
  children: React.ReactNode
  state: TaskEngineState
  subtle: boolean
}) => {
  return <div className={cx({ state, subtle })}>{children}</div>
}

const MiniEngine = ({ taskId, isLocal }: { taskId: string; isLocal?: boolean }) => {
  const getTaskByTaskId = useGameStore.use.getTaskByTaskId?.()
  const getTaskSummaryByTaskId = useGameStore.use.getTaskSummaryByTaskId?.()
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const setActivePanel = useGameStore.use.setActivePanel?.()

  const [isCancelling, setIsCancelling] = useState(false)

  // Look up active task and summary by ID
  const task = taskId ? getTaskByTaskId?.(taskId) : undefined
  const summary = taskId ? getTaskSummaryByTaskId?.(taskId) : undefined

  const { state, displayTask } = useMemo(() => {
    if (task) {
      return {
        state: isCancelling ? "cancelling" : ("active" as TaskEngineState),
        displayTask: task,
      }
    }
    if (summary) {
      return {
        state: summary.task_status as TaskEngineState,
        displayTask: summary,
      }
    }

    // Idle state
    return { state: "idle" as TaskEngineState, displayTask: null }
  }, [task, summary, isCancelling])

  if (state !== "active" && state !== "cancelling" && isCancelling) {
    setIsCancelling(false)
  }

  const mountedRef = useRef(true)
  const changeCountRef = useRef(0)
  const [animationKey, setAnimationKey] = useState<string | null>(null)

  useEffect(() => {
    if (mountedRef.current) {
      mountedRef.current = false
      return
    }
    if (state !== "active") {
      changeCountRef.current += 1
      setAnimationKey(`${state}-${changeCountRef.current}`)
    }
  }, [state])

  return (
    <div
      onClick={() => {
        if (!taskId) return
        setActivePanel("task_stream", taskId)
      }}
    >
      <MiniEngineBase state={state} subtle={state !== "active"}>
        <MiniTaskDescription
          description={displayTask?.task_description}
          placeholder={isLocal ? "Local task engine" : "Corporation task engine"}
          active={state === "active"}
        />
        <div className="relative">
          {state === "active" && (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={isCancelling}
              className="absolute z-20 top-1 right-1 size-6.5 bg-success-background/50 text-success-foreground hover:bg-success-background"
              onClick={() => {
                if (!taskId) return
                setIsCancelling(true)
                dispatchAction({ type: "cancel-task", payload: { task_id: taskId } })
              }}
            >
              {isCancelling ?
                <CircleNotchIcon weight="duotone" className="animate-spin" size={16} />
              : <ProhibitIcon weight="duotone" size={16} />}
            </Button>
          )}
          <div
            key={animationKey}
            className={cn(
              animationKey && state !== "active" && !isCancelling && "animate-blink repeat-3"
            )}
          >
            <TaskStatusBadge state={state} label={stateLabels[state]} />
          </div>
        </div>
      </MiniEngineBase>
    </div>
  )
}

const MAX_CORP_SLOTS = 3

export const MiniTaskEngines = () => {
  const activeTasks = useGameStore.use.activeTasks?.()
  const localTaskId = useGameStore.use.localTaskId?.()
  const ships = useGameStore.use.ships?.()
  const setLocalTaskId = useGameStore.use.setLocalTaskId?.()
  const corpSlotAssignments = useGameStore.use.corpSlotAssignments?.()
  const assignTaskToCorpSlot = useGameStore.use.assignTaskToCorpSlot?.()

  // Count corporation ships to determine number of corp slots
  const corpShipCount = useMemo(() => {
    return ships.data?.filter((ship) => ship.owner_type === "corporation").length ?? 0
  }, [ships.data])

  // Get active local player task
  const activeLocalTask = useMemo(() => {
    const playerTasks = Object.values(activeTasks ?? {}).filter(
      (task) => task?.task_scope === "player_ship"
    )
    return playerTasks[0] ?? null
  }, [activeTasks])

  // Get corp ship tasks
  const corpShipTasks = useMemo(() => {
    return Object.values(activeTasks ?? {}).filter((task) => task?.task_scope === "corp_ship") ?? []
  }, [activeTasks])

  // Update local task ID when a new local task starts
  useEffect(() => {
    if (activeLocalTask && setLocalTaskId) {
      setLocalTaskId(activeLocalTask.task_id)
    }
  }, [activeLocalTask, setLocalTaskId])

  const displayedCorpSlots = Math.min(corpShipCount, MAX_CORP_SLOTS)
  const showLockedPlaceholder = corpShipCount < MAX_CORP_SLOTS

  // Assign corp tasks to slots when they appear
  useEffect(() => {
    if (!assignTaskToCorpSlot) return

    // Assign each corp task to a slot, limited by unlocked slots
    for (const task of corpShipTasks) {
      assignTaskToCorpSlot(task.task_id, displayedCorpSlots)
    }
  }, [corpShipTasks, assignTaskToCorpSlot, displayedCorpSlots])

  return (
    <div className="h-full w-full flex flex-col justify-end gap-ui-xs">
      <MiniEngine taskId={localTaskId ?? ""} isLocal />
      {Array.from({ length: displayedCorpSlots }, (_, index) => (
        <MiniEngine key={index} taskId={corpSlotAssignments?.[index] ?? ""} />
      ))}
      {showLockedPlaceholder && (
        <MiniEnginePlaceholder
          label={
            !ships.data ?
              "create corporation to unlock"
            : `${displayedCorpSlots + 1} / 4 slots used`
          }
        />
      )}
    </div>
  )
}

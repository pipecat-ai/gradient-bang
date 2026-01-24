import { useEffect, useMemo, useState } from "react"

import { cva } from "class-variance-authority"
import { motion } from "motion/react"
import { CircleNotchIcon, LockKeyIcon, StopCircleIcon } from "@phosphor-icons/react"

import { Button } from "@/components/primitives/Button"
import { Card, CardContent } from "@/components/primitives/Card"
import { TaskStatusBadge } from "@/components/TaskStatusBadge"
import { useDispatchInterval } from "@/hooks/useDispatchInterval"
import useGameStore from "@/stores/game"

import { TaskOutputStream } from "../TaskOutputStream"

export type TaskEngineState =
  | "idle"
  | "active"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed"

const stateLabels: Record<TaskEngineState, string> = {
  idle: "Idle",
  active: "Working",
  completed: "Completed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
}

const cx = cva(
  "relative elbow elbow-offset-1 elbow-size-10 elbow-2 transition-opacity duration-1000 select-none",
  {
    variants: {
      state: {
        idle: "elbow-subtle-foreground",
        completed: "",
        cancelling: "elbow-foreground",
        cancelled: "",
        failed: "",
        active: "elbow-foreground bg-card/70",
      },
    },
    defaultVariants: {
      state: "idle",
    },
  }
)

const TaskEngineHeader = ({ prefix, label }: { prefix?: string; label: string }) => {
  return (
    <div className="flex flex-row gap-3 items-center justify-center text-[13px] font-bold uppercase">
      <div className="flex-1 dotted-bg-sm text-accent h-3"></div>
      <div className="flex flex-row gap-2 items-center justify-center">
        {prefix && <span className="text-accent-foreground">{prefix}</span>} {label}
      </div>
      <div className="flex-1 dotted-bg-sm text-accent h-3"></div>
    </div>
  )
}

const LockedTaskEngineSlot = () => {
  return (
    <div className="col-span-1 opacity-30">
      <Card
        className="relative elbow elbow-offset-1 elbow-size-10 elbow-2 elbow-subtle-foreground select-none"
        size="sm"
      >
        <CardContent className="flex flex-col gap-2">
          <TaskEngineHeader label="Locked" />
          <div className="h-[200px] flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <LockKeyIcon weight="duotone" size={32} />
              <span className="text-xs uppercase tracking-wider">Purchase a corp ship to unlock</span>
            </div>
          </div>
          <div className="h-2 dashed-bg-horizontal dashed-bg-accent ml-panel-gap"></div>
          <div className="relative">
            <TaskStatusBadge state="idle" label="Locked" />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export const TaskEngine = ({ taskId, isLocal }: { taskId?: string | null; isLocal?: boolean }) => {
  const getTaskByTaskId = useGameStore.use.getTaskByTaskId?.()
  const getTaskSummaryByTaskId = useGameStore.use.getTaskSummaryByTaskId?.()
  const dispatchAction = useGameStore.use.dispatchAction?.()
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

  return (
    <motion.div
      initial={{ opacity: 0.4 }}
      animate={{ opacity: state === "active" || state === "cancelling" ? 1 : 0.4 }}
      whileHover={{ opacity: 1, transition: { delay: 0, duration: 0.2 } }}
      transition={{
        opacity: {
          delay: state === "active" || state === "cancelling" ? 0 : 6,
          duration: 1,
        },
      }}
      className="col-span-1"
    >
      <Card className={cx({ state })} size="sm">
        <CardContent className="flex flex-col gap-2">
          <TaskEngineHeader
            prefix={isLocal || !displayTask ? undefined : "engine:"}
            label={
              isLocal ? "Local Task Engine"
              : displayTask?.ship_name ?
                `${displayTask.ship_name} (${displayTask.ship_type?.replace("_", " ")})`
              : "Awaiting Task"
            }
          />

          <div className="h-[200px] overflow-y-auto">
            <TaskOutputStream taskId={taskId} />
          </div>

          <div className="h-2 dashed-bg-horizontal dashed-bg-accent ml-panel-gap"></div>

          <div className="relative">
            <TaskStatusBadge state={state} label={stateLabels[state]} />
            {state === "active" && (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={isCancelling}
                className="absolute top-1 right-1 size-6.5 bg-success-foreground/10 text-success-foreground"
                onClick={() => {
                  if (!taskId) return
                  setIsCancelling(true)
                  dispatchAction({ type: "cancel-task", payload: { task_id: taskId } })
                }}
              >
                {isCancelling ?
                  <CircleNotchIcon weight="duotone" className="animate-spin" size={16} />
                : <StopCircleIcon weight="duotone" size={16} />}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export const TaskEnginesPanel = () => {
  const activeTasks = useGameStore.use.activeTasks?.()
  const ships = useGameStore.use.ships?.()
  const corpSlotAssignments = useGameStore.use.corpSlotAssignments?.()
  const assignTaskToCorpSlot = useGameStore.use.assignTaskToCorpSlot?.()
  const localTaskId = useGameStore.use.localTaskId?.()
  const setLocalTaskId = useGameStore.use.setLocalTaskId?.()

  const { isFetching } = useDispatchInterval("get-my-ships", {
    data: ships.data,
  })

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

  // Assign corp tasks to slots when they appear
  useEffect(() => {
    if (!assignTaskToCorpSlot) return

    // Assign each corp task to a slot (round-robin logic handled in slice)
    for (const task of corpShipTasks) {
      assignTaskToCorpSlot(task.task_id)
    }
  }, [corpShipTasks, assignTaskToCorpSlot])

  if (isFetching) {
    return <div>Loading...</div>
  }

  const MAX_CORP_SLOTS = 3
  const displayedCorpSlots = Math.min(corpShipCount, MAX_CORP_SLOTS)
  const showLockedPlaceholder = corpShipCount < MAX_CORP_SLOTS

  return (
    <div className="grid grid-cols-2 gap-4">
      <TaskEngine taskId={localTaskId} isLocal />
      {Array.from({ length: displayedCorpSlots }, (_, index) => (
        <TaskEngine key={index} taskId={corpSlotAssignments?.[index]} />
      ))}
      {showLockedPlaceholder && <LockedTaskEngineSlot />}
    </div>
  )
}

import { useEffect, useMemo, useState } from "react"

import { cva } from "class-variance-authority"
import { motion } from "motion/react"
import { CircleNotchIcon, LockSimpleIcon, StopCircleIcon } from "@phosphor-icons/react"

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
  "relative elbow elbow-offset-1 elbow-size-10 elbow-2 transition-opacity duration-1000 select-none h-full",
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

const TaskEngineBlankSlate = () => {
  return (
    <Card
      className="border-border/0 relative elbow elbow-offset-1 elbow-size-10 elbow-2 elbow-subtle-foreground select-none h-full bg-background/50 opacity-40"
      size="sm"
    >
      <CardContent className="flex flex-col gap-2 h-full relative"></CardContent>
    </Card>
  )
}

const LockedTaskEngineSlot = () => {
  return (
    <motion.div
      initial={{ opacity: 0.4 }}
      animate={{ opacity: 0.4 }}
      whileHover={{ opacity: 1 }}
      transition={{ opacity: { duration: 0.3 } }}
      className="col-span-1 h-full"
    >
      <Card
        className="relative elbow elbow-offset-1 elbow-size-10 elbow-2 elbow-subtle-foreground select-none h-full bg-background/50"
        size="sm"
      >
        <span
          className="absolute inset-3 cross-lines-terminal-foreground/20 z-1 pointer-events-none animate-in zoom-in-0 duration-300 ease-in-out"
          aria-hidden="true"
        />
        <CardContent className="flex flex-col gap-2 h-full relative">
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-row items-center gap-1.5 text-subtle-foreground bg-black py-0.5 px-1">
              <LockSimpleIcon weight="bold" size={14} />
              <span className="text-xs uppercase text-muted-foreground font-bold">
                additional corp ship required
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
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
      className="col-span-1 h-full"
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
        </CardContent>

        <div className="h-full flex flex-col justify-end overflow-y-auto">
          <TaskOutputStream taskId={taskId} />
        </div>

        <CardContent className="flex flex-col gap-2">
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

  useDispatchInterval("get-my-ships", {
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

  const MAX_CORP_SLOTS = 3
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
    <div className="grid grid-cols-2 auto-rows-[340px] gap-2">
      <TaskEngine taskId={localTaskId} isLocal />
      {!ships.data ?
        <TaskEngineBlankSlate />
      : <>
          {Array.from({ length: displayedCorpSlots }, (_, index) => (
            <TaskEngine key={index} taskId={corpSlotAssignments?.[index]} />
          ))}
          {showLockedPlaceholder && <LockedTaskEngineSlot />}
        </>
      }
    </div>
  )
}

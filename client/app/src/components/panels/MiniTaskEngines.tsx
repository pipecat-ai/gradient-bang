import { useMemo, useState } from "react"

import { cva } from "class-variance-authority"
import {
  CaretRightIcon,
  CircleNotchIcon,
  LockSimpleIcon,
  ProhibitIcon,
} from "@phosphor-icons/react"

import { type TaskEngineState } from "@/components/panels/TaskEnginesPanel"
import { Button } from "@/components/primitives/Button"
import { Divider } from "@/components/primitives/Divider"
import { TaskEngineSummaryText } from "@/components/TaskEngineSummaryText"
import { TaskStatusBadge } from "@/components/TaskStatusBadge"
import { useTaskState } from "@/hooks/useTaskState"
import useGameStore from "@/stores/game"

const stateLabels: Record<TaskEngineState, string> = {
  idle: "Idle",
  active: "Working",
  completed: "Completed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  failed: "Failed",
}

const cx = cva("select-none relative flex flex-row h-[82px] pl-ui-md gap-ui-sm", {
  variants: {
    subtle: {
      true: "group bg-background/80 hover:bg-background",
      false: "group/subtle bg-background hover:bg-background",
    },
    hasTask: {
      true: "",
      false: "pr-ui-xs",
    },
  },

  defaultVariants: {
    subtle: false,
  },
})

const MiniEnginePlaceholder = ({ label }: { label: string }) => {
  return (
    <div className="w-full flex flex-col justify-between pl-ui-xs pt-ui-xxs pb-ui-xs mt-auto">
      <Divider variant="dashed" className="h-[6px] dashed-bg-foreground/30" />
      <div className="flex flex-row gap-2 items-center justify-center p-ui-sm bg-background/60">
        <LockSimpleIcon weight="bold" size={14} />
        <span className="text-xs text-subtle-foreground uppercase">{label}</span>
      </div>
    </div>
  )
}

const MiniEngineBase = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="group relative flex-1 min-w-0 flex flex-col justify-center gap-ui-sm">
      {children}
    </div>
  )
}

const MiniEngine = ({
  taskId,
  isLocal,
  showDivider = true,
}: {
  taskId: string
  isLocal?: boolean
  showDivider?: boolean
}) => {
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

  return (
    <div className={cx({ subtle: state !== "active", hasTask: !!taskId })}>
      <MiniEngineBase>
        <TaskEngineSummaryText
          description={displayTask?.task_description}
          placeholder={isLocal ? "Local task engine" : "Corporation task engine"}
          active={state === "active"}
        />
        <div className="relative pt-px">
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
          <TaskStatusBadge state={state} label={stateLabels[state]} />
        </div>
      </MiniEngineBase>
      {taskId && (
        <div className="flex flex-col items-center justify-center shrink-0 py-ui-xs">
          <Button
            size="ui"
            variant="bland"
            className="shrink-0 h-full text-accent group-hover:text-foreground in-[.group\/subtle]:text-foreground border-l border-accent px-1.5 hover:text-terminal hover:bg-subtle-background hover:border-l-border"
            onClick={() => {
              if (!taskId) return
              setActivePanel("task_stream", taskId)
            }}
          >
            <CaretRightIcon weight="bold" size={14} className="size-3.5" />
          </Button>
        </div>
      )}
      {showDivider && <div className="absolute bottom-0 left-0 h-px w-3 bg-input" />}
    </div>
  )
}

export const MiniTaskEngines = () => {
  const { ships, localTaskId, corpSlotAssignments, displayedCorpSlots, showLockedPlaceholder } =
    useTaskState()

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex flex-col">
        <MiniEngine taskId={localTaskId ?? ""} isLocal />
        {Array.from({ length: displayedCorpSlots }, (_, index) => (
          <MiniEngine
            key={index}
            taskId={corpSlotAssignments?.[index] ?? ""}
            showDivider={index < 2}
          />
        ))}
      </div>
      {showLockedPlaceholder && (
        <MiniEnginePlaceholder
          label={
            !ships.data ?
              "join corporation for more slots"
            : `${displayedCorpSlots + 1} / 4 slots used`
          }
        />
      )}
    </div>
  )
}

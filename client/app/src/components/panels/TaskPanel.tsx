import { useEffect, useState } from "react"

import { format, parseISO } from "date-fns"
import { ArrowDownRightIcon, ArrowRightIcon } from "@phosphor-icons/react"

import { useTaskState } from "@/hooks/useTaskState"
import useGameStore from "@/stores/game"
import { formatDuration } from "@/utils/date"
import { cn } from "@/utils/tailwind"

import { DottedTitle } from "../DottedTitle"
import { PanelContentLoader } from "../PanelContentLoader"
import { Button } from "../primitives/Button"
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/Card"
import { Select, SelectTrigger } from "../primitives/Select"
import { ChevronSM } from "../svg/ChevronSM"
import { RHSPanelContent, RHSSubPanel } from "./RHSPanelContainer"

const formatTaskDate = (isoDate: string) => format(parseISO(isoDate), "yy.MM.dd HH:mm")

export const TaskHistoryRow = ({
  task,
  onTaskClick,
}: {
  task: TaskHistoryEntry
  onTaskClick: (task: TaskHistoryEntry) => void
}) => {
  const endStatusColor =
    task.end_status === "completed" ? "text-success"
    : task.end_status === "cancelled" ? "text-warning"
    : task.end_status === "failed" ? "text-destructive"
    : "text-subtle"

  return (
    <div className="flex flex-row items-center w-full min-w-0 gap-4 border-b border-accent pb-3">
      <div className="flex flex-col gap-1 w-full min-w-0 flex-1">
        <div className="flex flex-row gap-2 items-center">
          <span className="text-xxs font-bold text-foreground leading-none">
            {formatTaskDate(task.started)}
          </span>
          <ArrowRightIcon size={16} weight="bold" className="text-accent" />
          <span className="text-xxs font-bold text-foreground leading-none">
            {task.ended ? formatTaskDate(task.ended) : "—"}
          </span>
          {task.ended && (
            <span className="text-xxs font-semibold text-accent-foreground leading-none hidden @md/aside:block">
              [{formatDuration(task.started, task.ended)}]
            </span>
          )}
        </div>
        <div className="w-full">
          <span className="block text-xxs text-subtle leading-none truncate max-w-32 @md/aside:max-w-64 @lg/aside:max-w-86">
            {task.start_instructions}
          </span>
        </div>
      </div>
      <div className={cn("w-20 text-xs font-extrabold uppercase", endStatusColor)}>
        {task.end_status}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        className="bg-accent-background/50 text-foreground hover:bg-accent-background"
        onClick={() => onTaskClick(task)}
      >
        <ArrowDownRightIcon size={16} weight="bold" />
      </Button>
    </div>
  )
}

export const TaskInProgressRow = ({
  task,
  onTaskClick,
}: {
  task: ActiveTask
  onTaskClick: (task: ActiveTask) => void
}) => {
  return (
    <div className="flex flex-row items-center w-full min-w-0 gap-4 border-b border-accent pb-3">
      <div className="flex flex-col gap-1 w-full min-w-0 flex-1">
        <div className="flex flex-row gap-2 items-center">
          <span className="text-xxs font-bold text-foreground leading-none">
            {formatTaskDate(task.started_at)}
          </span>
          <ArrowRightIcon size={16} weight="bold" className="text-accent" />
          <span className="text-xxs text-terminal uppercase leading-none animate-pulse">
            In Progress
          </span>
        </div>
        <div className="w-full">
          <span className="block text-xxs text-subtle leading-none truncate max-w-32 @md/aside:max-w-64 @lg/aside:max-w-86">
            {task.task_description}
          </span>
        </div>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        className="bg-accent-background/50 text-foreground hover:bg-accent-background"
        onClick={() => onTaskClick(task)}
      >
        <ArrowDownRightIcon size={16} weight="bold" />
      </Button>
    </div>
  )
}

export const TaskPanel = () => {
  const { activeTasks, taskHistory, dispatchAction, numTaskEngines, numActiveTasks } =
    useTaskState()
  const activeSubPanel = useGameStore.use.activeSubPanel?.()
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()

  const [selectedTask, setSelectedTask] = useState<TaskHistoryEntry | ActiveTask | null>(null)

  useEffect(() => {
    if (!taskHistory) {
      dispatchAction({ type: "get-task-history", payload: { max_rows: 20 } })
    }
  }, [dispatchAction, taskHistory])

  return (
    <RHSPanelContent>
      <header className="flex flex-row gap-ui-sm p-ui-sm pb-0">
        <div className="p-3 bg-accent-background/60 bracket-subtle text-foreground flex-1 bracket bracket-offset-0 flex flex-col gap-1 items-center justify-center">
          <span className="text-xs font-semibold uppercase">Active Tasks</span>
          <span className="text-sm leading-none uppercase text-terminal">{numActiveTasks}</span>
        </div>
        <div className="p-3 bg-accent-background/60 bracket-subtle text-foreground flex-1 bracket bracket-offset-0 flex flex-col gap-1 items-center justify-center">
          <span className="text-xs font-semibold uppercase">Task Engines</span>
          <div className="text-sm leading-none uppercase text-terminal flex flex-row gap-2">
            <span className="text-terminal">{numTaskEngines}</span>
            <span className="text-subtle">/</span>
            <span className="text-muted-foreground">4</span>
          </div>
        </div>
        <div className="p-3 bg-accent-background/60 bracket-subtle text-foreground flex-1 bracket bracket-offset-0 flex flex-col gap-1 items-center justify-center">
          <span className="text-xs font-semibold uppercase">Engines free</span>
          <span className="text-sm leading-none uppercase text-terminal">
            {Math.max(numTaskEngines - numActiveTasks, 0)}
          </span>
        </div>
      </header>
      <Card
        size="sm"
        className={`border-x-0 ${activeSubPanel ? "overflow-hidden opacity-50" : ""}`}
      >
        <CardHeader>
          <CardTitle>Task History</CardTitle>
        </CardHeader>
        <CardContent
          className={`flex flex-col gap-ui-sm ${activeSubPanel ? "overflow-hidden" : ""}`}
        >
          <Select>
            <SelectTrigger variant="secondary" className="w-full">
              <div className="flex flex-row gap-2 items-center justify-center">
                Filter: <span className="text-foreground">All Ships</span>
              </div>
            </SelectTrigger>
          </Select>
          <div className="flex flex-row gap-2 items-center justify-center">
            <ChevronSM className="size-3 text-accent" />
            <ChevronSM className="size-3 text-accent" />
            <ChevronSM className="size-3 text-accent" />
            <ChevronSM className="size-3 text-accent" />
            <ChevronSM className="size-3 text-accent" />
          </div>
          <DottedTitle title="In Progress" />
          {Object.values(activeTasks ?? {}).length > 0 ?
            <div className="flex flex-col gap-3 w-full min-w-0">
              {Object.values(activeTasks ?? {}).map((task) => (
                <TaskInProgressRow
                  key={task.task_id}
                  task={task}
                  onTaskClick={(task) => {
                    setSelectedTask(task)
                    setActiveSubPanel("task-in-progress")
                  }}
                />
              ))}
            </div>
          : <div className="w-full bg-subtle-background items-center justify-center py-2 text-xs uppercase text-subtle text-center">
              No active tasks
            </div>
          }
          <DottedTitle title="Ended" />
          {taskHistory ?
            <div className="flex flex-col gap-3 w-full min-w-0">
              {taskHistory?.map((task) => (
                <TaskHistoryRow
                  key={task.task_id}
                  task={task}
                  onTaskClick={() => {
                    setSelectedTask(task)
                    setActiveSubPanel("task-history")
                  }}
                />
              ))}
            </div>
          : <PanelContentLoader className="mx-auto" />}
        </CardContent>
      </Card>

      <RHSSubPanel>
        <ul className="flex flex-col gap-2 text-xxs list-none">
          {Object.entries(selectedTask ?? {}).map(([key, value]) => (
            <li key={key} className="flex flex-col gap-0.5 border-b pb-2">
              <span className="text-foreground font-bold uppercase">{key}</span>{" "}
              <span className="text-subtle">{value?.toString()}</span>
            </li>
          ))}
        </ul>
      </RHSSubPanel>
    </RHSPanelContent>
  )
}

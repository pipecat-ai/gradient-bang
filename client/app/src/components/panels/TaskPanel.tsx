import { useEffect, useState } from "react"

import { format, parseISO } from "date-fns"
import { ArrowDownRightIcon, ArrowRightIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"
import { formatDuration } from "@/utils/date"
import { cn } from "@/utils/tailwind"

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

export const TaskPanel = () => {
  const activeTasks = useGameStore.use.activeTasks?.()
  const ships = useGameStore.use.ships?.()
  const taskHistory = useGameStore.use.task_history?.()
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const activeSubPanel = useGameStore.use.activeSubPanel?.()
  const setActiveSubPanel = useGameStore.use.setActiveSubPanel?.()

  const [selectedTask, setSelectedTask] = useState<TaskHistoryEntry | null>(null)

  const numTaskEngines = Math.min(Math.max((ships.data?.length ?? 0) - 1, 0), 4)
  const numActiveTasks = Object.keys(activeTasks ?? {}).length

  useEffect(() => {
    dispatchAction({ type: "get-task-history", payload: { max_rows: 20 } })
  }, [dispatchAction])

  return (
    <RHSPanelContent>
      <header className="flex flex-row gap-ui-sm p-ui-sm pb-0">
        <div className="p-2 bg-accent-background/60 bracket-subtle text-foreground flex-1 bracket bracket-offset-0 flex flex-col gap-1.5 items-center justify-center">
          <span className="text-xs font-semibold uppercase">Active Tasks</span>
          <span className="text-base leading-none uppercase text-terminal">{numActiveTasks}</span>
        </div>
        <div className="p-2 bg-accent-background/60 bracket-subtle text-foreground flex-1 bracket bracket-offset-0 flex flex-col gap-1.5 items-center justify-center">
          <span className="text-xs font-semibold uppercase">Task Engines</span>
          <div className="text-base leading-none uppercase text-terminal flex flex-row gap-2">
            <span className="text-terminal">{numTaskEngines}</span>
            <span className="text-subtle">/</span>
            <span className="text-muted-foreground">4</span>
          </div>
        </div>
        <div className="p-2 bg-accent-background/60 bracket-subtle text-foreground flex-1 bracket bracket-offset-0 flex flex-col gap-1.5 items-center justify-center">
          <span className="text-xs font-semibold uppercase">Engines free</span>
          <span className="text-base leading-none uppercase text-terminal">
            {numTaskEngines - numActiveTasks}
          </span>
        </div>
      </header>
      <Card
        size="sm"
        className={`border-r-0 ${activeSubPanel ? "overflow-hidden opacity-50" : ""}`}
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
          <div className="flex flex-row gap-ui-sm items-center justify-center leading-none">
            <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
            <span className="text-xs font-semibold uppercase text-subtle leading-none pb-px">
              In Progress
            </span>
            <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
          </div>
          <div className="w-full bg-subtle-background items-center justify-center py-2 text-xs uppercase text-subtle text-center">
            No active tasks
          </div>
          <div className="flex flex-row gap-ui-sm items-center justify-center leading-none">
            <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
            <span className="text-xs font-semibold uppercase text-subtle leading-none pb-px">
              Ended
            </span>
            <div className="flex-1 dotted-bg-xs text-accent h-3"></div>
          </div>
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

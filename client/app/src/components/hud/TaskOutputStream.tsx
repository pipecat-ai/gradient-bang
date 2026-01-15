import { useEffect, useRef, useState } from "react"

import { button, useControls } from "leva"
import { motion } from "motion/react"
import { faker } from "@faker-js/faker"

import { Card, CardContent } from "@/components/primitives/Card"
import { ScrollArea } from "@/components/primitives/ScrollArea"
import { Separator } from "@/components/primitives/Separator"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const MAX_TASK_SUMMARY_LENGTH = 100

const TaskTypeBadge = ({ type }: { type: Task["type"] }) => {
  return (
    <div
      className={cn(
        "uppercase font-extrabold text-center py-1 leading-none",
        type === "FAILED"
          ? "bg-warning text-warning-background"
          : type === "ACTION"
            ? "bg-warning-background text-warning-foreground"
            : type === "EVENT"
              ? "bg-fuel text-fuel-background"
              : type === "STEP"
                ? "bg-primary/30 text-primary border border-primary"
                : type === "COMPLETE"
                  ? "bg-success-background text-success-foreground"
                  : "bg-foreground text-background"
      )}
    >
      {type === "FAILED" ? "CANCELLED" : type}
    </div>
  )
}

const TaskCompleteRow = () => {
  return (
    <div className="flex flex-row gap-3 w-full select-none items-center justify-center py-3 last:pb-0">
      <Separator variant="dotted" className="flex-1 h-[5px]" />
      <div className="shrink-0 uppercase font-bold tracking-widest text-foreground text-xs">
        Task complete
      </div>
      <Separator variant="dotted" className="flex-1 h-[5px]" />
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
        <span className="text-cyan-400 font-semibold">{prefix}</span> {rest}
      </>
    )
  }

  return cleaned
}

const TaskRow = ({ task, className }: { task: Task; className?: string }) => {
  return (
    <div
      className={cn(
        "flex flex-row gap-4 w-full border-b border-white/20 last:border-b-0 py-2 last:pb-0 text-[10px] select-none",
        className
      )}
    >
      <div className="flex flex-row gap-3">
        <div className="w-16">
          <TaskTypeBadge type={task.type} />
        </div>
        <div className="normal-case flex-1">
          {formatTaskSummary(
            task.type === "FAILED" ? "Task cancelled" : task.summary
          )}
        </div>
      </div>
    </div>
  )
}

export const TaskOutputStreamComponent = ({ tasks }: { tasks: Task[] }) => {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [prevTasksLength, setPrevTasksLength] = useState(tasks.length)
  const [isIdle, setIsIdle] = useState(false)

  // Reset idle state when tasks change (during render, not in effect)
  if (tasks.length !== prevTasksLength) {
    setPrevTasksLength(tasks.length)
    setIsIdle(false)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [tasks.length])

  useEffect(() => {
    // Set a timer to fade out after 7500ms
    const timeoutId = setTimeout(() => {
      setIsIdle(true)
    }, 7500)

    return () => clearTimeout(timeoutId)
  }, [tasks.length])

  const visibleTasks = tasks.slice(-MAX_TASK_SUMMARY_LENGTH)

  return (
    <Card
      className="flex w-full bg-transparent border-none h-full min-h-0 overflow-hidden select-none pointer-events-none"
      size="none"
    >
      <CardContent className="relative flex flex-col gap-2 h-fulljustify-end mask-[linear-gradient(to_bottom,transparent_0%,black_30%,black_100%)] h-full">
        <ScrollArea
          className="w-full h-full overflow-hidden pointer-events-auto"
          fullHeight={true}
          classNames={{ scrollbar: "*:first:bg-white/30" }}
        >
          <motion.div
            className="h-full flex flex-col justify-end hover:opacity-100 select-none"
            animate={{ opacity: isIdle ? 0.25 : 1 }}
            transition={{
              duration: isIdle ? 1 : 0,
              ease: "easeOut",
            }}
          >
            <div>
              {visibleTasks.map((task) => {
                if (task.type === "COMPLETE") {
                  return <TaskCompleteRow key={task.id} />
                }
                return <TaskRow key={task.id} task={task} />
              })}
            </div>
            <div ref={bottomRef} className="h-0" />
          </motion.div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export const TaskOutputStream = () => {
  const tasks = useGameStore.use.tasks()
  const addTask = useGameStore.use.addTask()

  // #if DEV
  useControls(
    "Tasks",
    {
      ["Add Task"]: button(() => {
        addTask(faker.lorem.words({ min: 2, max: 5 }), "STEP")
      }),
    },
    { collapsed: true }
  )
  // #endif

  return <TaskOutputStreamComponent tasks={tasks} />
}

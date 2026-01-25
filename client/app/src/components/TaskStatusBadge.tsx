import { cva } from "class-variance-authority"

import { Badge } from "@/components/primitives/Badge"
import { TracingBorder } from "@/fx/TracingBorder"

import type { TaskEngineState } from "./panels/TaskEnginesPanel"

const stateStyles = cva("w-full duration-1000 text-xs -bracket-offset-1 bracket bracket-size-6", {
  variants: {
    state: {
      idle: "bg-muted/50 bracket-subtle text-subtle",
      active:
        "bracket-success bg-success-background text-success border-success stripe-bar stripe-bar-success/20 stripe-bar-8 stripe-bar-animate-1",
      completed: "bg-success-background/50 bracket-success border-success/50 text-success",
      cancelling:
        "bracket-destructive bg-destructive-background text-destructive border-destructive stripe-bar stripe-bar-destructive/20 stripe-bar-8 stripe-bar-animate-1",

      cancelled: "border-warning/50 text-warning bg-warning-background/50 bracket-warning/100",
      failed:
        "text-destructive bg-destructive-background/50 text-destructive border-destructive/50 bracket-destructive",
    },
  },
  defaultVariants: {
    state: "idle",
  },
})

const labelStyles = cva("font-extrabold uppercase", {
  variants: {
    state: {
      active: "text-success-foreground animate-pulse",
      idle: "text-foreground",
      completed: "text-success-foreground",
      cancelling: "text-destructive-foreground animate-pulse ",
      cancelled: "text-warning-foreground",
      failed: "text-destructive-foreground",
    },
  },
  defaultVariants: {
    state: "idle",
  },
})

export const TaskStatusBadge = ({ state, label }: { state: TaskEngineState; label: string }) => {
  return (
    <TracingBorder active={state === "active"}>
      <div className="flex flex-col gap-2">
        <Badge className={stateStyles({ state })}>
          <span>Engine status:</span>
          <span className={labelStyles({ state })}>{label}</span>
        </Badge>
      </div>
    </TracingBorder>
  )
}

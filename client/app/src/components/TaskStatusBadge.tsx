import { useEffect, useRef, useState } from "react"

import { cva } from "class-variance-authority"

import { Badge } from "@/components/primitives/Badge"
import { TracingBorder } from "@/fx/TracingBorder"
import { cn } from "@/utils/tailwind"

import type { TaskEngineState } from "./panels/TaskEnginesPanel"

const stateStyles = cva("w-full duration-1000 text-xs -bracket-offset-1 bracket bracket-size-6", {
  variants: {
    state: {
      idle: "bg-muted/50 bracket-subtle text-subtle",
      active:
        "bracket-success/0 bg-success-background text-success border-success stripe-bar stripe-bar-success/20 stripe-bar-8 stripe-bar-animate-1",
      steering:
        "bracket-fuel bg-fuel-background text-fuel border-fuel stripe-bar stripe-bar-fuel/20 stripe-bar-8 stripe-bar-animate-1",
      completed: "bg-success-background/50 bracket-success border-success/60 text-success",
      cancelling:
        "bracket-destructive bg-destructive-background text-destructive border-destructive stripe-bar stripe-bar-destructive/20 stripe-bar-8 stripe-bar-animate-1",

      cancelled: "border-warning/50 text-warning bg-warning-background/60 bracket-warning/100",
      failed:
        "text-destructive bg-destructive-background/50 text-destructive border-destructive/60 bracket-destructive",
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
      steering: "text-fuel-foreground animate-pulse",
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
  // Track the last state the effect observed so we only trigger the blink
  // animation on genuine transitions. Using useRef(state) seeds the initial
  // value with whatever state the badge mounted with, so the first effect
  // call is a no-op (prev === current). Any later re-render with a
  // different state — including the brief hydration churn on first join
  // (e.g., cached "completed" summary → resolved "idle") — is detected as
  // a true change and fires the animation exactly once.
  const prevStateRef = useRef<TaskEngineState>(state)
  const changeCountRef = useRef(0)
  const [animationKey, setAnimationKey] = useState<string | null>(null)

  useEffect(() => {
    if (prevStateRef.current === state) {
      return
    }
    prevStateRef.current = state
    if (state !== "active") {
      changeCountRef.current += 1
      setAnimationKey(`${state}-${changeCountRef.current}`)
    }
  }, [state])

  return (
    <div
      key={animationKey}
      className={cn(
        animationKey && state !== "active" && state !== "cancelling" && "animate-blink repeat-3"
      )}
    >
      <TracingBorder active={state === "active" || state === "steering"}>
        <div className="flex flex-col gap-2">
          <Badge className={stateStyles({ state })}>
            <span>Engine status:</span>
            <span className={labelStyles({ state })}>{label}</span>
          </Badge>
        </div>
      </TracingBorder>
    </div>
  )
}

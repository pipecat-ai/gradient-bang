"use client"

import * as React from "react"

import { cva, type VariantProps } from "class-variance-authority"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/utils/tailwind"

const progressVariants = cva("relative min-w-10 h-2 overflow-hidden w-full", {
  variants: {
    color: {
      primary: "bg-primary/20",
      secondary: "bg-secondary/20",
      destructive: "bg-destructive/20",
      warning: "bg-warning/20",
      success: "bg-success/20",
      fuel: "bg-fuel/20",
      terminal: "bg-terminal/20",
    },
  },
  defaultVariants: {
    color: "primary",
  },
})

const indicatorColorVariants = {
  primary: "bg-primary",
  secondary: "bg-secondary",
  destructive: "bg-destructive",
  warning: "bg-warning",
  success: "bg-success",
  fuel: "bg-fuel",
  terminal: "bg-terminal",
} as const

const clampValue = (val?: number | null) => {
  if (val == null || typeof val !== "number" || Number.isNaN(val)) {
    return 0
  }

  return Math.min(100, Math.max(0, val))
}

const SEGMENT_TRANSITION_FALLBACK_MS = 1200

type SegmentState = {
  start: number
  end: number
  id: number
}

type ProgressClassNames = {
  indicator?: string
  increment?: string
  decrement?: string
}

function Progress({
  className,
  value,
  color = "primary",
  segmented = false,
  segmentHoldMs = 1200,
  classNames,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof progressVariants> & {
    segmented?: boolean
    segmentHoldMs?: number
    classNames?: ProgressClassNames
  }) {
  const {
    indicator: classNameIndicator,
    increment: classNameIncrement,
    decrement: classNameDecrement,
  } = classNames ?? {}
  const normalizedValue = clampValue(value)
  const [displayValue, setDisplayValue] = React.useState<number>(normalizedValue)
  const [segmentState, setSegmentState] = React.useState<SegmentState | null>(null)
  const pendingTimeoutRef = React.useRef<number | null>(null)
  const transitionFallbackRef = React.useRef<number | null>(null)
  const pendingRemovalIdRef = React.useRef<number | null>(null)
  const segmentIdRef = React.useRef(0)
  const indicatorRef = React.useRef<HTMLDivElement | null>(null)

  const indicatorColorClass =
    indicatorColorVariants[color ?? "primary"] ?? indicatorColorVariants.primary

  const clearSegmentById = React.useCallback((segmentId: number) => {
    setSegmentState((segment) => (segment && segment.id === segmentId ? null : segment))
  }, [])

  React.useEffect(() => {
    return () => {
      if (pendingTimeoutRef.current !== null) {
        window.clearTimeout(pendingTimeoutRef.current)
      }
      if (transitionFallbackRef.current !== null) {
        window.clearTimeout(transitionFallbackRef.current)
      }
      pendingRemovalIdRef.current = null
    }
  }, [])

  React.useEffect(() => {
    const indicatorElement = indicatorRef.current
    if (!indicatorElement) {
      return undefined
    }

    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "transform") {
        return
      }

      const pendingId = pendingRemovalIdRef.current
      if (pendingId == null) {
        return
      }

      pendingRemovalIdRef.current = null

      if (transitionFallbackRef.current !== null) {
        window.clearTimeout(transitionFallbackRef.current)
        transitionFallbackRef.current = null
      }

      clearSegmentById(pendingId)
    }

    indicatorElement.addEventListener("transitionend", handleTransitionEnd)

    return () => {
      indicatorElement.removeEventListener("transitionend", handleTransitionEnd)
    }
  }, [clearSegmentById])

  React.useEffect(() => {
    if (!segmented) {
      if (pendingTimeoutRef.current !== null) {
        window.clearTimeout(pendingTimeoutRef.current)
        pendingTimeoutRef.current = null
      }
      if (transitionFallbackRef.current !== null) {
        window.clearTimeout(transitionFallbackRef.current)
        transitionFallbackRef.current = null
      }
      pendingRemovalIdRef.current = null

      setSegmentState(null)
      setDisplayValue(normalizedValue)
      return
    }

    if (normalizedValue === displayValue) {
      return
    }

    if (pendingTimeoutRef.current !== null) {
      window.clearTimeout(pendingTimeoutRef.current)
      pendingTimeoutRef.current = null
    }
    if (transitionFallbackRef.current !== null) {
      window.clearTimeout(transitionFallbackRef.current)
      transitionFallbackRef.current = null
    }
    pendingRemovalIdRef.current = null

    segmentIdRef.current += 1
    const currentSegmentId = segmentIdRef.current

    setSegmentState({
      start: displayValue,
      end: normalizedValue,
      id: currentSegmentId,
    })

    pendingTimeoutRef.current = window.setTimeout(() => {
      setDisplayValue(normalizedValue)
      pendingRemovalIdRef.current = currentSegmentId
      pendingTimeoutRef.current = null

      transitionFallbackRef.current = window.setTimeout(() => {
        if (pendingRemovalIdRef.current !== currentSegmentId) {
          return
        }

        pendingRemovalIdRef.current = null
        clearSegmentById(currentSegmentId)
        transitionFallbackRef.current = null
      }, SEGMENT_TRANSITION_FALLBACK_MS)
    }, segmentHoldMs)
  }, [segmented, normalizedValue, segmentHoldMs, displayValue, clearSegmentById])

  const indicatorValue = segmented ? displayValue : normalizedValue
  const pendingSegment =
    segmented && segmentState && segmentState.start !== segmentState.end ?
      {
        start: Math.min(segmentState.start, segmentState.end),
        width: Math.ceil(Math.abs(segmentState.end - segmentState.start)),
        direction: segmentState.end > segmentState.start ? "increment" : "decrement",
      }
    : null

  const segmentDirectionClassName =
    pendingSegment?.direction === "increment" ? classNameIncrement
    : pendingSegment?.direction === "decrement" ? classNameDecrement
    : undefined

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(progressVariants({ color }), className)}
      {...props}
    >
      {indicatorValue > 0 && (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          ref={indicatorRef}
          style={{ transform: `translateX(-${100 - indicatorValue}%)` }}
          className={cn("h-full flex-1 transition-all", indicatorColorClass, classNameIndicator)}
        />
      )}
      {pendingSegment ?
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 z-10 transition-all",
            indicatorColorClass,
            segmentDirectionClassName
          )}
          style={{
            left: `${pendingSegment.start}%`,
            width: `${pendingSegment.width}%`,
          }}
        />
      : null}
    </ProgressPrimitive.Root>
  )
}

export { Progress }

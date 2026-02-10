import { useEffect, useState } from "react"

import { cn } from "@/utils/tailwind"

import { Progress } from "./primitives/Progress"

const DEFAULT_ROUND_MS = 30_000

export const CombatRoundTimer = ({
  deadline,
  currentTime,
  combatId,
  round,
  noTimer = false,
}: {
  deadline: string | null | undefined
  currentTime: string | null | undefined
  combatId: string | null | undefined
  round: number | null | undefined
  noTimer: boolean
}) => {
  const [tickNow, setTickNow] = useState(0)

  useEffect(() => {
    if (!deadline) return
    const timerId = window.setInterval(() => setTickNow(Date.now()), 250)
    return () => window.clearInterval(timerId)
  }, [combatId, round, deadline])

  const deadlineMs = deadline ? Date.parse(deadline) : NaN
  const currentMs = currentTime ? Date.parse(currentTime) : NaN
  const totalMs =
    Number.isFinite(deadlineMs) && Number.isFinite(currentMs) && deadlineMs > currentMs ?
      deadlineMs - currentMs
    : DEFAULT_ROUND_MS
  const remainingMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - tickNow) : 0
  const percent = deadline ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0
  const timeRemaining = Math.ceil(remainingMs / 1000).toString()

  const timerColor =
    percent > 66 ? ("success" as const)
    : percent > 33 ? ("warning" as const)
    : percent > 0 ? ("destructive" as const)
    : ("subtle" as const)

  const shouldPulse = percent < 33 && percent > 0

  return (
    <div className="relative flex-1 bg-background/80 combat-tile select-none">
      <div className="absolute inset-y-0 flex flex-row items-center leading-none left-1/2 -translate-x-1/2 z-10 uppercase text-xs">
        <div
          className={cn(
            "bg-background/20 inline-flex gap-1 py-0.5 px-1",
            shouldPulse && "animate-blink"
          )}
        >
          {percent > 0 ?
            <>
              <span className="font-bold">{noTimer ? "No Deadline" : timeRemaining || "0"}</span>
              <span className="text-foreground/80">seconds remaining</span>
            </>
          : <span className="font-bold">Round Over</span>}
        </div>
      </div>
      <Progress value={percent} color={timerColor} className="h-7" smooth />
    </div>
  )
}

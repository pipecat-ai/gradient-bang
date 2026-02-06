import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { StarIcon } from "@phosphor-icons/react"

import { ScrambleText, type ScrambleTextRef } from "@/fx/ScrambleText"
import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

import { Divider } from "./primitives/Divider"
import { DotDivider } from "./primitives/DotDivider"

/** Delay before showing banner when entering a new sector */
const DELAY_BEFORE_SHOW = 1500
/** How long the banner stays visible */
const DISPLAY_DURATION = 3000

const ANIMATE_IN = { opacity: 1, transition: { duration: 0.4, ease: "easeOut" } } as const
const ANIMATE_OUT = { opacity: 0, transition: { duration: 2, ease: "easeOut" } } as const

type Phase = "idle" | "delaying" | "showing" | "exiting"

export const SectorTitleBanner = () => {
  const playSound = useAudioStore.use.playSound()
  const activeTasks = useGameStore.use.activeTasks?.()
  const sector = useGameStore.use.sector?.()

  // UI state
  const [isShowing, setIsShowing] = useState(false)
  const scrambleRef = useRef<ScrambleTextRef>(null)

  // State machine & timers
  const phaseRef = useRef<Phase>("idle")
  const timersRef = useRef<{ delay: number | null; show: number | null }>({
    delay: null,
    show: null,
  })

  // Sector tracking
  const prevSectorIdRef = useRef<number | undefined>(undefined)
  const sectorBeforeTaskRef = useRef<number | undefined>(undefined)
  const wasTaskActiveRef = useRef(false)

  // Derived state
  const hasActiveTask = useMemo(
    () => Object.values(activeTasks ?? {}).some((task) => task?.task_scope === "player_ship"),
    [activeTasks]
  )

  const shouldDisplay = sector?.id !== undefined && !hasActiveTask
  const sectorText = `SECTOR ${sector?.id ?? "unknown"}`

  // Timer management
  const clearTimers = useCallback(() => {
    if (timersRef.current.delay !== null) {
      clearTimeout(timersRef.current.delay)
      timersRef.current.delay = null
    }
    if (timersRef.current.show !== null) {
      clearTimeout(timersRef.current.show)
      timersRef.current.show = null
    }
  }, [])

  // Phase transitions
  const startExit = useCallback(() => {
    phaseRef.current = "exiting"
    scrambleRef.current?.scrambleOut()
    setIsShowing(false)
  }, [])

  const resetShowTimer = useCallback(() => {
    if (timersRef.current.show !== null) {
      clearTimeout(timersRef.current.show)
    }
    timersRef.current.show = window.setTimeout(startExit, DISPLAY_DURATION)
  }, [startExit])

  const show = useCallback(() => {
    clearTimers()
    phaseRef.current = "showing"
    setIsShowing(true)
    timersRef.current.show = window.setTimeout(startExit, DISPLAY_DURATION)
  }, [clearTimers, startExit])

  const startDelay = useCallback(() => {
    clearTimers()
    phaseRef.current = "delaying"
    timersRef.current.delay = window.setTimeout(show, DELAY_BEFORE_SHOW)
  }, [clearTimers, show])

  const hide = useCallback(() => {
    clearTimers()
    phaseRef.current = "idle"
    scrambleRef.current?.scrambleOut()
    setIsShowing(false)
  }, [clearTimers])

  const onExitComplete = useCallback(() => {
    // Only transition to idle if still in exiting phase (might have been interrupted)
    if (phaseRef.current === "exiting") {
      phaseRef.current = "idle"
    }
  }, [])

  // Play sound when banner first appears
  useEffect(() => {
    if (isShowing) {
      playSound("text", { volume: 0.1 })
    }
  }, [isShowing, playSound])

  // Track task transitions - show banner when task ends if sector changed
  useEffect(() => {
    const wasTaskActive = wasTaskActiveRef.current
    wasTaskActiveRef.current = hasActiveTask

    if (hasActiveTask && !wasTaskActive) {
      // Task started - record current sector
      sectorBeforeTaskRef.current = sector?.id
    } else if (!hasActiveTask && wasTaskActive) {
      // Task ended - show banner if sector changed during task
      const sectorChanged = sector?.id !== sectorBeforeTaskRef.current
      sectorBeforeTaskRef.current = undefined

      if (sectorChanged && sector?.id !== undefined && phaseRef.current === "idle") {
        queueMicrotask(startDelay)
      }
    }
  }, [hasActiveTask, sector?.id, startDelay])

  // Hide banner when shouldDisplay becomes false
  useEffect(() => {
    if (!shouldDisplay) {
      queueMicrotask(hide)
    }
  }, [shouldDisplay, hide])

  // Handle sector changes while no task is active (including initial load)
  useEffect(() => {
    const prevSectorId = prevSectorIdRef.current
    const isInitialLoad = prevSectorId === undefined
    prevSectorIdRef.current = sector?.id

    // Skip if unchanged, task is active, or task just ended (handled by task effect)
    if (prevSectorId === sector?.id || hasActiveTask || sectorBeforeTaskRef.current !== undefined) {
      return
    }

    if (!shouldDisplay) return

    if (phaseRef.current === "showing") {
      // Already showing - reset timer, text auto-scrambles
      resetShowTimer()
    } else if (isInitialLoad) {
      // First load - show with delay
      queueMicrotask(startDelay)
    } else {
      // Sector change while not showing - show immediately
      queueMicrotask(show)
    }
  }, [sector?.id, hasActiveTask, shouldDisplay, show, startDelay, resetShowTimer])

  // Cleanup on unmount
  useEffect(() => clearTimers, [clearTimers])

  const showSubBadge =
    (sector && sector.players && sector.players.length > 0) || (sector && sector.port)
  return (
    <AnimatePresence onExitComplete={onExitComplete}>
      {isShowing && (
        <motion.div
          key="sector-banner"
          initial={{ opacity: 0 }}
          animate={ANIMATE_IN}
          exit={ANIMATE_OUT}
          className="w-full absolute left-0 top-1/2 -translate-y-1/2 z-20 pointer-events-none"
        >
          <div className="flex flex-row gap-5 text-center justify-center items-center mx-auto w-max bg-background/70 p-2">
            <div className="dotted-bg-sm dotted-bg-white/60 self-stretch w-[160px]" />
            <p className="text-white text-lg font-bold uppercase tracking-wider leading-none">
              <ScrambleText ref={scrambleRef}>{sectorText}</ScrambleText>
            </p>
            <div className="dotted-bg-sm dotted-bg-subtle self-stretch w-[160px]" />
          </div>
          {showSubBadge && (
            <div className="flex flex-row w-fit mx-auto gap-3 items-center text-sm font-semibold uppercase mt-2 px-2 py-0.5 text-subtle-foreground bg-accent-background/70">
              <Divider className="w-8 bg-subtle" />
              {sector.players && sector.players.length > 0 && (
                <>
                  <span>{sector.players?.length ?? 0} Ships</span>
                  <DotDivider className="bg-subtle" />
                </>
              )}
              {sector.port && (
                <>
                  <span className={sector.port?.mega ? "text-fuel" : "text-terminal"}>
                    {sector.port?.mega ? "Mega" : ""} {sector.port?.code} Port
                  </span>
                </>
              )}
              <Divider className="w-8 bg-subtle" />
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

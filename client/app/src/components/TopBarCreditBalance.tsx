import { useCallback, useEffect, useRef, useState } from "react"

import type { AnimationPlaybackControls } from "motion/react"
import { animate, AnimatePresence, motion, useMotionValue } from "motion/react"
import { HandCoinsIcon, VaultIcon } from "@phosphor-icons/react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { formatCurrency } from "@/utils/formatting"
import { cn } from "@/utils/tailwind"

import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/ToolTip"

// Track all active animation controls so we know when everything has truly stopped
const activeControls = new Set<AnimationPlaybackControls>()
let soundSafetyTimer: ReturnType<typeof setTimeout> | null = null
const SOUND_SAFETY_TIMEOUT = 5000

function startSound(firstAnimation: boolean) {
  useAudioStore
    .getState()
    .playSound("currency", { loop: true, once: true, delay: firstAnimation ? 400 : 0, volume: 0.6 })

  if (soundSafetyTimer) clearTimeout(soundSafetyTimer)
  soundSafetyTimer = setTimeout(() => {
    useAudioStore.getState().stopSound("currency")
  }, SOUND_SAFETY_TIMEOUT)
}

function stopSoundIfIdle() {
  if (activeControls.size === 0) {
    useAudioStore.getState().stopSound("currency")
    if (soundSafetyTimer) {
      clearTimeout(soundSafetyTimer)
      soundSafetyTimer = null
    }
  }
}

const useBalanceAnimation = (balance: number | undefined) => {
  const value = useMotionValue(balance ?? 0)
  const [state, setState] = useState({
    displayValue: balance ?? 0,
    settledBalance: balance ?? 0,
    isAnimating: false,
    direction: null as "up" | "down" | null,
    bubbles: [] as { id: number; delta: number }[],
  })
  const controls = useRef<AnimationPlaybackControls | null>(null)
  const hasReceivedRealValue = useRef(false)
  const prevBalance = useRef(balance ?? 0)

  useEffect(
    () => value.on("change", (v) => setState((prev) => ({ ...prev, displayValue: Math.round(v) }))),
    [value]
  )

  useEffect(() => {
    if (balance == null) return
    if (!hasReceivedRealValue.current) {
      hasReceivedRealValue.current = true
      prevBalance.current = balance
      value.set(balance)
      queueMicrotask(() =>
        setState((prev) => ({ ...prev, displayValue: balance, settledBalance: balance }))
      )
      return
    }
    if (balance === value.get()) return
    const delta = balance - prevBalance.current
    const direction = delta > 0 ? "up" : "down"
    prevBalance.current = balance
    const alreadyAnimating = !!controls.current
    const bubble = { id: Date.now(), delta: Math.round(delta) }
    queueMicrotask(() =>
      setState((prev) => ({
        ...prev,
        isAnimating: true,
        direction,
        bubbles: [...prev.bubbles, bubble],
      }))
    )

    const absDelta = Math.abs(delta)
    const duration = Math.min(3, Math.max(0.5, Math.log10(absDelta + 1) * 0.6))

    if (controls.current) activeControls.delete(controls.current)
    controls.current?.stop()

    const firstAnimation = activeControls.size === 0
    const anim = animate(value, balance, {
      duration: alreadyAnimating ? Math.min(duration, 0.5) : duration,
      delay: alreadyAnimating ? 0 : 0.25,
      ease: [0.4, 0, 0.2, 1],
      onComplete: () => {
        activeControls.delete(anim)
        controls.current = null
        stopSoundIfIdle()
        setState((prev) => ({
          ...prev,
          isAnimating: false,
          settledBalance: balance,
          direction: null,
        }))
      },
    })
    activeControls.add(anim)
    controls.current = anim
    startSound(firstAnimation)
  }, [balance, value])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (controls.current) {
        activeControls.delete(controls.current)
        controls.current.stop()
        controls.current = null
        stopSoundIfIdle()
      }
    }
  }, [])

  const removeBubble = useCallback(
    (id: number) =>
      setState((prev) => ({ ...prev, bubbles: prev.bubbles.filter((b) => b.id !== id) })),
    []
  )

  return { ...state, removeBubble }
}

const DeltaBubble = ({ delta, onDone }: { delta: number; onDone: () => void }) => (
  <motion.span
    className={cn(
      "absolute left-1/2 -translate-x-1/2 top-1/2 text-xxs font-bold whitespace-nowrap pointer-events-none",
      delta > 0 ? "text-success-foreground" : "text-warning-foreground"
    )}
    initial={{ y: 0, opacity: 1 }}
    animate={{ y: 30, opacity: 0 }}
    transition={{
      y: { duration: 1.2, ease: [0.2, 0, 0.2, 1] },
      opacity: { duration: 1.2, ease: [0.4, 0, 1, 1], delay: 0.3 },
    }}
    onAnimationComplete={onDone}
  >
    {delta > 0 ? "+" : ""}
    {formatCurrency(delta, "standard")}
  </motion.span>
)

const BalanceItem = ({
  label,
  balance,
  settledBalance,
  displayValue,
  expanded,
  direction,
  bubbles,
  onBubbleDone,
  Icon,
}: {
  label: string
  balance: number | undefined
  settledBalance: number
  displayValue: number
  expanded: boolean
  direction: "up" | "down" | null
  bubbles: { id: number; delta: number }[]
  onBubbleDone: (id: number) => void
  Icon: React.ElementType
}) => {
  const directionColor =
    direction === "up" ? "text-success"
    : direction === "down" ? "text-warning"
    : ""

  const content = (
    <div
      className={cn(
        "relative flex flex-col justify-center gap-1 text-xs uppercase w-28 h-full p-ui-xs transition-[color,background-color] duration-300 bg-transparent",
        direction === "up" ? "bg-success-background/50"
        : direction === "down" ? "bg-warning-background/50"
        : null
      )}
      data-tutorial="credits"
    >
      <AnimatePresence>
        {bubbles.map((b) => (
          <DeltaBubble key={b.id} delta={b.delta} onDone={() => onBubbleDone(b.id)} />
        ))}
      </AnimatePresence>
      <span
        className={cn(
          "truncate leading-none text-xxs",
          direction ? "animate-blink text-white" : "text-subtle-foreground"
        )}
      >
        {label}
      </span>{" "}
      <AnimatePresence mode="wait" initial={false}>
        {expanded ?
          <motion.span
            key="counting"
            className={cn(
              "font-semibold truncate tabular-nums flex flex-row items-center gap-1.5 leading-none tracking-tight transition-colors duration-300",
              directionColor
            )}
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Icon size={14} weight="bold" />
            {formatCurrency(displayValue, "standard")}
          </motion.span>
        : <motion.span
            key="settled"
            className="text-white font-semibold truncate tabular-nums flex flex-row items-center gap-1.5 leading-none tracking-tight"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            <Icon size={14} weight="bold" />
            {formatCurrency(settledBalance)}
          </motion.span>
        }
      </AnimatePresence>
    </div>
  )

  if (balance == null) return content

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{formatCurrency(balance, "standard")} CR</TooltipContent>
    </Tooltip>
  )
}

export const TopBarCreditBalance = () => {
  const player = useGameStore.use.player()
  const ship = useGameStore.use.ship()

  const bank = useBalanceAnimation(player?.credits_in_bank)
  const hand = useBalanceAnimation(ship?.credits)
  const anyAnimating = bank.isAnimating || hand.isAnimating

  const [expanded, setExpanded] = useState(false)
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (anyAnimating) {
      if (restTimer.current) clearTimeout(restTimer.current)
      restTimer.current = null
      queueMicrotask(() => setExpanded(true))
    } else if (expanded) {
      restTimer.current = setTimeout(() => setExpanded(false), 2000)
    }
    return () => {
      if (restTimer.current) clearTimeout(restTimer.current)
    }
  }, [anyAnimating, expanded])

  return (
    <motion.div
      className={cn(
        "absolute z-90 bg-subtle-background inset-y-0 left-1/2 -translate-x-1/2 flex items-center origin-top h-12",
        "elbows-bottom elbow-white elbow-2 elbow-size-12 elbow-offset-5",
        "border border-t-0 transition-colors duration-300",
        "[&>*+*]:border-l [&>*+*]:border-border [&>*+*]:transition-[border-color] [&>*+*]:duration-300",
        expanded ?
          "border-subtle-foreground [&>*+*]:border-subtle-foreground pointer-events-none shadow-lg shadow-black/60"
        : ""
      )}
      animate={{ scale: expanded ? 1.2 : 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      <BalanceItem
        label="Bank"
        balance={player?.credits_in_bank}
        settledBalance={bank.settledBalance}
        displayValue={bank.displayValue}
        expanded={expanded}
        direction={bank.direction}
        bubbles={bank.bubbles}
        onBubbleDone={bank.removeBubble}
        Icon={VaultIcon}
      />
      <BalanceItem
        label="On Hand"
        balance={ship?.credits}
        settledBalance={hand.settledBalance}
        displayValue={hand.displayValue}
        expanded={expanded}
        direction={hand.direction}
        bubbles={hand.bubbles}
        onBubbleDone={hand.removeBubble}
        Icon={HandCoinsIcon}
      />
    </motion.div>
  )
}

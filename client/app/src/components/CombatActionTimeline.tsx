import { useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/utils/tailwind"

import { AttackActionLG } from "./svg/AttackActionLG"
import { FleeActionLG } from "./svg/FleeActionLG"
import { ShieldActionLG } from "./svg/ShieldActionLG"

const MAX_HISTORY = 10

const ACTION_ICON: Record<string, React.FC<{ className?: string }>> = {
  ATTACK: AttackActionLG,
  BRACE: ShieldActionLG,
  FLEE: FleeActionLG,
  PAY: ShieldActionLG,
}

const ACTION_LABEL: Record<string, string> = {
  ATTACK: "ATK",
  BRACE: "BRC",
  FLEE: "FLE",
  PAY: "PAY",
}

type HistoryEntry = { round: number; action: string }

interface CombatActionTimelineProps {
  round: number | null
  action: string | null
}

export const CombatActionTimeline = ({ round, action }: CombatActionTimelineProps) => {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [lastTrackedRound, setLastTrackedRound] = useState<number | null>(null)

  // Only append when we see a new round number
  if (round != null && action && round !== lastTrackedRound) {
    setLastTrackedRound(round)
    setHistory((prev) => {
      const next = [...prev.filter((e) => e.round !== round), { round, action }]
      return next.slice(-MAX_HISTORY)
    })
  }

  return (
    <div className="flex items-center gap-ui-xxs px-ui-xs overflow-hidden h-10">
      <AnimatePresence initial={false}>
        {history.map((entry, i) => {
          const Icon = ACTION_ICON[entry.action]
          const label = ACTION_LABEL[entry.action] ?? entry.action
          const isLatest = i === history.length - 1

          return (
            <motion.div
              key={entry.round}
              initial={{ opacity: 0, scale: 0.5, width: 0 }}
              animate={{ opacity: isLatest ? 1 : 0.4, scale: 1, width: "auto" }}
              exit={{ opacity: 0, scale: 0.5, width: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className={cn(
                "flex flex-col items-center gap-0.5 shrink-0",
                isLatest ? "text-terminal-foreground" : "text-subtle-foreground",
              )}
            >
              {Icon && <Icon className="size-5" />}
              <span className="text-xxs uppercase font-bold leading-none">{label}</span>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

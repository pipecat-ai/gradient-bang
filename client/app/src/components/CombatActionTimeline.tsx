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
    <div className="flex items-center justify-center overflow-hidden h-10 w-full px-ui-xs py-ui-xxs">
      <AnimatePresence initial={false}>
        {history.map((entry, i) => {
          const Icon = ACTION_ICON[entry.action]
          const isLatest = i === history.length - 1

          return (
            <motion.div
              key={entry.round}
              initial={{ opacity: 0, width: 0, marginLeft: 0, marginRight: 0 }}
              animate={{ opacity: 1, width: 36, marginLeft: 2, marginRight: 2 }}
              exit={{ opacity: 0, width: 0, marginLeft: 0, marginRight: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className="overflow-hidden shrink-0"
            >
              <div
                className={cn(
                  "flex items-center justify-center w-8 h-8",
                  isLatest ? "bg-foreground" : "bg-background/60"
                )}
              >
                {Icon && (
                  <Icon
                    className={cn(
                      "size-6",
                      isLatest ? "text-background" : "text-subtle-foreground opacity-70"
                    )}
                  />
                )}
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

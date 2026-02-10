import { useState } from "react"

import { motion } from "motion/react"

import useGameStore from "@/stores/game"
import { getStatusTone } from "@/utils/combat"
import { cn } from "@/utils/tailwind"

const clampedPercent = (p: number) => Math.min(100, Math.max(0, p))

const BaseTile = ({ percent = 100 }: { percent: number }) => {
  const tone = getStatusTone(percent)
  const heightPercent = clampedPercent(percent)
  const [isFirstMount, setIsFirstMount] = useState(true)

  return (
    <div className="bg-background h-full p-[4px] outline outline-subtle -outline-offset-4 border-3 border-background">
      <div
        className={cn(
          "relative items-center justify-center flex-1 h-full ",
          `bg-${tone}-background`
        )}
      >
        <motion.div
          className={cn("absolute inset-x-0 bottom-0", `bg-${tone}`)}
          initial={isFirstMount ? { height: "0%" } : false}
          animate={{ height: `${heightPercent}%` }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
            delay: isFirstMount ? 3 : 0,
          }}
          onAnimationComplete={() => isFirstMount && setIsFirstMount(false)}
        />
      </div>
    </div>
  )
}

export const CombatFighterTile = () => {
  const ship = useGameStore((state) => state.ship)
  const percent = (ship.fighters ?? 0) / (ship.max_fighters ?? 0)

  return <BaseTile percent={percent * 100} />
}

export const CombatShieldTile = () => {
  const ship = useGameStore((state) => state.ship)
  const percent = (ship.shields ?? 0) / (ship.max_shields ?? 0)

  return <BaseTile percent={percent * 100} />
}

import { useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { UserIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

import { Badge } from "./primitives/Badge"
import { ChevronSM } from "./svg/ChevronSM"

const ANIMATION_DURATION = 5600

export const CharacterBadge = () => {
  const setActivePanel = useGameStore.use.setActivePanel()
  const setNotifications = useGameStore.use.setNotifications()
  const player = useGameStore.use.player()
  const [showRankUp, setShowRankUp] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return useGameStore.subscribe((state, prevState) => {
      if (state.notifications.rankChanged && !prevState.notifications.rankChanged) {
        if (timerRef.current) clearTimeout(timerRef.current)
        setShowRankUp(true)
        timerRef.current = setTimeout(() => {
          setShowRankUp(false)
          setNotifications({ rankChanged: false })
        }, ANIMATION_DURATION)
      }
    })
  }, [setNotifications])

  return (
    <button onClick={() => setActivePanel("player")} className="group">
      <Badge
        variant="secondary"
        size="sm"
        border="bracket"
        className={`h-8 bracket-size-8 px-2 group-hover:bg-subtle-background group-hover:bracket-foreground text-white group-hover:text-terminal relative transition-colors ${showRankUp ? "bracket-terminal-foreground" : ""}`}
      >
        <AnimatePresence>
          {showRankUp && (
            <>
              {/* Green fill — top down in, then slides down out */}
              <motion.div
                className="absolute inset-0 bg-terminal-background"
                animate={{
                  clipPath: [
                    "inset(0 0 100% 0)",
                    "inset(0 0 0% 0)",
                    "inset(0 0 0% 0)",
                    "inset(100% 0 0 0)",
                  ],
                }}
                transition={{
                  duration: 3.2,
                  times: [0, 0.09, 0.91, 1],
                  ease: "easeInOut",
                }}
              />

              {/* Chevron — enters from bottom, pauses, exits up */}
              <motion.div
                className="absolute inset-0 flex items-center justify-center text-terminal z-10"
                animate={{
                  y: [24, 0, 0, -24],
                  opacity: [0, 1, 1, 0],
                }}
                transition={{
                  duration: 3.2,
                  times: [0, 0.19, 0.81, 1],
                  ease: "easeInOut",
                }}
              >
                <ChevronSM className="rotate-180 size-3.5" />
              </motion.div>

              {/* "RANK UP" — blinks 4 times after chevron exits */}
              <motion.span
                className="absolute inset-0 flex items-center justify-center text-xxs font-bold tracking-widest text-terminal z-20"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                  delay: 3.2,
                  duration: 0.15,
                  repeat: 7,
                  repeatType: "reverse",
                  repeatDelay: 0.15,
                }}
              >
                RANK UP
              </motion.span>
            </>
          )}
        </AnimatePresence>

        {/* Default badge content */}
        <motion.span
          className="flex items-center gap-1.5"
          animate={{ opacity: showRankUp ? 0 : 1 }}
          transition={{ duration: showRankUp ? 0.2 : 0.8 }}
        >
          <UserIcon weight="duotone" size={16} />
          {player?.name ?
            <span>{player.name}</span>
          : <span className="text-subtle-foreground group-hover:text-terminal-foreground transition-colors">
              ---
            </span>
          }
        </motion.span>
      </Badge>
    </button>
  )
}

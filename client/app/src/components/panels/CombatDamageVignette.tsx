import { useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import useGameStore from "@/stores/game"

export const CombatDamageVignette = () => {
  const tookDamageThisRound = useGameStore((state) => state.tookDamageThisRound)
  const [blinkPhase, setBlinkPhase] = useState<"blink" | "fade">("blink")

  return (
    <>
      <AnimatePresence>
        {tookDamageThisRound && (
          <motion.div
            key="combat-damage-vignette"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 4, ease: "easeOut" }}
            className="inset-0 pointer-events-none combat-vignette absolute!"
          />
        )}
      </AnimatePresence>
      <motion.div
        initial={{ opacity: 1 }}
        animate={blinkPhase === "blink" ? { opacity: [1, 0, 1] } : { opacity: 0 }}
        transition={
          blinkPhase === "blink" ?
            { duration: 0.4, ease: "linear", repeat: 4 }
          : { duration: 2, ease: "easeOut" }
        }
        onAnimationComplete={() => {
          if (blinkPhase === "blink") setBlinkPhase("fade")
        }}
        className="inset-0 pointer-events-none combat-border absolute!"
      />
    </>
  )
}

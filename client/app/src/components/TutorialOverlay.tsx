import { createPortal } from "react-dom"

import { AnimatePresence, motion } from "motion/react"

import useGameStore from "@/stores/game"

export const TutorialOverlay = () => {
  const tutorialActive = useGameStore((state) => state.tutorialActive)
  const dispatchAction = useGameStore((state) => state.dispatchAction)

  const handleSkip = () => {
    useGameStore.getState().handleTutorialComplete()
    dispatchAction({ type: "skip-tutorial" })
  }

  return createPortal(
    <AnimatePresence>
      {tutorialActive && (
        <motion.div
          key="tutorial-overlay"
          className="fixed inset-0 z-100 flex items-center justify-center pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
        >
          <motion.div
            className="pointer-events-auto flex flex-col items-center gap-4 bg-background/90 backdrop-blur-sm border border-border rounded-md px-8 py-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <div className="flex flex-row gap-3 items-center">
              <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-12" />
              <span className="text-xs uppercase tracking-[0.3em] font-bold text-terminal">
                Tutorial
              </span>
              <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-12" />
            </div>

            <button
              onClick={handleSkip}
              className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Skip Tutorial
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

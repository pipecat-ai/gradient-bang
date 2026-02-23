import { useEffect } from "react"

import { AnimatePresence, motion } from "motion/react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

const AUTO_DISMISS_DELAY = 4000

export const QuestAcceptedOverlay = () => {
  const questAccepted = useGameStore((state) => state.notifications.questAccepted)
  const setNotifications = useGameStore.use.setNotifications()

  const dismiss = () => setNotifications({ questAccepted: false })

  useEffect(() => {
    if (questAccepted) {
      useAudioStore.getState().playSound("chime8")
    }
  }, [questAccepted])

  useEffect(() => {
    if (!questAccepted) return
    const timer = setTimeout(dismiss, AUTO_DISMISS_DELAY)
    return () => clearTimeout(timer)
  }, [questAccepted])

  return (
    <AnimatePresence>
      {questAccepted && (
        <motion.div
          key="quest-accepted-overlay"
          className="fixed inset-0 z-(--z-toasts) flex items-center justify-center pointer-events-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          onClick={dismiss}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
          />

          {/* Content */}
          <div className="relative z-10 flex flex-col items-center gap-6">
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="flex flex-row gap-5 items-center"
            >
              <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-20" />
              <span className="text-xs uppercase tracking-[0.3em] font-bold text-terminal">
                New Contract Accepted
              </span>
              <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-20" />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, delay: 0.4 }}
              className="flex flex-col items-center gap-2"
            >
              <span className="text-sm text-muted-foreground max-w-sm text-center leading-relaxed">
                Speak with your AI agent to begin your mission
              </span>
            </motion.div>

            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.4 }}
              transition={{ duration: 0.5, delay: 1.5 }}
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Click to dismiss
            </motion.span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

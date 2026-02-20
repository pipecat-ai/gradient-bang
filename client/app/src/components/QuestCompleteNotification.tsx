import { useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"

const NEXT_QUEST_DELAY = 2000
const AUTO_DISMISS_DELAY = 6000

type Phase = "check" | "next" | "chain-complete"

export const QuestCompleteNotification = () => {
  const questCompleted = useGameStore((state) => state.notifications.questCompleted)
  const questCompletionData = useGameStore.use.questCompletionData()
  const setNotifications = useGameStore.use.setNotifications()
  const quests = useGameStore.use.quests()

  const [phase, setPhase] = useState<Phase>("check")
  const [nextQuest, setNextQuest] = useState<Quest | null>(null)
  const hasTransitioned = useRef(false)

  const dismiss = () => setNotifications({ questCompleted: false })

  // Play sound on show
  useEffect(() => {
    if (questCompleted) {
      useAudioStore.getState().playSound("chime8")
      hasTransitioned.current = false
      setPhase("check")
      setNextQuest(null)
    }
  }, [questCompleted])

  // Watch for new quests and transition after delay
  useEffect(() => {
    if (!questCompleted || !questCompletionData) return

    const timer = setTimeout(() => {
      if (hasTransitioned.current) return
      hasTransitioned.current = true

      const newQuests = quests.filter(
        (q) =>
          q.status === "active" && !questCompletionData.snapshotQuestIds.includes(q.quest_id)
      )

      if (newQuests.length > 0) {
        setNextQuest(newQuests[0])
        setPhase("next")
      } else {
        setPhase("chain-complete")
      }
    }, NEXT_QUEST_DELAY)

    return () => clearTimeout(timer)
  }, [questCompleted, questCompletionData, quests])

  // Auto-dismiss
  useEffect(() => {
    if (!questCompleted) return

    const timer = setTimeout(dismiss, AUTO_DISMISS_DELAY)
    return () => clearTimeout(timer)
  }, [questCompleted])

  if (!questCompleted || !questCompletionData) return null

  return (
    <AnimatePresence>
      {questCompleted && (
        <motion.div
          key="quest-complete-overlay"
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
            {/* Header */}
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="flex flex-row gap-5 items-center"
            >
              <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-20" />
              <span className="text-xs uppercase tracking-[0.3em] font-bold text-terminal">
                Quest Complete
              </span>
              <div className="dotted-bg-sm dotted-bg-terminal/40 h-px w-20" />
            </motion.div>

            {/* Quest content - animated transitions */}
            <div className="relative min-h-20 flex items-center justify-center">
              <AnimatePresence mode="wait">
                {phase === "check" && (
                  <motion.div
                    key="completed"
                    className="flex items-center gap-3"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, x: -60, scale: 0.95 }}
                    transition={{ duration: 0.4, delay: 0.4 }}
                  >
                    {/* Animated checkmark */}
                    <motion.svg
                      width="28"
                      height="28"
                      viewBox="0 0 28 28"
                      fill="none"
                      className="text-terminal shrink-0"
                    >
                      <motion.circle
                        cx="14"
                        cy="14"
                        r="12"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        initial={{ pathLength: 0, opacity: 0 }}
                        animate={{ pathLength: 1, opacity: 1 }}
                        transition={{ duration: 0.5, delay: 0.6, ease: "easeOut" }}
                      />
                      <motion.path
                        d="M8 14.5l4 4 8-9"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 0.4, delay: 1.0, ease: "easeOut" }}
                      />
                    </motion.svg>
                    <span className="text-lg font-bold text-foreground">
                      {questCompletionData.completedQuestName}
                    </span>
                  </motion.div>
                )}

                {phase === "next" && nextQuest && (
                  <motion.div
                    key="next-quest"
                    className="flex flex-col items-center gap-3"
                    initial={{ opacity: 0, x: 60, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  >
                    <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      New Quest
                    </span>
                    <span className="text-lg font-bold text-foreground">{nextQuest.name}</span>
                    {nextQuest.description && (
                      <span className="text-sm text-muted-foreground max-w-sm text-center leading-relaxed">
                        {nextQuest.description}
                      </span>
                    )}
                  </motion.div>
                )}

                {phase === "chain-complete" && (
                  <motion.div
                    key="chain-complete"
                    className="flex flex-col items-center gap-2"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                  >
                    <span className="text-lg font-bold text-terminal">Quest Chain Complete</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Dismiss hint */}
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

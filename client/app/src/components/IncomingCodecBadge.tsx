import { useCallback, useEffect, useRef, useState } from "react"

import { AnimatePresence, motion } from "motion/react"
import { WaveSineIcon } from "@phosphor-icons/react"
import { RTVIEvent } from "@pipecat-ai/client-js"
import { useRTVIClientEvent } from "@pipecat-ai/client-react"

import useAudioStore from "@/stores/audio"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

const SHOW_BADGE_DURATION = 15_000

export const IncomingCodecBadge = ({ className }: { className?: string }) => {
  const incomingCodec = useGameStore((state) => state.notifications.incomingCodec)
  const setActiveModal = useGameStore.use.setActiveModal()
  const setNotifications = useGameStore.use.setNotifications()
  const [visible, setVisible] = useState(false)
  const [entered, setEntered] = useState(false)

  const handleClick = useCallback(() => {
    setActiveModal("quest_codec")
    setVisible(false)
    setEntered(false)
    setNotifications({ incomingCodec: false })
  }, [setActiveModal, setNotifications])

  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  const dismiss = useCallback(() => {
    setVisible(false)
    setEntered(false)
    setNotifications({ incomingCodec: false })
  }, [setNotifications])

  useRTVIClientEvent(RTVIEvent.BotStoppedSpeaking, async () => {
    if (incomingCodec) {
      const playSound = useAudioStore.getState().playSound
      playSound("codec1")
      setVisible(true)
    }
  })

  useEffect(() => {
    if (visible) {
      timerRef.current = setTimeout(dismiss, SHOW_BADGE_DURATION)
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current)
      }
    }
  }, [visible, dismiss])

  return (
    <AnimatePresence>
      {visible && incomingCodec && (
        <motion.button
          initial={{ opacity: 0, scale: 1.25 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.5 }}
          transition={{ duration: 0.25 }}
          onAnimationComplete={() => setEntered(true)}
          onClick={handleClick}
          className={cn(
            "animate-highlight flex items-center outline-3 outline-background/30 gap-1.5 px-2 py-1.5",
            "text-xs uppercase tracking-wider font-bold text-terminal bg-terminal-background",
            "stripe-frame stripe-frame-1 stripe-frame-size-2 stripe-frame-terminal",
            "cursor-pointer hover:brightness-125 transition-[filter]",
            entered && "animate-pulse",
            className
          )}
        >
          <WaveSineIcon size={16} weight="bold" />
          <span className="text-terminal-foreground">Incoming Wave</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}

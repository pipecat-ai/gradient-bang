import { useCallback } from "react"

import { AnimatePresence, motion } from "motion/react"
import { EnvelopeSimpleIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

import { codecOverlayApi } from "./QuestCodecOverlay"

export const IncomingCodecBadge = ({ className }: { className?: string }) => {
  const incomingCodec = useGameStore((state) => state.notifications.incomingCodec)

  const handleClick = useCallback(() => {
    codecOverlayApi.open?.()
  }, [])

  return (
    <AnimatePresence>
      {incomingCodec && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.25 }}
          onClick={handleClick}
          className={`flex items-center gap-1.5 px-2 py-1 text-xs uppercase tracking-wider font-bold text-terminal bg-terminal-background stripe-frame stripe-frame-1 stripe-frame-size-2 stripe-frame-terminal cursor-pointer hover:brightness-125 transition-[filter] ${className ?? ""}`}
        >
          <EnvelopeSimpleIcon size={14} weight="bold" className="animate-pulse" />
          <span>Incoming Codec</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}

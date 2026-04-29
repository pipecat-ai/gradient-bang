import { motion } from "motion/react"

interface PlayerShipCombatMarkerProps {
  className?: string
}

export const PlayerShipCombatMarker = ({ className }: PlayerShipCombatMarkerProps) => {
  return (
    <svg viewBox="0 0 32 20" preserveAspectRatio="none" fill="currentColor" className={className}>
      <motion.g
        initial={{ x: -32 }}
        animate={{ x: 0 }}
        exit={{ x: -32 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <polygon points="0,0 8,0 16,10 8,20 0,20" opacity={1} />
        <polygon points="8,0 16,0 24,10 16,20 8,20 16,10" opacity={0.65} />
        <polygon points="16,0 24,0 32,10 24,20 16,20 24,10" opacity={0.35} />
      </motion.g>
    </svg>
  )
}

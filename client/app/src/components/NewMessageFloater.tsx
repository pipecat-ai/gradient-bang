import { useMemo } from "react"

import { EnvelopeSimpleIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

export const NewMessageFloater = () => {
  const notifications = useGameStore.use.notifications?.()
  const activePanel = useGameStore.use.activePanel?.()

  const shouldShow = useMemo(() => {
    if (!notifications?.newChatMessage) return false
    if (activePanel === "logs") return false
    return true
  }, [notifications?.newChatMessage, activePanel])

  return shouldShow ?
      <div className="absolute -top-[36px] -inset-x-px h-[32px] bg-terminal-background text-terminal-foreground z-10 stripe-frame stripe-frame-1 stripe-frame-size-2 stripe-frame-terminal flex flex-col items-center justify-center animate-new-msg">
        <span className="text-xs animate-pulse">
          <EnvelopeSimpleIcon size={12} weight="bold" className="size-4" />
        </span>
      </div>
    : null
}

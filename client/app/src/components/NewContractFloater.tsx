import { useMemo } from "react"

import { WaveSineIcon } from "@phosphor-icons/react"

import useGameStore from "@/stores/game"

export const NewContractFloater = () => {
  const notifications = useGameStore.use.notifications?.()
  const activePanel = useGameStore.use.activePanel?.()

  const count = notifications?.seenContractCodecs?.length ?? 0

  const shouldShow = useMemo(() => {
    if (count === 0) return false
    if (activePanel === "contracts") return false
    return true
  }, [count, activePanel])

  return shouldShow ?
      <div className="absolute -top-9 -inset-x-px h-8 bg-terminal-background text-terminal-foreground z-10 stripe-frame stripe-frame-1 stripe-frame-size-2 stripe-frame-terminal flex flex-row items-center justify-center gap-1 animate-new-msg">
        <WaveSineIcon size={12} weight="bold" className="size-3 animate-pulse" />
        <span className="text-xxs font-bold tabular-nums">{count}</span>
      </div>
    : null
}

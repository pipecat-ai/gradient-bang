import { CircleNotchIcon } from "@phosphor-icons/react"

import { cn } from "@/utils/tailwind"

export const PanelContentLoader = ({ className }: { className?: string }) => {
  return <CircleNotchIcon weight="bold" className={cn("shrink-0 size-4 animate-spin", className)} />
}

import type { Icon } from "@phosphor-icons/react"

import { useFlashAnimation } from "@/hooks/useFlashAnimation"
import { cn } from "@/utils/tailwind"

interface ShipCardStatProps {
  Icon: Icon
  value: number | undefined
  className?: string
}

export const ShipCardStat = ({ Icon, value, className }: ShipCardStatProps) => {
  const { flashColor } = useFlashAnimation(value, { duration: 800 })

  return (
    <div
      className={cn(
        "grid grid-cols-subgrid col-span-2 items-center gap-x-1 py-px pr-ui-xs pl-1 bg-accent-background transition-colors duration-200",
        flashColor === "increment" && "bg-success-background text-success-foreground",
        flashColor === "decrement" && "bg-destructive-background text-destructive-foreground",
        className
      )}
    >
      <Icon weight="bold" className="size-3 shrink-0" />
      <dd className="tabular-nums text-right">{value ?? "---"}</dd>
    </div>
  )
}

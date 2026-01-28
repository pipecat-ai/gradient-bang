import { Badge } from "@/components/primitives/Badge"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

export const PortBadge = ({ className }: { className?: string }) => {
  const sector = useGameStore.use.sector?.()
  const isAtPort = sector?.id === 0 || sector?.port
  const isMegaPort = sector?.id === 0

  return (
    <Badge
      border="bracket"
      className={cn(
        "flex-1 border -bracket-offset-2 text-xs bg-subtle-background/80 bracket-subtle text-subtle bracket-size-6",
        isAtPort &&
          !isMegaPort &&
          "bracket-terminal text-terminal-foreground bg-terminal-background/80 border-terminal-subtle",
        isMegaPort && "bracket-fuel text-fuel-foreground bg-fuel-background/80 border-fuel-subtle",
        className
      )}
      variant="default"
    >
      {isMegaPort ?
        "Mega Port"
      : isAtPort ?
        `Port ${sector?.port?.code}`
      : "No Port"}
    </Badge>
  )
}

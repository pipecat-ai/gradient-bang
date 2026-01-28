import { Badge } from "@/components/primitives/Badge"
import useGameStore from "@/stores/game"
import { cn } from "@/utils/tailwind"

export const SectorBadge = ({ className }: { className?: string }) => {
  const sector = useGameStore.use.sector?.()

  return (
    <Badge
      variant="default"
      border="bracket"
      className={cn(
        "flex-1 text-xs bg-accent-background/90 bracket-subtle-foreground -bracket-offset-2 bracket-size-6",
        className
      )}
    >
      Sector
      <span className={sector?.id !== undefined ? "opacity-100 font-extrabold" : "opacity-40"}>
        {sector?.id ?? "unknown"}
      </span>
    </Badge>
  )
}

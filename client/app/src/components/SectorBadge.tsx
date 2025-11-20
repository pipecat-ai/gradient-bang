import { Badge } from "@/components/primitives/Badge";
import useGameStore from "@/stores/game";
import { cn } from "@/utils/tailwind";

export const SectorBadge = ({ className }: { className?: string }) => {
  const sector = useGameStore.use.sector?.();

  return (
    <Badge
      variant="secondary"
      border="bracket"
      className={cn("flex-1 bracket-offset-0", className)}
    >
      Sector:
      <span
        className={
          sector?.id !== undefined ? "opacity-100 font-extrabold" : "opacity-40"
        }
      >
        {sector?.id ?? "unknown"}
      </span>
    </Badge>
  );
};

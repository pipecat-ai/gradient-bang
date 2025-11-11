import { Badge } from "@/components/primitives/Badge";
import { Progress } from "@/components/primitives/Progress";

import { cn } from "@/utils/tailwind";
import { DroneIcon } from "@phosphor-icons/react";
import useGameStore from "../stores/game";

export const FightersBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  const fightersPercentage =
    ((ship.fighters ?? 0) / (ship.max_fighters ?? 0)) * 100;

  return (
    <Badge
      variant="glass"
      border="elbow"
      className={cn("flex-col gap-2 items-start", className)}
    >
      <div className="flex flex-row gap-3 items-center w-full">
        <DroneIcon weight="duotone" className="size-4" />
        <Progress
          color="success"
          value={fightersPercentage}
          className="h-[10px] w-full"
        />
      </div>
    </Badge>
  );
};

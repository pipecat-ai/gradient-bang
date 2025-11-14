import { ShieldIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/primitives/Badge";
import { Progress } from "@/components/primitives/Progress";
import { cn } from "@/utils/tailwind";

import useGameStore from "../stores/game";

export const ShieldsBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  const shieldsPercentage =
    ((ship.shields ?? 0) / (ship.max_shields ?? 0)) * 100;

  return (
    <Badge
      variant="count"
      border="elbow"
      className={cn("flex-col gap-2 items-start", className)}
    >
      <div className="flex flex-row gap-3 items-center w-full">
        <ShieldIcon weight="duotone" className="size-4" />
        <Progress
          color="success"
          value={shieldsPercentage}
          className="h-[10px] w-full"
        />
      </div>
    </Badge>
  );
};

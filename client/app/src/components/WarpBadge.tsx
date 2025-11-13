import { Badge, BadgeTitle } from "@/components/primitives/Badge";
import { Progress } from "@/components/primitives/Progress";

import { cn } from "@/utils/tailwind";
import useGameStore from "../stores/game";

const incrementCx =
  "bg-success-background stripe-bar stripe-bar-success stripe-bar-8 stripe-bar-animate-1";
const decrementCx =
  "stripe-bar stripe-bar-8 stripe-bar-animate-1 stripe-bar-reverse";

export const WarpBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  const warpPercentage = (ship.warp_power / ship.warp_power_capacity) * 100;
  const color =
    warpPercentage <= 25
      ? "destructive"
      : warpPercentage <= 50
      ? "warning"
      : "fuel";

  const dCX = `${decrementCx} ${
    color === "destructive"
      ? "bg-destructive-background stripe-bar-destructive"
      : "bg-warning-background stripe-bar-warning"
  }`;
  return (
    <Badge
      variant="count"
      border="bracket"
      className={cn("flex-col gap-2 w-full items-start", className)}
    >
      <div className="flex flex-row gap-2 items-center w-full justify-between">
        <BadgeTitle>Warp fuel</BadgeTitle>
        <div className="text-xs">
          {ship?.warp_power ?? 0}
          <span className="opacity-30"> / </span>
          {ship?.warp_power_capacity ?? 0}
        </div>
      </div>
      <div className="flex flex-row gap-3 items-center w-full">
        <Progress
          color={color}
          value={warpPercentage}
          segmented={true}
          className="h-[16px] w-full"
          classNames={{
            increment: incrementCx,
            decrement: dCX,
          }}
          segmentHoldMs={500}
        />
      </div>
    </Badge>
  );
};

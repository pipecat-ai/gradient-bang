import { Badge, BadgeTitle } from "@/components/primitives/Badge";
import { Progress } from "@/components/primitives/Progress";

import { cn } from "@/utils/tailwind";
import useGameStore from "../stores/game";

const incrementCx =
  "bg-success-background stripe-bar stripe-bar-success stripe-bar-8 stripe-bar-animate-1";
const decrementCx =
  "stripe-bar stripe-bar-8 stripe-bar-animate-1 stripe-bar-reverse";

export const CargoBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  const cargoPercentage =
    (Math.max(0, (ship.cargo_capacity ?? 0) - (ship.empty_holds ?? 0)) /
      (ship.cargo_capacity ?? 0)) *
    100;

  const color =
    cargoPercentage >= 75
      ? "destructive"
      : cargoPercentage >= 50
      ? "warning"
      : "primary";

  const dCX = `${decrementCx} ${
    color === "destructive"
      ? "bg-destructive-background stripe-bar-destructive"
      : "bg-warning-background stripe-bar-warning"
  }`;
  return (
    <Badge
      variant="glass"
      border="bracket"
      className={cn("flex-col gap-2 w-full items-start", className)}
    >
      <div className="flex flex-row gap-2 items-center w-full justify-between">
        <div className="text-xs">
          {ship?.empty_holds ?? 0}
          <span className="opacity-30"> / </span>
          {ship?.cargo_capacity ?? 0}
        </div>
        <BadgeTitle>Cargo holds</BadgeTitle>
      </div>
      <div className="flex flex-row gap-3 items-center w-full">
        <Progress
          color={color}
          value={100 - cargoPercentage}
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

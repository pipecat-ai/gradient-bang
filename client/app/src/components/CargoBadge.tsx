import { Badge, BadgeTitle } from "@/components/primitives/Badge";
import { Progress } from "@/components/primitives/Progress";
import { cn } from "@/utils/tailwind";
import useGameStore from "@stores/game";

const incrementCx =
  "bg-warning-background stripe-bar stripe-bar-warning stripe-bar-8 stripe-bar-animate-1";

const decrementCx =
  "bg-success-background stripe-bar stripe-bar-success stripe-bar-8 stripe-bar-animate-1 stripe-bar-reverse";

export const CargoBadge = ({ className }: { className?: string }) => {
  const ship = useGameStore.use.ship();

  const cargoPercentage =
    (Math.max(0, (ship.cargo_capacity ?? 0) - (ship.empty_holds ?? 0)) /
      (ship.cargo_capacity ?? 0)) *
    100;

  const color =
    cargoPercentage >= 95
      ? "destructive"
      : cargoPercentage >= 85
      ? "warning"
      : "primary";

  const iCX = `${
    color === "destructive"
      ? "bg-destructive-background stripe-bar stripe-bar-destructive stripe-bar-8 stripe-bar-animate-1"
      : incrementCx
  }`;

  return (
    <Badge
      variant="count"
      border="bracket"
      className={cn("flex-col gap-2 w-full items-start", className)}
    >
      <div className="flex flex-row gap-2 items-center w-full justify-between">
        <div className="text-xs">
          {Math.min(
            Math.max((ship?.cargo_capacity ?? 0) - (ship?.empty_holds ?? 0), 0),
            ship?.cargo_capacity ?? 0
          )}
          <span className="opacity-30"> / </span>
          {ship?.cargo_capacity ?? 0}
        </div>
        <BadgeTitle>Cargo holds</BadgeTitle>
      </div>
      <div className="flex flex-row gap-3 items-center w-full">
        <Progress
          color={color}
          value={cargoPercentage}
          segmented={true}
          className="h-[16px] w-full"
          classNames={{
            increment: iCX,
            decrement: decrementCx,
          }}
          segmentHoldMs={500}
        />
      </div>
    </Badge>
  );
};

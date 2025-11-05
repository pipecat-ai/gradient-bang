import { Badge, cn, Progress } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";
import useGameStore from "../stores/game";

export const CargoCapacityBadge = () => {
  const ship = useGameStore.use.ship();

  const progressProps = useMemo(() => {
    if (!ship) return { color: "primary", percent: 0 };

    const cargoPercentage =
      (Math.max(0, (ship.cargo_capacity ?? 0) - (ship.empty_holds ?? 0)) /
        (ship.cargo_capacity ?? 0)) *
      100;

    let color = "agent";
    if (cargoPercentage >= 100) {
      color = "destructive";
    } else if (cargoPercentage >= 75) {
      color = "warning";
    }

    return {
      color,
      percent: cargoPercentage,
      variant: cargoPercentage >= 100 ? "destructive" : "primary",
    };
  }, [ship]);

  return (
    <Badge
      buttonSizing
      variant="elbow"
      color={progressProps.variant}
      className={cn(
        progressProps.color === "warning" && "text-warning-foreground",
        progressProps.color === "destructive" && "text-destructive-foreground"
      )}
    >
      Cargo:
      <Progress {...progressProps} size="xl" className="h-[8px]" />
      <div>
        {Math.max(0, (ship?.cargo_capacity ?? 0) - (ship?.empty_holds ?? 0))}
        <span className="opacity-30"> / </span>
        {ship?.cargo_capacity ?? 0}
      </div>
    </Badge>
  );
};

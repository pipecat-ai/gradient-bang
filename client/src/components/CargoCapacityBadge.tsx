import { Badge, Progress } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";
import useGameStore from "../stores/game";

export const CargoCapacityBadge = () => {
  const ship = useGameStore.use.ship();

  const progressProps = useMemo(() => {
    if (!ship) return { color: "primary", percent: 0 };

    const cargoPercentage = (ship.empty_holds / ship.cargo_capacity) * 100;

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
    <Badge buttonSizing variant="elbow" color={progressProps.variant}>
      Cargo:
      <Progress {...progressProps} size="xl" className="h-[8px]" />
      <div>
        {ship?.empty_holds ?? 0}
        <span className="opacity-30"> / </span>
        {ship?.cargo_capacity ?? 0}
      </div>
    </Badge>
  );
};

import { Badge, Progress } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";
import { useGameManager } from "../hooks/useGameManager";

export const CargoCapacityBadge = () => {
  const { game } = useGameManager();

  const ship = game.ship;

  const progressProps = useMemo(() => {
    if (!ship) return { color: "primary", percent: 0 };

    const cargoPercentage = (ship.cargo_used / ship.cargo_capacity) * 100;

    let color = "agent";
    // Reversed logic: the more full, the worse it is
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
    <Badge size="lg" variant="elbow" color={progressProps.variant}>
      Cargo:
      <Progress {...progressProps} size="xl" className="h-[8px]" />
      <div>
        {ship?.cargo_used ?? 0}
        <span className="opacity-30"> / </span>
        {ship?.cargo_capacity ?? 0}
      </div>
    </Badge>
  );
};

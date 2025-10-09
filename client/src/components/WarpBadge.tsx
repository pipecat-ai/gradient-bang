import { Badge, Progress } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";
import useGameStore from "../stores/game";

export const WarpBadge = () => {
  const ship = useGameStore.use.ship();

  const progressProps = useMemo(() => {
    if (!ship) return { color: "primary", percent: 0 };

    const warpPercentage = (ship.warp_power / ship.warp_power_capacity) * 100;

    let color = "agent";
    if (warpPercentage <= 25) {
      color = "destructive";
    } else if (warpPercentage <= 50) {
      color = "warning";
    }

    return {
      color,
      percent: warpPercentage,
      variant: warpPercentage <= 25 ? "destructive" : "primary",
    };
  }, [ship]);

  return (
    <Badge buttonSizing variant="elbow" color={progressProps.variant}>
      Warp:
      <Progress {...progressProps} size="xl" className="h-[8px]" />
      <div>
        {ship?.warp_power ?? 0}
        <span className="opacity-30"> / </span>
        {ship?.warp_power_capacity ?? 0}
      </div>
    </Badge>
  );
};

import { Badge, Progress } from "@pipecat-ai/voice-ui-kit";
import { useMemo } from "react";
import { useGameManager } from "../hooks/useGameManager";

export const WarpBadge = () => {
  const { game } = useGameManager();

  const ship = game.ship;

  const progressProps = useMemo(() => {
    if (!ship) return { color: "default", percent: 0 };

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
    };
  }, [ship]);

  return (
    <Badge size="md" variant="elbow" color="primary">
      <Progress {...progressProps} size="lg" className="mr-1 h-[5px]" />
      <div>
        {ship?.warp_power ?? 0}
        <span className="text-subtle">/</span>
        {ship?.warp_power_capacity ?? 0}
      </div>
    </Badge>
  );
};

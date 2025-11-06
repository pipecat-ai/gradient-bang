import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { Separator } from "@/components/primitives/Separator";
import useGameStore from "@/stores/game";

export const MapScreen = () => {
  const player = useGameStore((state) => state.player);
  const sector = useGameStore.use.sector?.();

  return (
    <div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-row gap-3">
          <span className="text-sm font-medium">
            Sectors visited: {player?.sectors_visited}
          </span>
          <span className="text-sm font-medium">
            Universe size: {player?.universe_size}
          </span>
          <span className="text-sm font-medium">
            Current sector: {sector?.id ?? "unknown"}
          </span>
        </div>
        <Separator />
        <MovementHistoryPanel />
      </div>
    </div>
  );
};

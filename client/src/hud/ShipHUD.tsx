import { ConnectionStatusBadge } from "@/components/ConnectionStatusBadge";
import { SectorPlayersBadge } from "@/components/SectorPlayersBadge";
import { TaskStatusBadge } from "@/components/TaskStatusBadge";
import useGameStore from "@/stores/game";
import MiniMap from "@hud/MiniMap";
import { RHS } from "@hud/RHS";

export const ShipHUD = () => {
  const sector = useGameStore((state) => state.sector);
  const localMapData = useGameStore((state) => state.local_map_data);

  return (
    <div className="flex flex-row p-2 h-ui mt-auto gap-2 z-(--z-hud)">
      <div className="min-w-[400px]">
        <div className="relative h-[400px]">
          {sector && localMapData && (
            <MiniMap
              current_sector_id={sector.id}
              map_data={localMapData}
              maxDistance={3}
              showLegend={false}
              width={400}
              height={400}
            />
          )}
        </div>
        <div className="flex flex-row gap-2 mt-2">
          <TaskStatusBadge />
          <SectorPlayersBadge />
          <ConnectionStatusBadge />
        </div>
      </div>
      <RHS />
    </div>
  );
};

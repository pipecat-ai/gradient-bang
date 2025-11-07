import { CoursePlotPanel } from "@/components/CoursePlotPanel";
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { Separator } from "@/components/primitives/Separator";
import MiniMap, { type MiniMapConfig } from "@/hud/MiniMap";
import useGameStore from "@/stores/game";

const MAP_CONFIG: MiniMapConfig = {
  debug: true,
  max_bounds_distance: undefined,
  show_sector_ids: true,
  show_ports: true,
};

export const MapScreen = () => {
  const player = useGameStore((state) => state.player);
  const sector = useGameStore.use.sector?.();
  const mapData = useGameStore.use.regional_map_data?.();
  const coursePlot = useGameStore.use.course_plot?.();

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
        <CoursePlotPanel />
        <Separator />
        <div className="w-full h-[500px] bg-black">
          {mapData && (
            <MiniMap
              config={MAP_CONFIG}
              current_sector_id={sector?.id ?? 0}
              map_data={mapData}
              maxDistance={100}
              showLegend={false}
              coursePlot={coursePlot}
            />
          )}
        </div>
        <Separator />
        <MovementHistoryPanel />
      </div>
    </div>
  );
};

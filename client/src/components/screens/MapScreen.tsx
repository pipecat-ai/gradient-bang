import { GET_MAP_REGION } from "@/actions/dispatch";
import { CoursePlotPanel } from "@/components/CoursePlotPanel";
import MiniMap, { type MiniMapConfig } from "@/components/hud/MiniMap";
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { Separator } from "@/components/primitives/Separator";
import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@/stores/game";
import { useEffect, useRef } from "react";

const MAP_CONFIG: MiniMapConfig = {
  max_bounds_distance: undefined,
  show_sector_ids: true,
  show_ports: true,
};

export const MapScreen = () => {
  const player = useGameStore((state) => state.player);
  const sector = useGameStore.use.sector?.();
  const mapData = useGameStore.use.regional_map_data?.();
  const coursePlot = useGameStore.use.course_plot?.();
  const { dispatchEvent } = useGameContext();

  const throttleActive = useRef(false);

  useEffect(() => {
    if (sector !== undefined && !throttleActive.current) {
      throttleActive.current = true;

      dispatchEvent({
        ...GET_MAP_REGION,
        payload: {
          center_sector: sector?.id ?? 0,
          max_hops: 50,
          max_sectors: 1000,
        },
      });

      setTimeout(() => {
        throttleActive.current = false;
      }, 250);
    }
  }, [sector, dispatchEvent]);

  return (
    <div className="w-[calc(100vw-220px)] h-[calc(100vh-420px)]">
      <div className="flex flex-row gap-3 h-full">
        <div className="w-full h-full">
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

        <div className="flex flex-col gap-3 w-[600px]">
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
          <Separator />
          <MovementHistoryPanel />
        </div>
      </div>
    </div>
  );
};

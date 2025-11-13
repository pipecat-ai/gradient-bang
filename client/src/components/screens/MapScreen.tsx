import { GET_MAP_REGION } from "@/actions/dispatch";
import { CoursePlotPanel } from "@/components/CoursePlotPanel";
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel";
import { Badge } from "@/components/primitives/Badge";
import { Separator } from "@/components/primitives/Separator";
import { useGameContext } from "@/hooks/useGameContext";
import useGameStore from "@/stores/game";
import PlanetLoader from "@assets/videos/planet-loader.mp4";
import MiniMap, { type MiniMapConfig } from "@hud/MiniMap";
import { useEffect, useRef } from "react";
import { CardContent, CardTitle } from "../primitives/Card";
import { Progress } from "../primitives/Progress";

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
      console.debug("[GAME MAP SCREEN] Fetching", sector?.id);
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
    <div className="flex flex-row gap-3 h-full relative">
      <CardTitle className="heading-1 absolute top-0 left-0">
        Universe Map
      </CardTitle>
      <div className="w-[1100px] h-[780px]">
        {mapData ? (
          <MiniMap
            config={MAP_CONFIG}
            current_sector_id={sector?.id ?? 0}
            map_data={mapData}
            maxDistance={50}
            showLegend={false}
            coursePlot={coursePlot}
            width={1100}
            height={780}
          />
        ) : (
          <div className="relative w-full h-full flex items-center justify-center cross-lines-white/50 cross-lines-offset-50">
            <div className="elbow relative z-99 flex flex-col gap-3 bg-black border border-border p-6 animate-in fade-in-0 duration-300">
              <video
                src={PlanetLoader}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
                className="w-[120px] h-[120px] object-contain mx-auto"
              />

              <span className="text-muted-foreground text-sm uppercase animate-pulse">
                Fetching region data...
              </span>
            </div>
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-6 min-w-100">
        <CardContent className="flex flex-col gap-3">
          <Badge border="bracket" className="w-full -bracket-offset-3">
            Current Sector:
            <span
              className={
                sector?.id !== undefined
                  ? "opacity-100 font-extrabold"
                  : "opacity-40"
              }
            >
              {sector?.id ?? "unknown"}
            </span>
          </Badge>
          <Separator
            variant="dotted"
            className="w-full text-white/20 h-[12px]"
          />
          <div className="flex flex-row gap-3">
            <Badge variant="secondary" className="flex-1">
              Discovered:
              <span className="font-extrabold">{player?.sectors_visited}</span>
            </Badge>
            <Badge variant="secondary" className="flex-1">
              Total:
              <span className="font-extrabold">{player?.universe_size}</span>
            </Badge>
          </div>
          <Badge
            border="elbow"
            className="text-xs w-full -elbow-offset-3 gap-3"
          >
            <Progress
              value={(player?.sectors_visited / player?.universe_size) * 100}
              className="h-[12px] w-full"
            />
            {(player?.sectors_visited / player?.universe_size) * 100}%
          </Badge>
        </CardContent>
        <CoursePlotPanel />
        <MovementHistoryPanel />
      </aside>
    </div>
  );
};

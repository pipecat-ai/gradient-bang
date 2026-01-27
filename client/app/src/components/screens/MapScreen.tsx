import { useCallback, useEffect, useRef, useState } from "react"

import PlanetLoader from "@/assets/videos/planet-loader.mp4"
import { CoursePlotPanel } from "@/components/CoursePlotPanel"
import { MovementHistoryPanel } from "@/components/panels/DataTablePanels"
import { Badge } from "@/components/primitives/Badge"
import { Separator } from "@/components/primitives/Separator"
import useGameStore from "@/stores/game"

import { MapZoomControls } from "../MapZoomControls"
import { Button } from "../primitives/Button"
import { CardContent, CardTitle } from "../primitives/Card"
import { Progress } from "../primitives/Progress"
import SectorMap, { type MapConfig } from "../SectorMap"

import type { GetMapRegionAction } from "@/types/actions"

const MAP_CONFIG: MapConfig = {
  debug: true,
  clickable: true,
  show_sector_ids: true,
  show_partial_lanes: true,
  show_ports: true,
  show_hyperlanes: false,
  show_grid: true,
  show_port_labels: true,
}

export const MapScreen = () => {
  const player = useGameStore((state) => state.player)
  const sector = useGameStore.use.sector?.()
  const mapData = useGameStore.use.regional_map_data?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const ships = useGameStore.use.ships?.()
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setActiveScreen = useGameStore.use.setActiveScreen?.()
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const [centerSector, setCenterSector] = useState<number | undefined>(sector?.id ?? undefined)

  const throttleActive = useRef(false)

  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  useEffect(() => {
    if (sector !== undefined && !throttleActive.current) {
      console.debug("[GAME MAP SCREEN] Fetching", sector?.id)
      throttleActive.current = true

      dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: sector?.id ?? 0,
          max_hops: 25,
          max_sectors: 1000,
        },
      } as GetMapRegionAction)

      setTimeout(() => {
        throttleActive.current = false
      }, 250)
    }
  }, [sector, dispatchAction])

  const updateCenterSector = useCallback(
    (node: MapSectorNode | null) => {
      // Click on empty space deselects (resets to current sector)
      setCenterSector(node?.id ?? sector?.id)
    },
    [setCenterSector, sector?.id]
  )

  return (
    <div className="flex flex-row gap-3 w-full h-full relative">
      <CardTitle className="heading-1 absolute top-0 left-0">Universe Map</CardTitle>
      <div className="flex-1 relative">
        <MapZoomControls />
        {mapData ?
          <SectorMap
            center_sector_id={centerSector}
            current_sector_id={sector ? sector.id : undefined}
            config={MAP_CONFIG as MapConfig}
            map_data={mapData ?? []}
            maxDistance={mapZoomLevel ?? 15}
            showLegend={false}
            onNodeClick={updateCenterSector}
            coursePlot={coursePlot ?? null}
            ships={shipSectors}
          />
        : <div className="relative w-full h-full flex items-center justify-center cross-lines-white/50 cross-lines-offset-50">
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
        }
      </div>

      <aside className="flex flex-col gap-6 w-md min-h-0">
        <CardContent className="flex flex-col gap-3">
          <Badge border="bracket" className="w-full -bracket-offset-3">
            Current Sector:
            <span
              className={sector?.id !== undefined ? "opacity-100 font-extrabold" : "opacity-40"}
            >
              {sector?.id ?? "unknown"}
            </span>
          </Badge>
          <Separator variant="dotted" className="w-full text-white/20 h-[12px]" />
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
          <Badge border="elbow" className="text-xs w-full -elbow-offset-3 gap-3">
            <Progress
              value={(player?.sectors_visited / player?.universe_size) * 100}
              className="h-[12px] w-full"
            />
            {((player?.sectors_visited / player?.universe_size) * 100).toFixed(2)}%
          </Badge>
        </CardContent>
        <CoursePlotPanel />
        <MovementHistoryPanel className="flex-1 min-h-0" />
        <Button variant="default" className="w-full" onClick={() => setActiveScreen(undefined)}>
          Close
        </Button>
      </aside>
    </div>
  )
}

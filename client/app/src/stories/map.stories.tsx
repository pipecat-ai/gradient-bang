import { useCallback, useEffect } from "react"

import { button, folder, useControls } from "leva"
import { Story } from "@ladle/react"

import { ChatPanel } from "@/components/ChatPanel"
import { CoursePlotPanel } from "@/components/CoursePlotPanel"
import { MapZoomControls } from "@/components/MapZoomControls"
import { MovementHistoryPanel } from "@/components/MovementHistoryPanel"
import { Badge } from "@/components/primitives/Badge"
import { CardContent, CardTitle } from "@/components/primitives/Card"
import { Progress } from "@/components/primitives/Progress"
import { Separator } from "@/components/primitives/Separator"
import SectorMap, { type MapConfig } from "@/components/SectorMap"
import useGameStore from "@/stores/game"

import type { GetMapRegionAction } from "@/types/actions"
import { MEDIUM_MAP_DATA_MOCK, SMALL_MAP_DATA_MOCK } from "@/mocks/map.mock"

export const BigMapStory: Story = () => {
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const player = useGameStore((state) => state.player)
  const mapData = useGameStore.use.regional_map_data?.()
  const sector = useGameStore((state) => state.sector)
  const coursePlot = useGameStore.use.course_plot?.()
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const setRegionalMapData = useGameStore.use.setRegionalMapData?.()

  const [{ current_sector, center_sector, show_legend }, set] = useControls(() => ({
    Map: folder(
      {
        ["Get My Map"]: button((get) => {
          dispatchAction({
            type: "get-my-map",
            payload: {
              center_sector: get("Map.center_sector"),
              max_hops: get("Map.max_hops"),
              max_sectors: get("Map.max_sectors"),
            },
          } as GetMapRegionAction)
        }),
        ["Load Small Mock"]: button(() => {
          setRegionalMapData(SMALL_MAP_DATA_MOCK)
        }),
        ["Load Medium Mock"]: button(() => {
          setRegionalMapData(MEDIUM_MAP_DATA_MOCK)
        }),
        center_sector: {
          value: sector?.id ?? 0,
          step: 1,
        },
        current_sector: {
          value: sector?.id ?? 0,
          step: 1,
        },
        max_hops: {
          value: 25,
          min: 1,
          max: 100,
          step: 1,
        },
        max_sectors: {
          value: 500,
          min: 1,
          max: 1000,
          step: 1,
        },
        show_legend: {
          value: true,
        },
      },
      { collapsed: false }
    ),
  }))

  useEffect(() => {
    set({ center_sector: sector?.id ?? 0 })
  }, [set, sector])

  useEffect(() => {
    set({ current_sector: sector?.id ?? 0 })
  }, [set, sector?.id])

  const [mapConfig, setMapConfig] = useControls(() => ({
    Map: folder({
      ["Config"]: folder(
        {
          debug: {
            value: true,
          },
          clickable: {
            value: true,
          },
          max_bounds_distance: {
            value: mapZoomLevel ?? 15,
            min: 1,
            max: 50,
            step: 1,
          },
          show_sector_ids: {
            value: true,
          },
          show_partial_lanes: {
            value: true,
          },
          show_ports: {
            value: true,
          },
          show_hyperlanes: {
            value: false,
          },
          show_grid: {
            value: true,
          },
          show_port_labels: {
            value: true,
          },
        },
        { collapsed: true }
      ),
    }),
  }))

  useEffect(() => {
    setMapConfig({ max_bounds_distance: mapZoomLevel ?? 15 })
  }, [setMapConfig, mapZoomLevel])

  const updateCenterSector = useCallback(
    (node: MapSectorNode) => {
      set({ center_sector: node.id ?? 0 })
    },
    [set]
  )

  return (
    <>
      <div className="flex flex-row gap-3 h-full relative bg-black">
        <CardTitle className="heading-1 absolute top-0 left-0">Universe Map</CardTitle>
        <div className="w-[1100px] h-[780px] relative">
          <MapZoomControls />
          {mapConfig && (
            <SectorMap
              center_sector_id={center_sector}
              current_sector_id={current_sector}
              config={mapConfig as MapConfig}
              map_data={mapData ?? []}
              width={1100}
              height={780}
              maxDistance={mapConfig.max_bounds_distance}
              showLegend={show_legend}
              onNodeClick={updateCenterSector}
              coursePlot={coursePlot ?? null}
            />
          )}
        </div>
        <aside className="flex flex-col gap-6 min-w-100">
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
          <MovementHistoryPanel />
        </aside>
      </div>
    </>
  )
}

BigMapStory.meta = {
  connectOnMount: false,
  enableMic: true,
  disableAudioOutput: false,
  useDevTools: true,
}

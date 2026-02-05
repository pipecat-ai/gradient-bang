import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { deepmerge } from "deepmerge-ts"
import { XIcon } from "@phosphor-icons/react"

import PlanetLoader from "@/assets/videos/planet-loader.mp4"
import { CoursePlotPanel } from "@/components/CoursePlotPanel"
import { MapLegend } from "@/components/MapLegends"
import { MovementHistoryPanel } from "@/components/panels/DataTablePanels"
import { Badge } from "@/components/primitives/Badge"
import { Separator } from "@/components/primitives/Separator"
import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatTimeAgoOrDate } from "@/utils/date"
import { cn } from "@/utils/tailwind"

import { DottedTitle } from "../DottedTitle"
import { FillCrossLoader } from "../FullScreenLoader"
import { MapZoomControls } from "../MapZoomControls"
import { CardContent } from "../primitives/Card"
import { Divider } from "../primitives/Divider"
import { Progress } from "../primitives/Progress"
import SectorMap, { type MapConfig } from "../SectorMap"

import type { GetMapRegionAction } from "@/types/actions"

const MAP_CONFIG: MapConfig = {
  debug: false,
  clickable: true,
  show_sector_ids: false,
  show_partial_lanes: true,
  show_ports: true,
  show_grid: true,
  show_port_labels: true,
  nodeStyles: {
    current: {
      glow: true,
      offset: true,
      outlineWidth: 6,
      borderPosition: "center",
    },
  },
}

export const DEFAULT_MAX_BOUNDS = 12
export const MAX_BOUNDS_PADDING = 2
export const MIN_BOUNDS = 4
export const MAX_BOUNDS = 50

export const MapNodeDetails = ({ node }: { node?: MapSectorNode | null }) => {
  if (!node) return null

  const qf_state = node.port?.split("")[0] === "B" ? "buy" : "sell"
  const ro_state = node.port?.split("")[1] === "B" ? "buy" : "sell"
  const ns_state = node.port?.split("")[2] === "B" ? "buy" : "sell"

  return (
    <div className="absolute top-0 left-0 w-70 h-fit bg-background border border-border p-ui-sm flex flex-col gap-2 shadow-long">
      <DottedTitle title={`Sector ${node.id.toString()}`} textColor="text-white" />
      <div className="flex flex-col gap-2 uppercase text-xxs text-foreground">
        <div className="flex flex-row justify-between gap-2">
          <span className="font-bold">Region</span>
          <span className="">{node.region}</span>
        </div>
        <div className="flex flex-row justify-between gap-2">
          <span className="font-bold">Visited</span>
          <span className="">
            {node.visited ? node.source : <XIcon size={16} className="text-accent-foreground" />}
          </span>
        </div>
        <div className="flex flex-row justify-between gap-2">
          <span className="font-bold">Adjacent sectors</span>
          <span className="">{node.lanes?.map((lane) => lane.to).join(",")}</span>
        </div>
        <div className="flex flex-row justify-between gap-2">
          <span className="font-bold">Hops from center</span>
          <span className="">{node.hops_from_center?.toString()}</span>
        </div>
        <div className="flex flex-row justify-between gap-2">
          <span className="font-bold">Last visited</span>
          <span className="">
            {node.last_visited ? formatTimeAgoOrDate(node.last_visited) : "Never"}
          </span>
        </div>
      </div>
      {node.port && (
        <>
          <DottedTitle title={`Port ${node.port}`} textColor="text-white" />
          <div className="flex flex-row justify-between gap-2">
            <span className="font-bold text-xs inline-flex items-center gap-1">
              <QuantumFoamIcon size={16} /> QF
            </span>
            <span
              className={cn(
                qf_state === "buy" ? "text-success" : "text-warning",
                "text-xxs uppercase"
              )}
            >
              {qf_state}
            </span>
          </div>
          <div className="flex flex-row justify-between gap-2">
            <span className="font-bold text-xs inline-flex items-center gap-1">
              <RetroOrganicsIcon size={16} /> RO
            </span>
            <span
              className={cn(
                ro_state === "buy" ? "text-success" : "text-warning",
                "text-xxs uppercase"
              )}
            >
              {ro_state}
            </span>
          </div>
          <div className="flex flex-row justify-between gap-2">
            <span className="font-bold text-xs inline-flex items-center gap-1">
              <NeuroSymbolicsIcon size={16} /> NS
            </span>
            <span
              className={cn(
                ns_state === "buy" ? "text-success" : "text-warning",
                "text-xxs uppercase"
              )}
            >
              {ns_state}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
export const MapScreen = ({ config }: { config?: MapConfig }) => {
  const player = useGameStore((state) => state.player)
  const sector = useGameStore.use.sector?.()
  const mapData = useGameStore.use.regional_map_data?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const ships = useGameStore.use.ships?.()
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const [centerSector, setCenterSector] = useState<number | undefined>(undefined)
  const [hoveredNode, setHoveredNode] = useState<MapSectorNode | null>(null)

  const [isFetching, setIsFetching] = useState(false)

  const initialFetchRef = useRef(false)

  const mapConfig = useMemo(() => {
    if (!config) return MAP_CONFIG
    return deepmerge(MAP_CONFIG, config) as MapConfig
  }, [config])

  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  // Initial fetch of map data
  useEffect(() => {
    if (initialFetchRef.current) return

    if (sector !== undefined && sector.id !== undefined) {
      initialFetchRef.current = true

      // Get the initial zoom level inline to avoid a re-trigger loop
      const initBounds =
        (useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS) + MAX_BOUNDS_PADDING

      console.debug(
        `%c[GAME MAP SCREEN] Initial fetch for current sector ${sector?.id} with bounds ${initBounds}`,
        "font-weight: bold; color: #4CAF50;"
      )

      dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: sector.id,
          bounds: initBounds,
        },
      } as GetMapRegionAction)
    }
  }, [sector, dispatchAction, mapZoomLevel])

  const updateCenterSector = useCallback(
    (node: MapSectorNode | null) => {
      // Click on empty space deselects (resets to current sector)
      setCenterSector(node?.id ?? sector?.id)
    },
    [setCenterSector, sector?.id]
  )

  // Handles fetching map data when the center sector we select
  // knows there are adjacent sectors culled by bounds
  const handleMapFetch = useCallback(
    (centerSectorId: number) => {
      if (!initialFetchRef.current) return

      console.debug(
        "%c[GAME MAP SCREEN] Fetching map data to fulfill bounds",
        "color: #4CAF50;",
        centerSectorId
      )

      setIsFetching(true)
      const bounds =
        (useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS) + MAX_BOUNDS_PADDING

      dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: centerSectorId,
          bounds: bounds,
        },
      } as GetMapRegionAction)
    },
    [dispatchAction, setIsFetching]
  )

  // When map data mutates after a fetch, set loading to false
  useEffect(() => {
    queueMicrotask(() => setIsFetching(false))
  }, [mapData])

  return (
    <div className="flex flex-row gap-3 w-full h-full relative">
      <div className="flex-1 relative">
        <MapNodeDetails node={hoveredNode} />
        <header className="absolute top-0 right-0 flex flex-col gap-ui-xs p-ui-md w-72">
          <MapZoomControls />
          <Divider color="secondary" />
          {centerSector !== undefined && centerSector !== sector?.id && (
            <Badge
              variant="secondary"
              border="bracket"
              size="sm"
              className="w-full -bracket-offset-0"
            >
              Selected Sector:
              <span className="font-extrabold">{centerSector}</span>
            </Badge>
          )}
        </header>

        <footer className="absolute bottom-0 left-0 w-full h-fit p-ui-md">
          <MapLegend />
        </footer>

        {isFetching && <FillCrossLoader message="Fetching map data" className="bg-card/40" />}

        {mapData ?
          <SectorMap
            center_sector_id={centerSector}
            current_sector_id={sector ? sector.id : undefined}
            config={mapConfig}
            map_data={mapData ?? []}
            maxDistance={mapZoomLevel ?? DEFAULT_MAX_BOUNDS}
            showLegend={false}
            onNodeClick={updateCenterSector}
            onNodeEnter={(node) => {
              setHoveredNode(node)
            }}
            onNodeExit={() => {
              setHoveredNode(null)
            }}
            onMapFetch={handleMapFetch}
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
      </aside>
    </div>
  )
}

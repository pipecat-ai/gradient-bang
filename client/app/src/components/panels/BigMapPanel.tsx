import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { deepmerge } from "deepmerge-ts"
import { XIcon } from "@phosphor-icons/react"

import PlanetLoader from "@/assets/videos/planet-loader.mp4"
import { DottedTitle } from "@/components/DottedTitle"
import { FillCrossLoader } from "@/components/FullScreenLoader"
import { MapLegend } from "@/components/MapLegends"
import { MapZoomControls } from "@/components/MapZoomControls"
import { Divider } from "@/components/primitives/Divider"
import SectorMap, { type MapConfig } from "@/components/SectorMap"
import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatTimeAgoOrDate } from "@/utils/date"
import { getFetchBounds } from "@/utils/map"
import { getPortCode } from "@/utils/port"
import { cn } from "@/utils/tailwind"

import { DEFAULT_MAX_BOUNDS, PENDING_MAP_FETCH_STALE_MS } from "@/types/constants"

const MAP_CONFIG: MapConfig = {
  debug: false,
  camera_viewport_mode: "viewport_rect",
  highlight_center_sector: false,
  clickable: true,
  draggable: true,
  scrollZoom: true,
  show_sector_ids: false,
  show_partial_lanes: true,
  show_ports: true,
  show_grid: true,
  show_port_labels: true,
  uiStyles: {
    background: {
      color: "rgba(0,0,0,0.95)",
    },
    edgeFeather: {
      size: 180,
      falloff: 3,
    },
  },
  nodeStyles: {
    current: {
      glow: true,
      offset: true,
      outlineWidth: 6,
      borderPosition: "center",
    },
  },
}

const CommodityRow = ({
  icon,
  label,
  state,
}: {
  icon: React.ReactNode
  label: string
  state: "buy" | "sell"
}) => (
  <div className="flex flex-row justify-between gap-2">
    <dt className="font-bold text-xs inline-flex items-center gap-1">
      {icon} {label}
    </dt>
    <dd className={cn(state === "buy" ? "text-success" : "text-warning", "text-xxs uppercase")}>
      {state}
    </dd>
  </div>
)

const MapNodeDetails = ({ node }: { node?: MapSectorNode | null }) => {
  if (!node) return null

  const portCode = getPortCode(node.port ?? null)
  const qf_state = portCode[0] === "B" ? "buy" : "sell"
  const ro_state = portCode[1] === "B" ? "buy" : "sell"
  const ns_state = portCode[2] === "B" ? "buy" : "sell"

  return (
    <aside className="z-90 absolute top-ui-sm left-0 w-70 h-fit flex flex-row gap-4 bg-background border border-border border-l-0 p-ui-sm shadow-long shadow-black/25">
      <Divider
        orientation="vertical"
        variant="dashed"
        className="h-auto w-3 self-stretch text-accent"
      />
      <div className="flex flex-col gap-2 flex-1">
        <DottedTitle title={`Sector ${node.id.toString()}`} textColor="text-foreground" />
        <dl className="flex flex-col gap-2 uppercase text-xxs text-foreground">
          <div className="flex flex-row justify-between gap-2">
            <dt className="font-bold">Region</dt>
            <dd className="text-muted-foreground">{node.region}</dd>
          </div>
          <div className="flex flex-row justify-between gap-2">
            <dt className="font-bold">Visited</dt>
            <dd className="text-muted-foreground">
              {node.visited ? node.source : <XIcon size={16} className="text-accent-foreground" />}
            </dd>
          </div>
          <div className="flex flex-row justify-between gap-2">
            <dt className="font-bold">Adjacent sectors</dt>
            <dd className="text-muted-foreground">
              {node.lanes?.map((lane) => lane.to).join(",")}
            </dd>
          </div>
          <div className="flex flex-row justify-between gap-2">
            <dt className="font-bold">Hops from center</dt>
            <dd className="text-muted-foreground">{node.hops_from_center?.toString()}</dd>
          </div>
          <div className="flex flex-row justify-between gap-2">
            <dt className="font-bold">Last visited</dt>
            <dd className="text-muted-foreground">
              {node.last_visited ? formatTimeAgoOrDate(node.last_visited) : "Never"}
            </dd>
          </div>
        </dl>
        {portCode && (
          <dl className="flex flex-col gap-2">
            <DottedTitle title={`Port ${portCode.toUpperCase()}`} textColor="text-white" />
            <CommodityRow icon={<QuantumFoamIcon size={16} />} label="QF" state={qf_state} />
            <CommodityRow icon={<RetroOrganicsIcon size={16} />} label="RO" state={ro_state} />
            <CommodityRow icon={<NeuroSymbolicsIcon size={16} />} label="NS" state={ns_state} />
          </dl>
        )}
      </div>
    </aside>
  )
}

export const BigMapPanel = ({ config }: { config?: MapConfig }) => {
  const sector = useGameStore.use.sector?.()
  const mapData = useGameStore.use.regional_map_data?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const ships = useGameStore.use.ships?.()
  const mapCenterSector = useGameStore((state) => state.mapCenterSector)
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const mapCenterWorld = useGameStore((state) => state.mapCenterWorld)
  const mapFitBoundsWorld = useGameStore((state) => state.mapFitBoundsWorld)
  const mapFitEpoch = useGameStore((state) => state.mapFitEpoch)
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const setMapCenterSector = useGameStore.use.setMapCenterSector?.()
  const setMapCenterWorld = useGameStore.use.setMapCenterWorld?.()
  const requestMapFetch = useGameStore.use.requestMapFetch?.()
  const setMapZoomLevel = useGameStore.use.setMapZoomLevel?.()

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

    const initialCenter = mapCenterSector ?? sector?.id
    if (initialCenter !== undefined) {
      initialFetchRef.current = true

      const state = useGameStore.getState()
      const initBounds = getFetchBounds(state.mapZoomLevel ?? DEFAULT_MAX_BOUNDS)

      console.debug(
        `%c[GAME MAP SCREEN] Initial fetch for current sector ${initialCenter} with bounds ${initBounds}`,
        "font-weight: bold; color: #4CAF50;"
      )

      queueMicrotask(() => setIsFetching(true))
      dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: initialCenter,
          bounds: initBounds,
        },
      })
    }
  }, [mapCenterSector, sector, dispatchAction])

  const updateCenterSector = useCallback(
    (node: MapSectorNode | null) => {
      // Ignore empty-space clicks to avoid accidental recenter
      if (!node) return
      setMapCenterWorld?.(undefined)
      setMapCenterSector?.(node.id)
    },
    [setMapCenterSector, setMapCenterWorld]
  )

  // Handles fetching map data when SectorMap signals a viewport intent change
  const handleMapFetch = useCallback(
    (centerSectorId: number, bounds: number) => {
      if (!initialFetchRef.current) return

      const didFetch = requestMapFetch?.(centerSectorId, bounds)
      if (didFetch) {
        setIsFetching(true)
      }
    },
    [requestMapFetch, setIsFetching]
  )

  // Sync zoom controls when user scroll-zooms on the map
  const handleZoomChange = useCallback(
    (zoomLevel: number) => {
      setMapZoomLevel?.(zoomLevel)
    },
    [setMapZoomLevel]
  )

  // When map data mutates after a fetch, set loading to false
  useEffect(() => {
    if (mapData !== undefined) {
      queueMicrotask(() => setIsFetching(false))
    }
  }, [mapData])

  // Ensure transient request state does not keep controls disabled indefinitely
  useEffect(() => {
    if (!isFetching) return
    const timeoutId = window.setTimeout(() => {
      setIsFetching(false)
    }, PENDING_MAP_FETCH_STALE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [isFetching])

  return (
    <div className="group relative flex flex-row gap-3 w-full h-full">
      <div className="flex-1 relative">
        <MapNodeDetails node={hoveredNode} />
        <header className="absolute top-ui-sm right-ui-sm flex flex-col gap-ui-xs w-fit h-fit">
          <MapZoomControls disabled={isFetching || !mapData} />
        </header>

        <footer className="absolute bottom-ui-xs left-ui-xs w-full h-fit z-20">
          <MapLegend />
        </footer>

        {mapData && isFetching && (
          <FillCrossLoader
            message="Fetching map data"
            className="bg-transparent pointer-events-none"
          />
        )}

        {mapData ?
          <SectorMap
            center_sector_id={mapCenterSector ?? sector?.id}
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
            onZoomChange={handleZoomChange}
            coursePlot={coursePlot ?? null}
            ships={shipSectors}
            center_world={mapCenterWorld}
            fit_bounds_world={mapFitBoundsWorld}
            mapFitEpoch={mapFitEpoch}
          />
        : <div className="relative w-full h-full flex items-center justify-center cross-lines-white/50 cross-lines-offset-12">
            <div className="elbow relative z-99 flex flex-col gap-3 bg-black border border-border p-6 animate-in fade-in-0 duration-300">
              <video
                src={PlanetLoader}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                aria-hidden="true"
                className="w-30 h-30 object-contain mx-auto"
              />

              <span className="text-muted-foreground text-sm uppercase animate-pulse">
                Awaiting map data...
              </span>
            </div>
          </div>
        }
      </div>
    </div>
  )
}

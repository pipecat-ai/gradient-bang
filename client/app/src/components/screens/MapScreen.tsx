import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { deepmerge } from "deepmerge-ts"
import { XIcon } from "@phosphor-icons/react"

import PlanetLoader from "@/assets/videos/planet-loader.mp4"
import { MapLegend } from "@/components/MapLegends"
import { MovementHistoryPanel } from "@/components/panels/DataTablePanels"
import { Badge } from "@/components/primitives/Badge"
import { Button } from "@/components/primitives/Button"
import { Separator } from "@/components/primitives/Separator"
import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatTimeAgoOrDate } from "@/utils/date"
import { DEFAULT_MAX_BOUNDS, getFetchBounds } from "@/utils/mapZoom"
import { getPortCode } from "@/utils/port"
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

export const MapNodeDetails = ({ node }: { node?: MapSectorNode | null }) => {
  if (!node) return null

  const portCode = getPortCode(node.port ?? null)
  const qf_state = portCode[0] === "B" ? "buy" : "sell"
  const ro_state = portCode[1] === "B" ? "buy" : "sell"
  const ns_state = portCode[2] === "B" ? "buy" : "sell"

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
      {portCode && (
        <>
          <DottedTitle title={`Port ${portCode.toUpperCase()}`} textColor="text-white" />
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
export const MapScreen = ({
  config,
  variant = "full",
}: {
  config?: MapConfig
  variant?: "full" | "embedded"
}) => {
  const player = useGameStore((state) => state.player)
  const sector = useGameStore.use.sector?.()
  const mapData = useGameStore.use.regional_map_data?.()
  const coursePlot = useGameStore.use.course_plot?.()
  const ships = useGameStore.use.ships?.()
  const mapZoomLevel = useGameStore((state) => state.mapZoomLevel)
  const clearCoursePlot = useGameStore.use.clearCoursePlot?.()
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const mapCenterSector = useGameStore.use.mapCenterSector?.()
  const setMapCenterSector = useGameStore.use.setMapCenterSector?.()
  const mapCenterWorld = useGameStore.use.mapCenterWorld?.()
  const setMapCenterWorld = useGameStore.use.setMapCenterWorld?.()
  const mapFitBoundsWorld = useGameStore.use.mapFitBoundsWorld?.()
  const setMapFitBoundsWorld = useGameStore.use.setMapFitBoundsWorld?.()
  const mapFitEpoch = useGameStore((state) => state.mapFitEpoch)
  const pendingMapFitSectors = useGameStore((state) => state.pendingMapFitSectors)
  const fitMapToSectors = useGameStore.use.fitMapToSectors?.()
  const requestMapAutoRecenter = useGameStore.use.requestMapAutoRecenter?.()
  const [hoveredNode, setHoveredNode] = useState<MapSectorNode | null>(null)

  const [isFetching, setIsFetching] = useState(false)

  const initialFetchRef = useRef(false)
  const autoFitRef = useRef(false)

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

      // Get the initial zoom level inline to avoid a re-trigger loop
      const initBounds = getFetchBounds(
        useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS
      )

      console.debug(
        `%c[GAME MAP SCREEN] Initial fetch for current sector ${sector?.id} with bounds ${initBounds}`,
        "font-weight: bold; color: #4CAF50;"
      )

      requestMapAutoRecenter?.("map-screen-initial")

      dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: initialCenter,
          bounds: initBounds,
        },
      } as GetMapRegionAction)
    }
  }, [mapCenterSector, sector, dispatchAction, mapZoomLevel, requestMapAutoRecenter])

  const updateCenterSector = useCallback(
    (node: MapSectorNode | null) => {
      // Click on empty space deselects (resets to current sector)
      setMapCenterWorld?.(undefined)
      setMapFitBoundsWorld?.(undefined)
      if (!node) {
        setMapCenterSector?.(sector?.id)
        return
      }

      const isDiscovered = Boolean(node.visited || node.source)
      if (isDiscovered) {
        setMapCenterSector?.(node.id)
        return
      }

      const candidates = (mapData ?? []).filter(
        (entry) => entry.visited || entry.source
      )
      if (candidates.length === 0) {
        setMapCenterSector?.(sector?.id ?? node.id)
        return
      }

      const SQRT3 = Math.sqrt(3)
      const toWorld = (pos: [number, number]) => ({
        x: 1.5 * pos[0],
        y: SQRT3 * (pos[1] + 0.5 * (pos[0] & 1)),
      })
      const targetWorld = toWorld(node.position)
      let best = candidates[0]
      let bestDist = Infinity
      for (const candidate of candidates) {
        if (!candidate.position) continue
        const world = toWorld(candidate.position)
        const dx = world.x - targetWorld.x
        const dy = world.y - targetWorld.y
        const dist = dx * dx + dy * dy
        if (dist < bestDist) {
          best = candidate
          bestDist = dist
        }
      }

      if (best.id !== node.id) {
        console.debug("[GAME MAP SCREEN] Click fallback to discovered sector", {
          requested: node.id,
          fallback: best.id,
        })
      }

      setMapCenterSector?.(best.id ?? sector?.id ?? node.id)
    },
    [setMapCenterSector, setMapCenterWorld, setMapFitBoundsWorld, sector?.id, mapData]
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
      const bounds = getFetchBounds(
        useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS
      )

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

  // Auto-fit on first map load if no explicit zoom/fit is set yet.
  useEffect(() => {
    if (autoFitRef.current) return
    if (!mapData || mapData.length === 0) return
    if (pendingMapFitSectors && pendingMapFitSectors.length > 0) return
    if (mapZoomLevel !== undefined) return
    if (mapFitBoundsWorld !== undefined || mapFitEpoch !== undefined) return

    const sectorIds = mapData
      .map((sector) => sector.id)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id))
    if (sectorIds.length === 0) return

    autoFitRef.current = true
    console.debug("[GAME MAP SCREEN] Auto-fitting to initial map data", {
      count: sectorIds.length,
    })
    fitMapToSectors?.(sectorIds)
  }, [
    mapData,
    mapZoomLevel,
    mapFitBoundsWorld,
    mapFitEpoch,
    pendingMapFitSectors,
    fitMapToSectors,
  ])

  const isEmbedded = variant === "embedded"

  const mapContainerClass = isEmbedded ? "w-full h-full relative" : "flex-1 relative"

  return (
    <div
      className={cn(
        "w-full h-full relative",
        !isEmbedded ? "flex flex-row gap-3" : ""
      )}
    >
      <div className={mapContainerClass}>
        {!isEmbedded && <MapNodeDetails node={hoveredNode} />}
        {!isEmbedded && (
          <header className="absolute top-0 right-0 flex flex-col gap-ui-xs p-ui-md w-72">
            <MapZoomControls />
            <Button
              variant="outline"
              size="sm"
              disabled={!coursePlot}
              onClick={() => clearCoursePlot?.()}
            >
              Clear Highlight
            </Button>
            <Divider color="secondary" />
            {sector?.id !== undefined && (
              <Badge
                variant="secondary"
                border="bracket"
                size="sm"
                className="w-full -bracket-offset-0"
              >
                Current Sector:
                <span className="font-extrabold">{sector.id}</span>
              </Badge>
            )}
          </header>
        )}

        <footer className="absolute bottom-0 left-0 w-full h-fit p-ui-md">
          <MapLegend />
        </footer>

        {isFetching && <FillCrossLoader message="Fetching map data" className="bg-card/40" />}

        {mapData ?
          <SectorMap
            center_sector_id={mapCenterSector}
            centerWorld={mapCenterWorld}
            fitBoundsWorld={mapFitBoundsWorld}
            mapFitEpoch={mapFitEpoch}
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

      {!isEmbedded && (
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
          <MovementHistoryPanel className="flex-1 min-h-0" />
        </aside>
      )}
    </div>
  )
}

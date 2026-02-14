import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { deepmerge } from "deepmerge-ts"
import { XIcon } from "@phosphor-icons/react"

import PlanetLoader from "@/assets/videos/planet-loader.mp4"
import { MapLegend } from "@/components/MapLegends"
import { NeuroSymbolicsIcon, QuantumFoamIcon, RetroOrganicsIcon } from "@/icons"
import useGameStore from "@/stores/game"
import { formatTimeAgoOrDate } from "@/utils/date"
import { getViewportFetchBounds, hexToWorld } from "@/utils/map"
import { getPortCode } from "@/utils/port"
import { cn } from "@/utils/tailwind"

import { DottedTitle } from "../DottedTitle"
import { FillCrossLoader } from "../FullScreenLoader"
import { MapZoomControls } from "../MapZoomControls"
import { Divider } from "../primitives/Divider"
import SectorMap, { type MapConfig } from "../SectorMap"

import type { GetMapRegionAction } from "@/types/actions"
import { DEFAULT_MAX_BOUNDS } from "@/types/constants"

const PENDING_MAP_REQUEST_STALE_MS = 8_000
const DEFAULT_VIEWPORT_WIDTH = 16
const DEFAULT_VIEWPORT_HEIGHT = 9
const COVERAGE_PADDING_WORLD = Math.sqrt(3)
const MAX_COVERAGE_RECTS = 32

interface WorldRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface PendingMapRequest {
  requestKey: string
  centerSectorId: number
  bounds: number
  requestedAt: number
  rect?: WorldRect
}

const rectContains = (outer: WorldRect, inner: WorldRect): boolean =>
  outer.minX <= inner.minX &&
  outer.maxX >= inner.maxX &&
  outer.minY <= inner.minY &&
  outer.maxY >= inner.maxY

const isRectCovered = (rect: WorldRect, candidates: WorldRect[]): boolean =>
  candidates.some((candidate) => rectContains(candidate, rect))

const addCoverageRect = (existing: WorldRect[], rect: WorldRect): WorldRect[] => {
  if (isRectCovered(rect, existing)) return existing
  const trimmed = existing.filter((candidate) => !rectContains(rect, candidate))
  const next = [...trimmed, rect]
  if (next.length <= MAX_COVERAGE_RECTS) return next
  return next.slice(next.length - MAX_COVERAGE_RECTS)
}

const MAP_CONFIG: MapConfig = {
  debug: false,
  camera_viewport_mode: "viewport_rect",
  highlight_center_sector: false,
  clickable: true,
  show_sector_ids: false,
  show_partial_lanes: true,
  show_ports: true,
  show_grid: true,
  show_port_labels: true,
  uiStyles: {
    edgeFeather: {
      size: 90,
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
  const pendingMapCenterRequest = useGameStore((state) => state.pendingMapCenterRequestRef)
  const mapViewportWidth = useGameStore((state) => state.mapViewportWidth)
  const mapViewportHeight = useGameStore((state) => state.mapViewportHeight)
  const dispatchAction = useGameStore.use.dispatchAction?.()
  const setMapCenterSector = useGameStore.use.setMapCenterSector?.()
  const setMapCenterWorld = useGameStore.use.setMapCenterWorld?.()
  const setMapViewportSize = useGameStore.use.setMapViewportSize?.()
  const [hoveredNode, setHoveredNode] = useState<MapSectorNode | null>(null)

  const [isFetching, setIsFetching] = useState(false)
  const mapViewportRef = useRef<HTMLDivElement | null>(null)

  const initialFetchRef = useRef(false)
  const confirmedCoverageRef = useRef<WorldRect[]>([])
  const inFlightRequestsRef = useRef<PendingMapRequest[]>([])
  const pendingMapRequestRef = useRef<PendingMapRequest | null>(null)

  const mapConfig = useMemo(() => {
    if (!config) return MAP_CONFIG
    return deepmerge(MAP_CONFIG, config) as MapConfig
  }, [config])

  const shipSectors = ships?.data
    ?.filter((s: ShipSelf) => s.owner_type !== "personal")
    .map((s: ShipSelf) => s.sector ?? 0)

  const pruneStaleInFlightRequests = useCallback(() => {
    const now = Date.now()
    inFlightRequestsRef.current = inFlightRequestsRef.current.filter(
      (request) => now - request.requestedAt < PENDING_MAP_REQUEST_STALE_MS
    )
  }, [])

  const resolveCenterWorld = useCallback(
    (centerSectorId: number): [number, number] | undefined => {
      const centerNode = mapData?.find((node) => node.id === centerSectorId)
      const centerPosition =
        centerNode?.position ??
        (sector?.id === centerSectorId && sector.position ? sector.position : undefined)
      if (!centerPosition) return undefined
      const world = hexToWorld(centerPosition[0], centerPosition[1])
      return [world.x, world.y]
    },
    [mapData, sector?.id, sector?.position]
  )

  const buildCoverageRect = useCallback(
    (
      centerSectorId: number,
      bounds: number,
      _viewportWidth: number,
      _viewportHeight: number
    ): WorldRect | undefined => {
      const centerWorld = resolveCenterWorld(centerSectorId)
      if (!centerWorld) return undefined

      // `bounds` already includes viewport-aspect scaling from getViewportFetchBounds().
      // Treat it as an isotropic fetch radius here to avoid over-claiming coverage.
      const maxWorldDistance = bounds * Math.sqrt(3)

      return {
        minX: centerWorld[0] - maxWorldDistance - COVERAGE_PADDING_WORLD,
        maxX: centerWorld[0] + maxWorldDistance + COVERAGE_PADDING_WORLD,
        minY: centerWorld[1] - maxWorldDistance - COVERAGE_PADDING_WORLD,
        maxY: centerWorld[1] + maxWorldDistance + COVERAGE_PADDING_WORLD,
      }
    },
    [resolveCenterWorld]
  )

  const registerInFlightRequest = useCallback(
    (request: PendingMapRequest) => {
      pruneStaleInFlightRequests()
      inFlightRequestsRef.current = [
        ...inFlightRequestsRef.current.filter((entry) => entry.requestKey !== request.requestKey),
        request,
      ]
      pendingMapRequestRef.current = request
    },
    [pruneStaleInFlightRequests]
  )

  const dispatchMapFetch = useCallback(
    (centerSectorId: number, bounds: number, rect?: WorldRect) => {
      const now = Date.now()
      const state = useGameStore.getState()
      const viewportWidth = state.mapViewportWidth ?? DEFAULT_VIEWPORT_WIDTH
      const viewportHeight = state.mapViewportHeight ?? DEFAULT_VIEWPORT_HEIGHT
      const requestRect = rect ?? buildCoverageRect(centerSectorId, bounds, viewportWidth, viewportHeight)
      const request: PendingMapRequest = {
        requestKey: `${centerSectorId}:${bounds}`,
        centerSectorId,
        bounds,
        requestedAt: now,
        rect: requestRect,
      }
      registerInFlightRequest(request)
      dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: centerSectorId,
          bounds,
        },
      } as GetMapRegionAction)
    },
    [buildCoverageRect, dispatchAction, registerInFlightRequest]
  )

  // Track viewport dimensions even before map data is available, so initial bounds
  // are computed from the real panel size instead of a guessed aspect ratio.
  useLayoutEffect(() => {
    const container = mapViewportRef.current
    if (!container) return

    const updateViewport = (width: number, height: number) => {
      if (width > 0 && height > 0) {
        setMapViewportSize?.(width, height)
      }
    }

    const rect = container.getBoundingClientRect()
    updateViewport(rect.width, rect.height)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateViewport(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [setMapViewportSize])

  // Initial fetch of map data
  useEffect(() => {
    if (initialFetchRef.current) return
    pruneStaleInFlightRequests()

    const initialCenter = mapCenterSector ?? sector?.id
    if (initialCenter !== undefined) {
      const containerRect = mapViewportRef.current?.getBoundingClientRect()
      const initialViewportWidth =
        containerRect && containerRect.width > 0 ?
          containerRect.width
        : (mapViewportWidth ?? DEFAULT_VIEWPORT_WIDTH)
      const initialViewportHeight =
        containerRect && containerRect.height > 0 ?
          containerRect.height
        : (mapViewportHeight ?? DEFAULT_VIEWPORT_HEIGHT)
      setMapViewportSize?.(initialViewportWidth, initialViewportHeight)

      initialFetchRef.current = true

      // Get the initial zoom level inline to avoid a re-trigger loop
      const initBounds = getViewportFetchBounds(
        useGameStore.getState().mapZoomLevel ?? DEFAULT_MAX_BOUNDS,
        initialViewportWidth,
        initialViewportHeight
      )
      const initRect = buildCoverageRect(
        initialCenter,
        initBounds,
        initialViewportWidth,
        initialViewportHeight
      )
      if (initRect && isRectCovered(initRect, confirmedCoverageRef.current)) {
        return
      }
      const inFlightRects = inFlightRequestsRef.current
        .map((request) => request.rect)
        .filter((rect): rect is WorldRect => rect !== undefined)
      if (initRect && isRectCovered(initRect, inFlightRects)) {
        return
      }

      console.debug(
        `%c[GAME MAP SCREEN] Initial fetch for current sector ${initialCenter} with bounds ${initBounds}`,
        "font-weight: bold; color: #4CAF50;"
      )

      setIsFetching(true)
      dispatchMapFetch(initialCenter, initBounds, initRect)
    }
  }, [
    buildCoverageRect,
    dispatchMapFetch,
    mapCenterSector,
    mapViewportHeight,
    mapViewportWidth,
    pruneStaleInFlightRequests,
    sector?.id,
    setMapViewportSize,
  ])

  // Seed request dedupe when mapSlice dispatches center requests directly (control_ui path).
  useEffect(() => {
    if (!pendingMapCenterRequest) return
    const state = useGameStore.getState()
    const viewportWidth = state.mapViewportWidth ?? DEFAULT_VIEWPORT_WIDTH
    const viewportHeight = state.mapViewportHeight ?? DEFAULT_VIEWPORT_HEIGHT
    const rect = buildCoverageRect(
      pendingMapCenterRequest.centerSector,
      pendingMapCenterRequest.bounds,
      viewportWidth,
      viewportHeight
    )
    registerInFlightRequest({
      requestKey: `${pendingMapCenterRequest.centerSector}:${pendingMapCenterRequest.bounds}`,
      centerSectorId: pendingMapCenterRequest.centerSector,
      bounds: pendingMapCenterRequest.bounds,
      requestedAt: pendingMapCenterRequest.requestedAt,
      rect,
    })
    setIsFetching(true)
  }, [buildCoverageRect, pendingMapCenterRequest, registerInFlightRequest])

  const updateCenterSector = useCallback(
    (node: MapSectorNode | null) => {
      // Ignore empty-space clicks to avoid accidental recenter to player sector.
      if (!node) return
      setMapCenterWorld?.(undefined)
      setMapCenterSector?.(node.id)
    },
    [setMapCenterSector, setMapCenterWorld]
  )

  const handleViewportSizeChange = useCallback(
    (width: number, height: number) => {
      setMapViewportSize?.(width, height)
    },
    [setMapViewportSize]
  )

  // Handles fetching map data when the center sector we select
  // knows there are adjacent sectors culled by bounds
  const handleMapFetch = useCallback(
    (centerSectorId: number, requestedBounds?: number) => {
      if (!initialFetchRef.current) return

      const state = useGameStore.getState()
      const viewportWidth = state.mapViewportWidth ?? DEFAULT_VIEWPORT_WIDTH
      const viewportHeight = state.mapViewportHeight ?? DEFAULT_VIEWPORT_HEIGHT
      console.debug(
        "%c[GAME MAP SCREEN] Fetching map data to fulfill bounds",
        "color: #4CAF50;",
        centerSectorId
      )

      const bounds =
        typeof requestedBounds === "number" && Number.isFinite(requestedBounds) ?
          requestedBounds
        : getViewportFetchBounds(
            state.mapZoomLevel ?? DEFAULT_MAX_BOUNDS,
            viewportWidth,
            viewportHeight
          )
      const requestRect = buildCoverageRect(centerSectorId, bounds, viewportWidth, viewportHeight)

      pruneStaleInFlightRequests()
      if (requestRect && isRectCovered(requestRect, confirmedCoverageRef.current)) {
        console.debug(
          "%c[GAME MAP SCREEN] Skipping covered map fetch request",
          "color: #4CAF50;",
          centerSectorId,
          bounds
        )
        return
      }
      const inFlightRects = inFlightRequestsRef.current
        .map((request) => request.rect)
        .filter((rect): rect is WorldRect => rect !== undefined)
      if (requestRect && isRectCovered(requestRect, inFlightRects)) {
        console.debug(
          "%c[GAME MAP SCREEN] Skipping in-flight covered map fetch request",
          "color: #4CAF50;",
          centerSectorId,
          bounds
        )
        return
      }
      if (!requestRect) {
        const pending = pendingMapRequestRef.current
        const now = Date.now()
        const isSamePendingRequest =
          pending !== null &&
          now - pending.requestedAt < PENDING_MAP_REQUEST_STALE_MS &&
          pending.centerSectorId === centerSectorId &&
          pending.bounds >= bounds
        if (isSamePendingRequest) {
          return
        }
      }
      setIsFetching(true)
      dispatchMapFetch(centerSectorId, bounds, requestRect)
    },
    [buildCoverageRect, dispatchMapFetch, pruneStaleInFlightRequests]
  )

  // Promote in-flight requests to confirmed coverage only after map data updates.
  useEffect(() => {
    if (!mapData) return
    pruneStaleInFlightRequests()

    const pending = pendingMapRequestRef.current
    if (pending && isFetching) {
      const centerKnown =
        mapData.some((node) => node.id === pending.centerSectorId) ||
        (sector?.id === pending.centerSectorId && Boolean(sector.position))
      if (centerKnown && pending.rect) {
        confirmedCoverageRef.current = addCoverageRect(confirmedCoverageRef.current, pending.rect)
      }
      inFlightRequestsRef.current = inFlightRequestsRef.current.filter(
        (request) => request.requestKey !== pending.requestKey
      )
      pendingMapRequestRef.current = null
    }
    queueMicrotask(() => setIsFetching(false))
  }, [isFetching, mapData, pruneStaleInFlightRequests, sector?.id, sector?.position])

  // Ensure transient request state does not keep controls disabled indefinitely.
  useEffect(() => {
    if (!isFetching) return
    const timeoutId = window.setTimeout(() => {
      pruneStaleInFlightRequests()
      pendingMapRequestRef.current = null
      setIsFetching(false)
    }, PENDING_MAP_REQUEST_STALE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [isFetching, pruneStaleInFlightRequests])

  return (
    <div className="group relative flex flex-row gap-3 w-full h-full">
      <div ref={mapViewportRef} className="flex-1 relative">
        <MapNodeDetails node={hoveredNode} />
        <header className="absolute top-ui-sm right-ui-sm flex flex-col gap-ui-xs w-fit h-fit">
          <MapZoomControls disabled={isFetching || !mapData} />
        </header>

        <footer className="absolute bottom-ui-xs left-ui-xs w-full h-fit z-20">
          <MapLegend />
        </footer>

        {isFetching && (
          <FillCrossLoader message="Fetching map data" className="bg-card/40 pointer-events-none" />
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
            onViewportSizeChange={handleViewportSizeChange}
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
                className="w-[120px] h-[120px] object-contain mx-auto"
              />

              <span className="text-muted-foreground text-sm uppercase animate-pulse">
                Fetching map data...
              </span>
            </div>
          </div>
        }
      </div>
    </div>
  )
}

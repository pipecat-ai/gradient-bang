import { produce } from "immer"
import type { StateCreator } from "zustand"

import {
  addCoverageRect,
  buildCoverageRect,
  computeMapFit,
  computeWorldBounds,
  deduplicateMapNodes,
  findNearestDiscoveredSector,
  getNextZoomLevel,
  getVisibleNodes,
  hexToWorld,
  isRectCovered,
  normalizeMapData,
  normalizePort,
  type WorldRect,
} from "@/utils/map"

import type { GameStoreState } from "./game"

import {
  DEFAULT_MAX_BOUNDS,
  MAX_BOUNDS,
  MIN_BOUNDS,
  PENDING_MAP_FETCH_STALE_MS,
} from "@/types/constants"

const PENDING_REQUEST_TIMEOUT_MS = 10_000
const MAX_MAP_FIT_STALE_UPDATES = 5
const SQRT3 = Math.sqrt(3)

export interface MapCenterNode {
  centerSector: number
  bounds: number
  requestedAt: number
}

export interface MapUIActionPayload {
  mapCenterSector?: number
  mapZoomLevel?: number
  mapZoomDirection?: "in" | "out"
  highlightPath?: number[]
  fitSectors?: number[]
  clearCoursePlot?: boolean
}

export interface MapSlice {
  // --- Map data ---
  pendingMapCenterRequestRef: MapCenterNode | null
  local_map_data?: MapData
  regional_map_data?: MapData
  course_plot?: CoursePlot

  // --- Map UI state ---
  mapCenterSector?: number
  mapCenterWorld?: [number, number]
  mapFitBoundsWorld?: [number, number, number, number]
  mapZoomLevel?: number
  mapFitEpoch?: number
  mapResetEpoch: number
  pendingMapFitSectors?: number[]
  pendingMapFitMissingCount?: number
  coursePlotZoomEnabled: boolean
  mapLegendVisible: boolean
  // --- Map data methods ---
  setPendingMapCenterRequest: (centerNode: MapCenterNode) => void
  handleMapCenterFallback: () => void
  setLocalMapData: (localMapData: MapData) => void
  setRegionalMapData: (regionalMapData: MapData) => void
  updateMapSectors: (sectorUpdates: (Partial<MapSectorNode> & { id: number })[]) => void
  setCoursePlot: (coursePlot: CoursePlot) => void
  clearCoursePlot: () => void

  // --- Map UI methods ---
  setMapCenterSector: (sectorId: number | undefined) => void
  setMapCenterWorld: (center: [number, number] | undefined) => void
  setMapFitBoundsWorld: (bounds: [number, number, number, number] | undefined) => void
  setMapZoomLevel: (zoomLevel: number) => void
  requestMapFetch: (centerSectorId: number, bounds: number) => boolean
  clearPendingMapFit: () => void
  fitMapToSectors: (sectorIds: number[]) => void
  requestMapAutoRecenter: (reason: string) => void
  setCoursePlotZoomEnabled: (enabled: boolean) => void
  setMapLegendVisible: (visible: boolean) => void
  resetMapView: () => void

  // --- Compound actions ---
  handleMapUIAction: (payload: MapUIActionPayload) => void
}

export const createMapSlice: StateCreator<GameStoreState, [], [], MapSlice> = (set, get) => {
  // -----------------------------------------------------------------------
  // Closure state for fitMapToSectors retry logic
  // -----------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let _mapFitRetryCount = 0
  let _mapFitStaleUpdateCount = 0
  let _mapFitTrackedRequestKey: string | undefined

  const _getMapFitRequestKey = (sectorIds: number[]): string => sectorIds.join(",")

  const _resetMapFitRetryState = () => {
    _mapFitRetryCount = 0
    _mapFitStaleUpdateCount = 0
    _mapFitTrackedRequestKey = undefined
  }

  /** After map data arrives, check whether a pending fitMapToSectors can make progress. */
  const _maybeRetryMapFit = () => {
    const state = get()
    const pending = state.pendingMapFitSectors
    const prevMissing = state.pendingMapFitMissingCount
    if (!pending || pending.length === 0 || prevMissing == null) return

    const requestKey = _getMapFitRequestKey(pending)
    if (_mapFitTrackedRequestKey !== requestKey) {
      _mapFitTrackedRequestKey = requestKey
      _mapFitRetryCount = 0
      _mapFitStaleUpdateCount = 0
    }

    const combinedMap = deduplicateMapNodes(
      state.regional_map_data ?? [],
      state.local_map_data ?? []
    )
    const knownIds = new Set(combinedMap.map((n) => n.id))
    const stillMissing = pending.filter((id) => !knownIds.has(id)).length

    if (stillMissing >= prevMissing) {
      _mapFitStaleUpdateCount += 1
      if (_mapFitStaleUpdateCount >= MAX_MAP_FIT_STALE_UPDATES) {
        get().clearPendingMapFit()
      }
      return
    }

    _mapFitStaleUpdateCount = 0
    _mapFitRetryCount++
    get().fitMapToSectors(pending)
  }

  // -----------------------------------------------------------------------
  // Closure state for auto-recenter
  // -----------------------------------------------------------------------
  let autoRecenterRequested = false

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _maybeAutoRecenter = (_reason: string) => {
    if (!autoRecenterRequested) return

    const state = get()
    if (state.mapFitBoundsWorld) {
      autoRecenterRequested = false
      return
    }
    if (state.pendingMapFitSectors && state.pendingMapFitSectors.length > 0) {
      return
    }

    const nodes = deduplicateMapNodes(
      state.regional_map_data ?? [],
      state.local_map_data ?? []
    ).filter((n) => n.position)
    if (nodes.length === 0) return

    // Resolve center from state
    let centerWorld = state.mapCenterWorld
    if (!centerWorld) {
      const centerId = state.mapCenterSector ?? state.sector?.id
      const centerNode = centerId !== undefined ? nodes.find((n) => n.id === centerId) : undefined
      if (centerNode?.position) {
        const w = hexToWorld(centerNode.position[0], centerNode.position[1])
        centerWorld = [w.x, w.y]
      } else {
        const fallback = nodes.find((n) => n.position)
        if (fallback?.position) {
          const w = hexToWorld(fallback.position[0], fallback.position[1])
          centerWorld = [w.x, w.y]
        }
      }
    }
    if (!centerWorld) return

    // Compute new center from visible node bounds
    const zoomLevel = state.mapZoomLevel ?? DEFAULT_MAX_BOUNDS
    const visible = getVisibleNodes(nodes, centerWorld, zoomLevel)
    if (visible.length === 0) return

    const bounds = computeWorldBounds(visible)
    if (!bounds) return

    const dx = bounds.center[0] - centerWorld[0]
    const dy = bounds.center[1] - centerWorld[1]
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
      autoRecenterRequested = false
      return
    }

    set(
      produce((draft) => {
        draft.mapCenterWorld = bounds.center
        draft.mapFitBoundsWorld = undefined
      })
    )
    autoRecenterRequested = false
  }

  // -----------------------------------------------------------------------
  // Closure state for coverage tracking
  // -----------------------------------------------------------------------
  let _confirmedCoverage: WorldRect[] = []
  let _inFlightRequests: { key: string; rect: WorldRect | undefined; requestedAt: number }[] = []

  const _pruneStaleInFlightRequests = () => {
    const now = Date.now()
    _inFlightRequests = _inFlightRequests.filter(
      (r) => now - r.requestedAt < PENDING_MAP_FETCH_STALE_MS
    )
  }

  const _isAlreadyCovered = (rect: WorldRect | undefined): boolean => {
    if (!rect) return false
    if (isRectCovered(rect, _confirmedCoverage)) return true
    _pruneStaleInFlightRequests()
    const inFlightRects = _inFlightRequests
      .map((r) => r.rect)
      .filter((r): r is WorldRect => r !== undefined)
    return isRectCovered(rect, inFlightRects)
  }

  const _registerInFlightRequest = (key: string, rect: WorldRect | undefined) => {
    _pruneStaleInFlightRequests()
    _inFlightRequests = [
      ..._inFlightRequests.filter((r) => r.key !== key),
      { key, rect, requestedAt: Date.now() },
    ]
  }

  const _confirmInFlightRequest = (key: string) => {
    const request = _inFlightRequests.find((r) => r.key === key)
    if (request?.rect) {
      _confirmedCoverage = addCoverageRect(_confirmedCoverage, request.rect)
    }
    _inFlightRequests = _inFlightRequests.filter((r) => r.key !== key)
  }

  const _resolveCenterWorld = (sectorId: number): [number, number] | undefined => {
    const state = get()
    const allData = [...(state.regional_map_data ?? []), ...(state.local_map_data ?? [])]
    const node = allData.find((n) => n.id === sectorId)
    if (node?.position) {
      const w = hexToWorld(node.position[0], node.position[1])
      return [w.x, w.y]
    }
    if (state.sector?.id === sectorId && state.sector.position) {
      const w = hexToWorld(state.sector.position[0], state.sector.position[1])
      return [w.x, w.y]
    }
    return undefined
  }

  const _estimateZoomFromFitBounds = (
    fitBoundsWorld: [number, number, number, number] | undefined
  ): number | undefined => {
    if (!fitBoundsWorld || fitBoundsWorld.length !== 4) return undefined
    const [minX, maxX, minY, maxY] = fitBoundsWorld
    const halfWidth = Math.max(0, (maxX - minX) / 2)
    const halfHeight = Math.max(0, (maxY - minY) / 2)
    // Use 16:9 as a reasonable estimate — this is only for deriving a
    // starting zoom level for step-based zoom, so pixel-accuracy isn't needed.
    const aspect = 16 / 9
    const requiredMaxWorldDistance = Math.max(
      halfWidth / Math.max(1, aspect),
      halfHeight / Math.max(1, 1 / aspect)
    )
    const requiredHexDistance = requiredMaxWorldDistance / SQRT3
    return Math.max(MIN_BOUNDS, Math.min(MAX_BOUNDS, Math.ceil(requiredHexDistance) + 1))
  }

  // -----------------------------------------------------------------------
  // Slice state & methods
  // -----------------------------------------------------------------------
  return {
    // --- Map data state ---
    pendingMapCenterRequestRef: null,
    local_map_data: undefined,
    regional_map_data: undefined,
    course_plot: undefined,

    // --- Map UI state ---
    mapCenterSector: undefined,
    mapCenterWorld: undefined,
    mapFitBoundsWorld: undefined,
    mapZoomLevel: undefined,
    mapFitEpoch: undefined,
    pendingMapFitSectors: undefined,
    pendingMapFitMissingCount: undefined,
    coursePlotZoomEnabled: true,
    mapLegendVisible: false,
    mapResetEpoch: 0,
    // =================================================================
    // Map data methods
    // =================================================================

    setPendingMapCenterRequest: (centerNode: MapCenterNode) => {
      set(
        produce((state) => {
          state.pendingMapCenterRequestRef = centerNode
        })
      )
    },

    handleMapCenterFallback: () => {
      const state = get()

      const pending = state.pendingMapCenterRequestRef
      set(
        produce((s) => {
          s.pendingMapCenterRequestRef = null
        })
      )

      if (!pending || Date.now() - pending.requestedAt > PENDING_REQUEST_TIMEOUT_MS) {
        return
      }

      const mapData: MapData = [...(state.local_map_data ?? []), ...(state.regional_map_data ?? [])]

      let fallbackId = state.sector?.id
      if (fallbackId === undefined) {
        const nearest = findNearestDiscoveredSector(pending.centerSector, mapData)
        fallbackId = nearest?.id
      }

      if (fallbackId === undefined || fallbackId === pending.centerSector) {
        return
      }

      set(
        produce((s) => {
          s.mapCenterWorld = undefined
          s.mapFitBoundsWorld = undefined
          s.mapCenterSector = fallbackId
        })
      )

      state.dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: fallbackId,
          bounds: pending.bounds,
        },
      })
    },

    setLocalMapData: (localMapData: MapData) => {
      set(
        produce((state) => {
          const normalizedMapData = normalizeMapData(localMapData)
          if (!state.local_map_data) {
            state.local_map_data = normalizedMapData
            return
          }

          const existingById = new Map(
            state.local_map_data.map((s: MapSectorNode) => [s.id, s] as [number, MapSectorNode])
          )

          for (const sector of normalizedMapData) {
            existingById.set(sector.id, sector)
          }

          state.local_map_data = Array.from(existingById.values())
        })
      )
      _maybeRetryMapFit()
      _maybeAutoRecenter("map.local")
    },

    setRegionalMapData: (regionalMapData: MapData) => {
      set(
        produce((state) => {
          const normalizedMapData = normalizeMapData(regionalMapData)
          if (!state.regional_map_data) {
            state.regional_map_data = normalizedMapData
            return
          }

          const existingById = new Map(
            state.regional_map_data.map((s: MapSectorNode) => [s.id, s] as [number, MapSectorNode])
          )

          for (const sector of normalizedMapData) {
            existingById.set(sector.id, sector)
          }

          state.regional_map_data = Array.from(existingById.values())
        })
      )

      // Promote in-flight coverage for the pending center request
      const pending = get().pendingMapCenterRequestRef
      if (pending) {
        _confirmInFlightRequest(`${pending.centerSector}:${pending.bounds}`)
      }

      _maybeRetryMapFit()
      _maybeAutoRecenter("map.region")
    },

    updateMapSectors: (sectorUpdates: (Partial<MapSectorNode> & { id: number })[]) =>
      set(
        produce((state) => {
          const processMapUpdates = (
            mapData: MapSectorNode[] | undefined,
            ignoreLocal: boolean = false
          ): void => {
            if (!mapData) return

            const updates =
              ignoreLocal ?
                sectorUpdates.filter((s) => (s as MapSectorNode).source !== "player")
              : sectorUpdates

            const existingIndex = new Map<number, number>()
            mapData.forEach((s: MapSectorNode, idx: number) => existingIndex.set(s.id, idx))

            const hasExistingMatch =
              updates.length > 0 && updates.some((s) => existingIndex.has(s.id))
            const hasNewSectors =
              updates.length > 0 && updates.some((s) => !existingIndex.has(s.id))
            const hasPortOnlyWork =
              ignoreLocal &&
              sectorUpdates.some(
                (s) =>
                  (s as MapSectorNode).source === "player" &&
                  s.port !== undefined &&
                  existingIndex.has(s.id)
              )

            if (!hasExistingMatch && !hasNewSectors && !hasPortOnlyWork) return

            for (const sectorUpdate of updates) {
              const existingIdx = existingIndex.get(sectorUpdate.id)
              if (existingIdx !== undefined) {
                // When ignoreLocal is set (local_map_data), skip Object.assign
                // on player-visited sectors to prevent corp-sourced updates
                // from overwriting the player's own sector data. Unvisited or
                // corp-only sectors can still be updated (e.g. when a probe
                // visits a previously gray sector).
                const existingSource = (mapData[existingIdx] as MapSectorNode).source
                const isPlayerVisited =
                  existingSource === "player" || existingSource === "both"
                if (!ignoreLocal || !isPlayerVisited) {
                  Object.assign(mapData[existingIdx], sectorUpdate)
                  if (sectorUpdate.port !== undefined) {
                    const normalizedPort = normalizePort(
                      (sectorUpdate as MapSectorNode).port as PortLike
                    )
                    mapData[existingIdx].port = normalizedPort as MapSectorNode["port"]
                  }
                }
              } else {
                const newSector = {
                  ...sectorUpdate,
                  port: normalizePort((sectorUpdate as MapSectorNode).port as PortLike),
                } as MapSectorNode
                mapData.push(newSector)
              }
            }

            // For local_map_data: merge ONLY port data from player-sourced
            // updates that were filtered out above. This ensures port changes
            // (e.g. mega flag) reach local_map_data without overwriting
            // structural data like lanes.
            if (ignoreLocal) {
              for (const su of sectorUpdates) {
                if ((su as MapSectorNode).source !== "player") continue
                if (su.port === undefined) continue
                const idx = existingIndex.get(su.id)
                if (idx !== undefined) {
                  mapData[idx].port = normalizePort(
                    (su as MapSectorNode).port as PortLike
                  ) as MapSectorNode["port"]
                }
              }

              // Also merge garrison data into player-visited sectors that
              // were skipped above. Garrison placements/removals should
              // always be reflected on the mini map.
              for (const su of sectorUpdates) {
                if (su.garrison === undefined) continue
                const idx = existingIndex.get(su.id)
                if (idx !== undefined) {
                  mapData[idx].garrison = su.garrison
                }
              }
            }
          }

          processMapUpdates(state.local_map_data, true)
          processMapUpdates(state.regional_map_data)
        })
      ),

    setCoursePlot: (coursePlot: CoursePlot) =>
      set(
        produce((state) => {
          state.course_plot = coursePlot
        })
      ),

    clearCoursePlot: () =>
      set(
        produce((state) => {
          state.course_plot = undefined
        })
      ),

    // =================================================================
    // Map UI methods
    // =================================================================

    setMapCenterSector: (sectorId: number | undefined) =>
      set(
        produce((state) => {
          state.mapCenterSector = sectorId
          state.mapFitBoundsWorld = undefined
        })
      ),

    setMapCenterWorld: (center: [number, number] | undefined) =>
      set(
        produce((state) => {
          state.mapCenterWorld = center
        })
      ),

    setMapFitBoundsWorld: (bounds: [number, number, number, number] | undefined) =>
      set(
        produce((state) => {
          state.mapFitBoundsWorld = bounds
        })
      ),

    setMapZoomLevel: (zoomLevel: number) =>
      set(
        produce((state) => {
          state.mapZoomLevel = zoomLevel
        })
      ),

    setCoursePlotZoomEnabled: (enabled: boolean) =>
      set(
        produce((state) => {
          state.coursePlotZoomEnabled = enabled
        })
      ),

    setMapLegendVisible: (visible: boolean) =>
      set(
        produce((state) => {
          state.mapLegendVisible = visible
        })
      ),

    resetMapView: () =>
      set(
        produce((state) => {
          state.mapCenterSector = undefined
          state.mapCenterWorld = undefined
          state.mapFitBoundsWorld = undefined
          state.mapResetEpoch = (state.mapResetEpoch ?? 0) + 1
        })
      ),

    requestMapFetch: (centerSectorId: number, bounds: number): boolean => {
      const centerWorld = _resolveCenterWorld(centerSectorId)
      const rect = centerWorld ? buildCoverageRect(centerWorld, bounds) : undefined

      if (_isAlreadyCovered(rect)) return false

      const key = `${centerSectorId}:${bounds}`
      _registerInFlightRequest(key, rect)

      // Track so setRegionalMapData can confirm coverage when data arrives
      set(
        produce((draft) => {
          draft.pendingMapCenterRequestRef = {
            centerSector: centerSectorId,
            bounds,
            requestedAt: Date.now(),
          }
        })
      )

      const state = get()
      state.dispatchAction({
        type: "get-my-map",
        payload: {
          center_sector: centerSectorId,
          bounds,
        },
      })
      return true
    },

    clearPendingMapFit: () => {
      _resetMapFitRetryState()
      set(
        produce((state) => {
          state.pendingMapFitSectors = undefined
          state.pendingMapFitMissingCount = undefined
        })
      )
    },

    fitMapToSectors: (sectorIds: number[]) => {
      const cleaned = Array.from(
        new Set(sectorIds.filter((id) => typeof id === "number" && Number.isFinite(id)))
      )
      if (cleaned.length === 0) return

      const state = get()
      const combinedMap = deduplicateMapNodes(
        state.regional_map_data ?? [],
        state.local_map_data ?? []
      )
      const byId = new Map(combinedMap.map((n) => [n.id, n] as [number, MapSectorNode]))

      const nodes = cleaned
        .map((id) => byId.get(id))
        .filter((node): node is MapSectorNode => node !== undefined)
      const missing = cleaned.filter((id) => !byId.has(id))

      if (missing.length > 0) {
        const pending = state.pendingMapFitSectors
        const pendingMissing = state.pendingMapFitMissingCount
        const requestKey = _getMapFitRequestKey(cleaned)
        const samePending =
          Array.isArray(pending) &&
          pending.length === cleaned.length &&
          pending.every((id, idx) => id === cleaned[idx])
        if (!samePending || _mapFitTrackedRequestKey !== requestKey) {
          _mapFitTrackedRequestKey = requestKey
          _mapFitRetryCount = 0
          _mapFitStaleUpdateCount = 0
        }
        if (samePending && pendingMissing !== undefined && missing.length >= pendingMissing) {
          return
        }
        set(
          produce((draft) => {
            draft.pendingMapFitSectors = cleaned
            draft.pendingMapFitMissingCount = missing.length
          })
        )
        state.dispatchAction({
          type: "get-my-map",
          payload: {
            fit_sectors: cleaned,
          },
        })
        return
      }

      const currentSector =
        state.sector?.id !== undefined && state.sector.position ?
          { id: state.sector.id, position: state.sector.position }
        : undefined

      const fit = computeMapFit(nodes, combinedMap, currentSector)
      if (!fit) return

      set(
        produce((draft) => {
          draft.mapCenterSector = fit.centerNode.id
          draft.mapCenterWorld = fit.centerWorld
          draft.mapFitBoundsWorld = fit.fitBoundsWorld
          draft.mapZoomLevel = fit.zoomLevel
          draft.mapFitEpoch = (draft.mapFitEpoch ?? 0) + 1
          draft.pendingMapFitSectors = undefined
          draft.pendingMapFitMissingCount = undefined
        })
      )
      _resetMapFitRetryState()
    },

    requestMapAutoRecenter: (reason: string) => {
      autoRecenterRequested = true
      _maybeAutoRecenter(reason)
    },

    // =================================================================
    // Compound actions
    // =================================================================

    /**
     * Handle a `control_ui` server action.
     * Orchestrates screen switching, zoom, center, highlight, fit, and
     * course plot updates from the parsed payload fields.
     */
    handleMapUIAction: (payload: MapUIActionPayload) => {
      const state = get()
      const {
        mapCenterSector,
        mapZoomLevel: rawZoom,
        mapZoomDirection,
        highlightPath,
        fitSectors,
        clearCoursePlot: shouldClearPlot,
      } = payload

      const mapZoom =
        rawZoom !== undefined ? Math.max(MIN_BOUNDS, Math.min(MAX_BOUNDS, rawZoom)) : undefined

      const hasHighlight = Boolean(highlightPath && highlightPath.length > 0)
      const hasFit = Boolean(fitSectors && fitSectors.length > 0)
      const zoomOnly =
        mapZoom !== undefined && mapCenterSector === undefined && !hasHighlight && !hasFit

      // --- Zoom ---
      const fitEquivalentZoom = _estimateZoomFromFitBounds(state.mapFitBoundsWorld)

      if (mapZoom !== undefined) {
        const currentZoom = fitEquivalentZoom ?? state.mapZoomLevel ?? DEFAULT_MAX_BOUNDS

        if (zoomOnly && mapZoom !== currentZoom) {
          // Step-based zoom: move one level toward the requested zoom
          const direction = mapZoom < currentZoom ? "in" : "out"
          const nextZoom = getNextZoomLevel(currentZoom, direction)
          set(
            produce((draft) => {
              draft.mapFitBoundsWorld = undefined
              draft.mapZoomLevel = nextZoom
            })
          )
        } else if (!zoomOnly) {
          // Absolute zoom
          set(
            produce((draft) => {
              draft.mapFitBoundsWorld = undefined
              draft.mapZoomLevel = mapZoom
            })
          )
        }
      } else if (mapZoomDirection) {
        // Relative zoom via direction
        const currentZoom = fitEquivalentZoom ?? state.mapZoomLevel ?? DEFAULT_MAX_BOUNDS
        const nextZoom = getNextZoomLevel(currentZoom, mapZoomDirection)
        set(
          produce((draft) => {
            draft.mapFitBoundsWorld = undefined
            draft.mapZoomLevel = nextZoom
          })
        )
      }

      // --- Center ---
      // Just update state; SectorMap will detect the center change, compute
      // viewport-accurate fetch bounds, and call requestMapFetch.
      if (mapCenterSector !== undefined) {
        set(
          produce((draft) => {
            draft.mapCenterWorld = undefined
            draft.mapFitBoundsWorld = undefined
            draft.mapCenterSector = mapCenterSector
          })
        )
      }

      // --- Highlight path (course plot) ---
      if (highlightPath && highlightPath.length > 0) {
        set(
          produce((draft) => {
            draft.course_plot = {
              path: highlightPath,
              from_sector: highlightPath[0],
              to_sector: highlightPath[highlightPath.length - 1],
              distance: Math.max(0, highlightPath.length - 1),
            }
          })
        )
      }

      // --- Fit to sectors ---
      if (fitSectors && fitSectors.length > 0) {
        get().fitMapToSectors(fitSectors)
      }

      // --- Clear course plot ---
      if (shouldClearPlot) {
        set(
          produce((draft) => {
            draft.course_plot = undefined
          })
        )
      }
    },
  }
}

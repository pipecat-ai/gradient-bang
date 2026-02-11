import { produce } from "immer"
import { create, type StateCreator, type StoreApi, type UseBoundStore } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

import type { DiamondFXController } from "@/fx/frame"
import usePipecatClientStore from "@/stores/client"
import { hexToWorld } from "@/utils/hexMath"
import { DEFAULT_MAX_BOUNDS, MAX_BOUNDS, MIN_BOUNDS } from "@/utils/mapZoom"

import { type ChatSlice, createChatSlice } from "./chatSlice"
import { type CombatSlice, createCombatSlice } from "./combatSlice"
import { createHistorySlice, type HistorySlice } from "./historySlice"
import { createSettingsSlice, type SettingsSlice } from "./settingsSlice"
import { createTaskSlice, type TaskSlice } from "./taskSlice"
import { createUISlice, type UISlice } from "./uiSlice"

import type { ActionType, GameAction } from "@/types/actions"

type WithSelectors<S> =
  S extends { getState: () => infer T } ? S & { use: { [K in keyof T]: () => T[K] } } : never

const createSelectors = <S extends UseBoundStore<StoreApi<object>>>(_store: S) => {
  const store = _store as WithSelectors<typeof _store>
  store.use = {}
  for (const k of Object.keys(store.getState())) {
    ;(store.use as Record<string, () => unknown>)[k] = () => store((s) => s[k as keyof typeof s])
  }

  return store
}

type PortLike =
  | PortBase
  | Port
  | {
      port_code?: unknown
      mega?: unknown
      [key: string]: unknown
    }
  | string
  | null
  | undefined

const normalizePort = (port: PortLike): PortBase | null => {
  if (!port) return null

  if (typeof port === "string") {
    const code = port.trim()
    if (!code) return null
    return { code }
  }

  if (typeof port === "object") {
    const portObj = port as {
      code?: unknown
      port_code?: unknown
      mega?: unknown
      [key: string]: unknown
    }
    const code =
      typeof portObj.code === "string"
        ? portObj.code
        : typeof portObj.port_code === "string"
          ? portObj.port_code
          : null
    if (!code || !code.trim()) return null
    if (typeof portObj.code === "string") {
      return portObj as PortBase
    }
    return { ...portObj, code } as PortBase
  }

  return null
}

const normalizeMapData = (mapData: MapData): MapData =>
  mapData.map((sector) => normalizeSector(sector))

const normalizeSector = (sector: Sector): Sector => ({
  ...sector,
  port: normalizePort(sector.port as PortLike),
})

type GameInitState = "not_ready" | "initializing" | "ready" | "error"
type AlertTypes = "transfer"

export const GameInitStateMessage = {
  INIT: "Initializing game instances...",
  CONNECTING: "Connecting to server...",
  STARTING: "Rendering scene...",
  READY: "Game ready!",
} as const

type FetchPromiseEntry = {
  promise: Promise<void>
  resolve: () => void
  reject: (error?: unknown) => void
}

interface ActiveProperty<T> {
  data: T | undefined
  last_updated: string | null
}

export interface GameState {
  playerSessionId: string | null
  setPlayerSessionId: (playerSessionId: string | null) => void

  characters: CharacterSelectResponse[]
  player: PlayerSelf
  corporation?: Corporation
  character_id?: string
  access_token?: string
  ship: ShipSelf
  ships: ActiveProperty<ShipSelf[]>
  sector?: Sector
  local_map_data?: MapData
  regional_map_data?: MapData
  course_plot?: CoursePlot
  pendingMapFitSectors?: number[]
  pendingMapFitMissingCount?: number
  messages: ChatMessage[] | null
  messageFilters: "all" | "direct" | "broadcast" | "corporation"
  setMessageFilters: (filters: "all" | "direct" | "broadcast" | "corporation") => void

  /* Singleton Instances */
  starfieldReady: boolean
  diamondFXInstance?: DiamondFXController

  /* Buffers & Caches & Miscs */
  sectorBuffer?: Sector
  alertTransfer: number

  /* Game State */
  gameState: GameInitState
  gameStateMessage?: string
  fetchPromises: Partial<Record<ActionType, FetchPromiseEntry>>
  dispatchAction: (action: GameAction) => Promise<void> | undefined

  leaderboard_data?: LeaderboardResponse
  leaderboard_last_updated: string | null
  setLeaderboardData: (leaderboardData: LeaderboardResponse) => void
}

export interface GameSlice extends GameState {
  setCharacters: (characters: CharacterSelectResponse[]) => void
  setState: (newState: Partial<GameState>) => void
  setCharacterId: (characterId: string) => void
  setAccessToken: (accessToken: string) => void
  setCharacterAndToken: (characterId: string, accessToken: string) => void
  addMessage: (message: ChatMessage) => void
  setChatHistory: (messages: ChatMessage[]) => void
  setPlayer: (player: Partial<PlayerSelf>) => void
  setShip: (ship: Partial<ShipSelf>) => void
  setShips: (ships: ShipSelf[]) => void
  addShip: (ship: Partial<ShipSelf>) => void
  updateShip: (ship: Partial<ShipSelf> & { ship_id: string }) => void
  getShipSectors: (includeSelf: boolean) => number[]
  setSector: (sector: Sector) => void
  setCorporation: (corporation: Corporation | undefined) => void
  updateSector: (sector: Partial<Sector>) => void
  addSectorPlayer: (player: Player) => void
  removeSectorPlayer: (player: Player) => void
  setSectorBuffer: (sector: Sector) => void
  setLocalMapData: (localMapData: MapData) => void
  setRegionalMapData: (regionalMapData: MapData) => void
  updateMapSectors: (sectorUpdates: (Partial<MapSectorNode> & { id: number })[]) => void
  clearPendingMapFit: () => void
  setCoursePlot: (coursePlot: CoursePlot) => void
  clearCoursePlot: () => void
  fitMapToSectors: (sectorIds: number[]) => void
  requestMapAutoRecenter: (reason: string) => void
  setStarfieldReady: (starfieldReady: boolean) => void
  setDiamondFXInstance: (diamondFXInstance: DiamondFXController | undefined) => void
  setMessageFilters: (filters: "all" | "direct" | "broadcast" | "corporation") => void

  triggerAlert: (_ype: AlertTypes) => void
  setGameState: (gameState: GameInitState) => void
  setGameStateMessage: (gameStateMessage: string) => void
  createFetchPromise: (actionType: ActionType) => Promise<void>
  resolveFetchPromise: (actionType: ActionType) => void
  rejectFetchPromise: (actionType: ActionType, error?: unknown) => void
}

const createGameSlice: StateCreator<
  GameSlice & ChatSlice & CombatSlice & HistorySlice & TaskSlice & UISlice & SettingsSlice,
  [],
  [],
  GameSlice
> = (set, get) => {
  /** Retry a pending fitMapToSectors only when new data reduces the missing count. */
  const MAX_MAP_FIT_RETRIES = 5
  let _mapFitRetryCount = 0
  const _maybeRetryMapFit = () => {
    const state = get()
    const pending = state.pendingMapFitSectors
    const prevMissing = state.pendingMapFitMissingCount
    if (!pending || pending.length === 0 || prevMissing == null) return

    if (_mapFitRetryCount >= MAX_MAP_FIT_RETRIES) {
      console.debug("[GAME MAP] fitMapToSectors retry limit reached, giving up")
      get().clearPendingMapFit()
      _mapFitRetryCount = 0
      return
    }

    const combinedMap = [
      ...(state.regional_map_data ?? []),
      ...(state.local_map_data ?? []),
    ]
    const knownIds = new Set(combinedMap.map((n) => n.id))
    const stillMissing = pending.filter((id) => !knownIds.has(id)).length

    if (stillMissing >= prevMissing) return // no progress — don't retry

    _mapFitRetryCount++
    get().fitMapToSectors(pending)
  }

  let autoRecenterRequested = false
  const _maybeAutoRecenter = (reason: string) => {
    if (!autoRecenterRequested) return

    const state = get()
    if (state.mapFitBoundsWorld) {
      autoRecenterRequested = false
      return
    }
    if (state.pendingMapFitSectors && state.pendingMapFitSectors.length > 0) {
      return
    }

    const combinedMap = [
      ...(state.regional_map_data ?? []),
      ...(state.local_map_data ?? []),
    ]
    if (combinedMap.length === 0) return

    const byId = new Map<number, MapSectorNode>()
    combinedMap.forEach((node) => {
      if (!byId.has(node.id)) {
        byId.set(node.id, node)
      }
    })
    const nodes = Array.from(byId.values()).filter((node) => node.position)
    if (nodes.length === 0) return

    const SQRT3 = Math.sqrt(3)

    let centerWorld = state.mapCenterWorld
    if (!centerWorld) {
      const centerId = state.mapCenterSector ?? state.sector?.id
      const centerNode =
        centerId !== undefined ? nodes.find((node) => node.id === centerId) : undefined
      if (centerNode?.position) {
        const world = hexToWorld(centerNode.position[0], centerNode.position[1])
        centerWorld = [world.x, world.y]
      } else {
        const fallback = nodes.find((node) => node.position)
        if (fallback?.position) {
          const world = hexToWorld(fallback.position[0], fallback.position[1])
          centerWorld = [world.x, world.y]
        }
      }
    }
    if (!centerWorld) return

    const zoomLevel = state.mapZoomLevel ?? DEFAULT_MAX_BOUNDS
    const maxWorldDistance = zoomLevel * SQRT3
    const visibleNodes = nodes.filter((node) => {
      const world = hexToWorld(node.position[0], node.position[1])
      const dx = world.x - centerWorld![0]
      const dy = world.y - centerWorld![1]
      return Math.sqrt(dx * dx + dy * dy) <= maxWorldDistance
    })
    if (visibleNodes.length === 0) return

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const node of visibleNodes) {
      const world = hexToWorld(node.position[0], node.position[1])
      minX = Math.min(minX, world.x)
      maxX = Math.max(maxX, world.x)
      minY = Math.min(minY, world.y)
      maxY = Math.max(maxY, world.y)
    }

    const nextCenterWorld: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2]
    const prevCenterWorld = state.mapCenterWorld ?? centerWorld
    const dx = nextCenterWorld[0] - prevCenterWorld[0]
    const dy = nextCenterWorld[1] - prevCenterWorld[1]
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
      autoRecenterRequested = false
      return
    }

    console.debug("[GAME MAP] Auto-recenter", {
      reason,
      zoom: zoomLevel,
      visibleCount: visibleNodes.length,
      from: prevCenterWorld,
      to: nextCenterWorld,
    })
    set(
      produce((draft) => {
        draft.mapCenterWorld = nextCenterWorld
        draft.mapFitBoundsWorld = undefined
      })
    )
    autoRecenterRequested = false
  }

  return {
  playerSessionId: null,
  setPlayerSessionId: (playerSessionId: string | null) => set({ playerSessionId }),

  characters: [],
  player: {} as PlayerSelf,
  corporation: undefined,
  character_id: undefined,
  access_token: undefined,
  ship: {} as ShipSelf,
  ships: { data: undefined, last_updated: null },
  sector: undefined,
  local_map_data: undefined, // @TODO: move to map slice
  regional_map_data: undefined, // @TODO: move to map slice
  course_plot: undefined, // @TODO: move to map slice
  pendingMapFitSectors: undefined,
  pendingMapFitMissingCount: undefined,
  messages: null, // @TODO: move to chat slice
  messageFilters: "all",
  leaderboard_data: undefined,
  leaderboard_last_updated: null,

  starfieldReady: false,
  diamondFXInstance: undefined,

  alertTransfer: 0,
  gameState: "not_ready",
  gameStateMessage: GameInitStateMessage.INIT,
  fetchPromises: {},

  dispatchAction: (action: GameAction) => {
    const client = usePipecatClientStore.getState().client

    if (!client) {
      console.error("[GAME CLIENT] Client not available")
      return
    }
    if (client.state !== "ready") {
      console.error(`[GAME CLIENT] Client not ready. Current state: ${client.state}`)
      return
    }
    const payload = "payload" in action ? action.payload : {}

    let pendingPromise: Promise<void> | undefined
    if (action.async) {
      pendingPromise = get().createFetchPromise(action.type)
    }

    client.sendClientMessage(action.type, payload)
    return pendingPromise
  },

  setCharacters: (characters: CharacterSelectResponse[]) =>
    set(
      produce((state) => {
        state.characters = characters
      })
    ),
  setCharacterId: (characterId: string) => set({ character_id: characterId }),
  setAccessToken: (accessToken: string) => set({ access_token: accessToken }),
  setCharacterAndToken: (characterId: string, accessToken: string) =>
    set({ character_id: characterId, access_token: accessToken }),

  setGameStateMessage: (gameStateMessage: string) => set({ gameStateMessage }),
  setState: (newState: Partial<GameState>) => set({ ...get(), ...newState }, true),

  createFetchPromise: (actionType: ActionType) => {
    const existing = get().fetchPromises[actionType]
    if (existing) {
      return existing.promise
    }

    let resolve!: () => void
    let reject!: (error?: unknown) => void
    const promise = new Promise<void>((resolveFn, rejectFn) => {
      resolve = resolveFn
      reject = rejectFn
    })

    set(
      produce((state) => {
        state.fetchPromises[actionType] = { promise, resolve, reject }
      })
    )

    return promise
  },

  resolveFetchPromise: (actionType: ActionType) => {
    const entry = get().fetchPromises[actionType]
    if (!entry) return
    entry.resolve()
    set(
      produce((state) => {
        delete state.fetchPromises[actionType]
      })
    )
  },

  rejectFetchPromise: (actionType: ActionType, error?: unknown) => {
    const entry = get().fetchPromises[actionType]
    if (!entry) return
    entry.reject(error)
    set(
      produce((state) => {
        delete state.fetchPromises[actionType]
      })
    )
  },

  setPlayer: (player: Partial<PlayerSelf>) =>
    set(
      produce((state) => {
        state.player = { ...state.player, ...player }
      })
    ),

  setShips: (ships: ShipSelf[]) =>
    set(
      produce((state) => {
        state.ships = {
          data: ships,
          last_updated: new Date().toISOString(),
        }
      })
    ),

  addShip: (ship: Partial<ShipSelf>) =>
    set(
      produce((state) => {
        const existingShips = state.ships.data ?? []
        state.ships = {
          data: [...existingShips, ship as ShipSelf],
          last_updated: new Date().toISOString(),
        }
      })
    ),

  updateShip: (ship: Partial<ShipSelf> & { ship_id: string }) =>
    set(
      produce((state) => {
        if (state.ships.data) {
          const index = state.ships.data.findIndex((s: ShipSelf) => s.ship_id === ship.ship_id)
          if (index !== -1) {
            Object.assign(state.ships.data[index], ship)
            state.ships.last_updated = new Date().toISOString()
          }
        }
      })
    ),

  getShipSectors: (includeSelf: boolean) => {
    const shipsData = get().ships.data ?? []
    return includeSelf ?
        shipsData.map((s: ShipSelf) => s.sector ?? 0)
      : shipsData
          .filter((s: ShipSelf) => s.owner_type !== "personal")
          .map((s: ShipSelf) => s.sector ?? 0)
  },
  // TODO: implement this properly
  // @ts-expect-error - we don't care about the type here, just want to trigger the alert
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  triggerAlert: (type: AlertTypes) => set({ alertTransfer: Math.random() * 100 }),

  addMessage: (message: ChatMessage) =>
    set(
      produce((state) => {
        if (!state.messages) {
          state.messages = []
        }
        state.messages.push({
          ...message,
        })
      })
    ),

  setChatHistory: (messages: ChatMessage[]) =>
    set(
      produce((state) => {
        const existing = state.messages ?? []
        const existingIds = new Set(existing.map((m: ChatMessage) => m.id))
        const newMessages = messages.filter((m) => !existingIds.has(m.id))
        // History arrives newest-first; reverse so oldest are at the front
        state.messages = [...newMessages.reverse(), ...existing]
      })
    ),

  setSector: (sector: Sector) =>
    set(
      produce((state) => {
        state.sector = normalizeSector(sector)
      })
    ),

  updateSector: (sectorUpdate: Partial<Sector>) =>
    set(
      produce((state) => {
        if (state.sector?.id !== undefined && sectorUpdate.id === state.sector.id) {
          state.sector = { ...state.sector, ...sectorUpdate }
          state.sector.port = normalizePort(state.sector.port as PortLike)
        }
      })
    ),

  addSectorPlayer: (player: Player) =>
    set(
      produce((state) => {
        if (state.sector?.players) {
          const index = state.sector.players.findIndex((p: Player) => p.id === player.id)
          if (index !== -1) {
            state.sector.players[index] = player
          } else {
            state.sector.players.push(player)
          }
        }
      })
    ),

  removeSectorPlayer: (player: Player) =>
    set(
      produce((state) => {
        if (state.sector?.players) {
          state.sector.players = state.sector.players.filter((p: Player) => p.id !== player.id)
        }
      })
    ),

  setSectorBuffer: (sector: Sector) =>
    set(
      produce((state) => {
        state.sectorBuffer = normalizeSector(sector)
      })
    ),

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

        // Cache by sector ID - replace existing sectors with newer data
        const existingById = new Map(
          state.regional_map_data.map((s: MapSectorNode) => [s.id, s] as [number, MapSectorNode])
        )

        for (const sector of normalizedMapData) {
          existingById.set(sector.id, sector)
        }

        state.regional_map_data = Array.from(existingById.values())
      })
    )
    _maybeRetryMapFit()
    _maybeAutoRecenter("map.region")
  },

  updateMapSectors: (sectorUpdates: (Partial<MapSectorNode> & { id: number })[]) =>
    set(
      produce((state) => {
        // Helper to process updates for a given map
        const processMapUpdates = (
          mapData: MapSectorNode[] | undefined,
          ignoreLocal: boolean = false
        ): void => {
          if (!mapData) return

          // Filter out player-sourced sectors if ignoreLocal is true
          // If this update was triggered by a player move, we'll wait for map.local to
          // prevent a double render
          const updates =
            ignoreLocal ?
              sectorUpdates.filter((s) => (s as MapSectorNode).source !== "player")
            : sectorUpdates

          if (updates.length === 0) return

          // Build index of existing sectors
          const existingIndex = new Map<number, number>()
          mapData.forEach((s: MapSectorNode, idx: number) => existingIndex.set(s.id, idx))

          // Check if any of the update sectors exist in this map
          const hasMatch = updates.some((s) => existingIndex.has(s.id))
          if (!hasMatch) return

          for (const sectorUpdate of updates) {
            const existingIdx = existingIndex.get(sectorUpdate.id)
            if (existingIdx !== undefined) {
              // Update existing sector
              Object.assign(mapData[existingIdx], sectorUpdate)
              if (sectorUpdate.port !== undefined) {
                const normalizedPort = normalizePort(
                  (sectorUpdate as MapSectorNode).port as PortLike
                )
                mapData[existingIdx].port = normalizedPort as MapSectorNode["port"]
              }
            } else {
              // Add new sector
              const newSector = {
                ...sectorUpdate,
                port: normalizePort((sectorUpdate as MapSectorNode).port as PortLike),
              } as MapSectorNode
              mapData.push(newSector)
            }
          }
        }

        processMapUpdates(state.local_map_data, true)
        processMapUpdates(state.regional_map_data)
      })
    ),

  clearPendingMapFit: () =>
    set(
      produce((state) => {
        state.pendingMapFitSectors = undefined
        state.pendingMapFitMissingCount = undefined
      })
    ),

  setShip: (ship: Partial<Ship>) =>
    set(
      produce((state) => {
        if (state.ship) {
          Object.assign(state.ship, ship)
        } else {
          state.ship = ship as Ship
        }
      })
    ),

  setCorporation: (corporation: Corporation | undefined) =>
    set(
      produce((state) => {
        state.corporation = corporation
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
  fitMapToSectors: (sectorIds: number[]) => {
    const cleaned = Array.from(
      new Set(sectorIds.filter((id) => typeof id === "number" && Number.isFinite(id)))
    )
    if (cleaned.length === 0) return
    console.debug("[GAME MAP] fitMapToSectors", { count: cleaned.length })

    const state = get()
    const combinedMap = [
      ...(state.regional_map_data ?? []),
      ...(state.local_map_data ?? []),
    ]
    const byId = new Map<number, MapSectorNode>()
    combinedMap.forEach((node) => {
      if (!byId.has(node.id)) {
        byId.set(node.id, node)
      }
    })

    const nodes = cleaned
      .map((id) => byId.get(id))
      .filter((node): node is MapSectorNode => node !== undefined)
    const missing = cleaned.filter((id) => !byId.has(id))

    if (missing.length > 0) {
      const pending = state.pendingMapFitSectors
      const pendingMissing = state.pendingMapFitMissingCount
      const samePending =
        Array.isArray(pending) &&
        pending.length === cleaned.length &&
        pending.every((id, idx) => id === cleaned[idx])
      if (samePending && pendingMissing !== undefined && missing.length >= pendingMissing) {
        console.debug("[GAME MAP] fitMapToSectors skipping re-request", {
          missingCount: missing.length,
          totalRequested: cleaned.length,
        })
        return
      }
      console.debug("[GAME MAP] fitMapToSectors missing", {
        missingCount: missing.length,
        totalRequested: cleaned.length,
      })
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

    const positions = nodes
      .map((node) => node.position)
      .filter((pos): pos is [number, number] => Array.isArray(pos) && pos.length === 2)
    const SQRT3 = Math.sqrt(3)
    const worldPositions = positions.map((pos) => hexToWorld(pos[0], pos[1]))

    let centerWorld: [number, number] | null = null
    let fitBoundsWorld: [number, number, number, number] | null = null
    if (worldPositions.length > 0) {
      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY

      for (const pos of worldPositions) {
        minX = Math.min(minX, pos.x)
        maxX = Math.max(maxX, pos.x)
        minY = Math.min(minY, pos.y)
        maxY = Math.max(maxY, pos.y)
      }

      centerWorld = [(minX + maxX) / 2, (minY + maxY) / 2]
      fitBoundsWorld = [minX, maxX, minY, maxY]
    }

    const discovered = combinedMap.filter(
      (node) => node.position && (node.visited || node.source)
    )
    const candidates =
      discovered.length > 0 ? discovered : combinedMap.filter((node) => node.position)

    let centerNode: MapSectorNode | undefined
    if (centerWorld && candidates.length > 0) {
      let best = candidates[0]
      let bestDist = Number.POSITIVE_INFINITY
      for (const node of candidates) {
        if (!node.position) continue
        const world = hexToWorld(node.position[0], node.position[1])
        const dx = world.x - centerWorld[0]
        const dy = world.y - centerWorld[1]
        const dist = dx * dx + dy * dy
        if (dist < bestDist) {
          bestDist = dist
          best = node
        }
      }
      centerNode = best
    }

    if (!centerNode) {
      const withPosition = nodes.find((node) => node.position)
      if (withPosition) {
        centerNode = withPosition
      } else if (nodes[0]) {
        centerNode = nodes[0]
      } else if (state.sector?.id && state.sector.position) {
        const fallback = byId.get(state.sector.id)
        if (fallback) {
          centerNode = fallback
        } else {
          centerNode = {
            id: state.sector.id,
            position: state.sector.position,
            lanes: [],
          } as MapSectorNode
        }
      }
    }

    if (!centerNode) return

    let targetZoom = DEFAULT_MAX_BOUNDS
    if (centerWorld && worldPositions.length > 0 && fitBoundsWorld) {
      const halfWidth = Math.max(0, (fitBoundsWorld[1] - fitBoundsWorld[0]) / 2)
      const halfHeight = Math.max(0, (fitBoundsWorld[3] - fitBoundsWorld[2]) / 2)
      const maxWorldDist = Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight)
      const maxHexDist = maxWorldDist / SQRT3
      targetZoom = Math.max(MIN_BOUNDS, Math.ceil(maxHexDist) + 1)
    } else if (centerNode.position && positions.length > 0) {
      const centerPos = hexToWorld(centerNode.position[0], centerNode.position[1])
      let maxHexDist = 0
      for (const pos of positions) {
        const world = hexToWorld(pos[0], pos[1])
        const dx = world.x - centerPos.x
        const dy = world.y - centerPos.y
        const hexDist = Math.sqrt(dx * dx + dy * dy) / SQRT3
        if (hexDist > maxHexDist) {
          maxHexDist = hexDist
        }
      }
      targetZoom = Math.max(MIN_BOUNDS, Math.ceil(maxHexDist) + 1)
    }

    const clampedZoom = Math.max(MIN_BOUNDS, Math.min(MAX_BOUNDS, targetZoom))
    console.debug("[GAME MAP] fitMapToSectors resolved", {
      centerSector: centerNode?.id,
      centerSectorPos: centerNode?.position,
      centerWorld,
      fitBoundsWorld,
      zoom: clampedZoom,
      targetZoom,
      maxHexDist: centerWorld && worldPositions.length > 0
        ? Math.max(...worldPositions.map((w) => Math.sqrt((w.x - centerWorld![0]) ** 2 + (w.y - centerWorld![1]) ** 2) / SQRT3))
        : undefined,
      sectorCount: cleaned.length,
      sectorIds: cleaned,
      sectorPositions: nodes.map((n) => [n.id, n.position]),
    })

    set(
      produce((draft) => {
        draft.mapCenterSector = centerNode?.id
        draft.mapCenterWorld = centerWorld ?? undefined
        draft.mapFitBoundsWorld = fitBoundsWorld ?? undefined
        draft.mapZoomLevel = clampedZoom
        draft.mapFitEpoch = (draft.mapFitEpoch ?? 0) + 1
        if (missing.length > 0) {
          draft.pendingMapFitSectors = cleaned
          draft.pendingMapFitMissingCount = missing.length
        } else {
          draft.pendingMapFitSectors = undefined
          draft.pendingMapFitMissingCount = undefined
        }
      })
    )
    if (missing.length === 0) {
      _mapFitRetryCount = 0
    }
  },

  requestMapAutoRecenter: (reason: string) => {
    autoRecenterRequested = true
    _maybeAutoRecenter(reason)
  },

  setStarfieldReady: (starfieldReady: boolean) => set({ starfieldReady }),

  setDiamondFXInstance: (diamondFXInstance: DiamondFXController | undefined) =>
    set({ diamondFXInstance }),

  getIncomingMessageLength: () =>
    get().messages?.filter(
      (message) => message.type === "direct" && message.from_name !== get().player.name
    )?.length ?? 0,

  setMessageFilters: (filters: "all" | "direct" | "broadcast" | "corporation") =>
    set({ messageFilters: filters }),

  setLeaderboardData: (leaderboardData: LeaderboardResponse) =>
    set(
      produce((state) => {
        state.leaderboard_data = leaderboardData
        state.leaderboard_last_updated = new Date().toISOString()
      })
    ),

  setGameState: (gameState: GameInitState) => set({ gameState }),
}}

// Selectors
export const selectIncomingMessageCount = (state: GameSlice) =>
  state.messages?.filter(
    (message) => message.type === "direct" && message.from_name !== state.player?.name
  )?.length ?? 0

const useGameStoreBase = create<
  GameSlice & ChatSlice & CombatSlice & HistorySlice & TaskSlice & SettingsSlice & UISlice
>()(
  subscribeWithSelector((...a) => ({
    ...createGameSlice(...a),
    ...createChatSlice(...a),
    ...createCombatSlice(...a),
    ...createHistorySlice(...a),
    ...createTaskSlice(...a),
    ...createSettingsSlice(...a),
    ...createUISlice(...a),
  }))
)

const useGameStore = createSelectors(useGameStoreBase)

export type GameStore = ReturnType<typeof useGameStoreBase>
export default useGameStore

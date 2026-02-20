import { produce } from "immer"
import { create, type StateCreator, type StoreApi, type UseBoundStore } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

import type { DiamondFXController } from "@/fx/frame"
import usePipecatClientStore from "@/stores/client"
import { normalizePort, normalizeSector } from "@/utils/map"

import { type ChatSlice, createChatSlice } from "./chatSlice"
import { type CombatSlice, createCombatSlice } from "./combatSlice"
import { createHistorySlice, type HistorySlice } from "./historySlice"
import { createMapSlice, type MapSlice } from "./mapSlice"
import { createQuestSlice, type QuestSlice } from "./questSlice"
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

  playerCategoryRank: Record<LeaderboardCategory, PlayerLeaderboardCategoryRank> | null
  playerCategoryRankPrev: Record<LeaderboardCategory, PlayerLeaderboardCategoryRank> | null
  playerRankLastUpdated: string | null
  setPlayerCategoryRank: (
    category: LeaderboardCategory,
    rank: PlayerLeaderboardCategoryRank
  ) => void
  setPlayerCategoryRankPrev: (
    prev: Record<LeaderboardCategory, PlayerLeaderboardCategoryRank> | null
  ) => void

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

const createGameSlice: StateCreator<GameStoreState, [], [], GameSlice> = (set, get) => ({
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
  messages: null, // @TODO: move to chat slice
  messageFilters: "all",

  leaderboard_data: undefined, // @TODO: remove snakecase
  leaderboard_last_updated: null, //@TODO: remove snakecase
  playerCategoryRank: null,
  playerCategoryRankPrev: null,
  playerRankLastUpdated: null,

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

  setStarfieldReady: (starfieldReady: boolean) => set({ starfieldReady }),

  setDiamondFXInstance: (diamondFXInstance: DiamondFXController | undefined) =>
    set({ diamondFXInstance }),

  getIncomingMessageLength: () =>
    get().messages?.filter(
      (message) => message.type === "direct" && message.from_name !== get().player.name
    )?.length ?? 0,

  setMessageFilters: (filters: "all" | "direct" | "broadcast" | "corporation") =>
    set({ messageFilters: filters }),

  setPlayerCategoryRank: (category: LeaderboardCategory, rank: PlayerLeaderboardCategoryRank) =>
    set(
      produce((state) => {
        if (!state.playerCategoryRank) {
          state.playerCategoryRank = {} as Record<
            LeaderboardCategory,
            PlayerLeaderboardCategoryRank
          >
        }
        state.playerCategoryRank[category] = rank
        state.playerRankLastUpdated = new Date().toISOString()
      })
    ),

  setPlayerCategoryRankPrev: (
    prev: Record<LeaderboardCategory, PlayerLeaderboardCategoryRank> | null
  ) => set({ playerCategoryRankPrev: prev }),

  setLeaderboardData: (leaderboardData: LeaderboardResponse) =>
    set(
      produce((state) => {
        state.leaderboard_data = leaderboardData
        state.leaderboard_last_updated = new Date().toISOString()
      })
    ),

  setGameState: (gameState: GameInitState) => set({ gameState }),
})

// Selectors
export const selectIncomingMessageCount = (state: GameSlice) =>
  state.messages?.filter(
    (message) => message.type === "direct" && message.from_name !== state.player?.name
  )?.length ?? 0

export type GameStoreState = GameSlice &
  ChatSlice &
  CombatSlice &
  HistorySlice &
  TaskSlice &
  QuestSlice &
  SettingsSlice &
  UISlice &
  MapSlice

const useGameStoreBase = create<GameStoreState>()(
  subscribeWithSelector((...a) => ({
    ...createGameSlice(...a),
    ...createChatSlice(...a),
    ...createCombatSlice(...a),
    ...createHistorySlice(...a),
    ...createTaskSlice(...a),
    ...createQuestSlice(...a),
    ...createSettingsSlice(...a),
    ...createUISlice(...a),
    ...createMapSlice(...a),
  }))
)

const useGameStore = createSelectors(useGameStoreBase)

export type GameStore = GameStoreState
export default useGameStore

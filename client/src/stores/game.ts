import { produce } from "immer";
import {
  create,
  type StateCreator,
  type StoreApi,
  type UseBoundStore,
} from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { DiamondFXController } from "@fx/frame";
import { GalaxyStarfield } from "@fx/starfield";
import { createHistorySlice, type HistorySlice } from "./historySlice";
import { createSettingsSlice, type SettingsSlice } from "./settingsSlice";
import { createTaskSlice, type TaskSlice } from "./taskSlice";
import { createUISlice, type UISlice } from "./uiSlice";

type WithSelectors<S> = S extends { getState: () => infer T }
  ? S & { use: { [K in keyof T]: () => T[K] } }
  : never;

const createSelectors = <S extends UseBoundStore<StoreApi<object>>>(
  _store: S
) => {
  const store = _store as WithSelectors<typeof _store>;
  store.use = {};
  for (const k of Object.keys(store.getState())) {
    (store.use as Record<string, () => unknown>)[k] = () =>
      store((s) => s[k as keyof typeof s]);
  }

  return store;
};

type GameInitState = "not_ready" | "initializing" | "ready" | "error";

export const GameInitStateMessage = {
  INIT: "Initializing game instances...",
  CONNECTING: "Connecting to server...",
  STARTING: "Rendering scene...",
  READY: "Game ready!",
} as const;

export interface GameState {
  player: PlayerSelf;
  ship: ShipSelf;
  sector?: Sector;
  local_map_data?: MapData;
  course_plot?: CoursePlot;
  messages: ChatMessage[];

  /* Singleton Instances */
  starfieldInstance?: GalaxyStarfield;
  diamondFXInstance?: DiamondFXController;

  /* Buffers & Caches */
  sectorBuffer?: Sector;

  /* Game State */
  gameState: GameInitState;
  gameStateMessage?: string;
}

export interface GameSlice extends GameState {
  setState: (newState: Partial<GameState>) => void;
  addMessage: (message: ChatMessage) => void;
  setPlayer: (player: Partial<PlayerSelf>) => void;
  setSector: (sector: Sector) => void;
  setSectorPort: (sectorId: number, port: Port) => void;
  addSectorPlayer: (player: Player) => void;
  removeSectorPlayer: (player: Player) => void;
  setSectorBuffer: (sector: Sector) => void;
  setShip: (ship: Partial<ShipSelf>) => void;
  getShipHoldsRemaining: () => number;
  setLocalMapData: (localMapData: MapData) => void;
  setCoursePlot: (coursePlot: CoursePlot) => void;
  clearCoursePlot: () => void;
  setStarfieldInstance: (
    starfieldInstance: GalaxyStarfield | undefined
  ) => void;
  setDiamondFXInstance: (
    diamondFXInstance: DiamondFXController | undefined
  ) => void;
  setGameState: (gameState: GameInitState) => void;
  setGameStateMessage: (gameStateMessage: string) => void;
}

const createGameSlice: StateCreator<
  GameSlice & HistorySlice & TaskSlice & UISlice & SettingsSlice,
  [],
  [],
  GameSlice
> = (set, get) => ({
  player: {} as PlayerSelf,
  ship: {} as ShipSelf,
  sector: undefined,
  local_map_data: undefined, // @TODO: move to map slice
  course_plot: undefined, // @TODO: move to map slice
  messages: [],

  starfieldInstance: undefined,
  diamondFXInstance: undefined,
  gameState: "not_ready",
  gameStateMessage: GameInitStateMessage.INIT,

  setGameStateMessage: (gameStateMessage: string) => set({ gameStateMessage }),
  setState: (newState: Partial<GameState>) =>
    set({ ...get(), ...newState }, true),

  setPlayer: (player: Partial<PlayerSelf>) =>
    set(
      produce((state) => {
        state.player = { ...state.player, ...player };
      })
    ),

  addMessage: (message: ChatMessage) =>
    set(
      produce((state) => {
        state.messages.push({
          ...message,
        });
      })
    ),

  setSector: (sector: Sector) =>
    set(
      produce((state) => {
        state.sector = sector;
      })
    ),

  setSectorPort: (sectorId: number, port: Port) =>
    set(
      produce((state) => {
        if (state.sector?.id === sectorId) {
          state.sector.port = port;
        }
      })
    ),

  addSectorPlayer: (player: Player) =>
    set(
      produce((state) => {
        if (state.sector?.players) {
          const index = state.sector.players.findIndex(
            (p: Player) => p.id === player.id
          );
          if (index !== -1) {
            state.sector.players[index] = player;
          } else {
            state.sector.players.push(player);
          }
        }
      })
    ),

  removeSectorPlayer: (player: Player) =>
    set(
      produce((state) => {
        if (state.sector?.players) {
          state.sector.players = state.sector.players.filter(
            (p: Player) => p.id !== player.id
          );
        }
      })
    ),

  setSectorBuffer: (sector: Sector) =>
    set(
      produce((state) => {
        state.sectorBuffer = sector;
      })
    ),

  setLocalMapData: (localMapData: MapData) =>
    set(
      produce((state) => {
        state.local_map_data = localMapData;
      })
    ),

  setShip: (ship: Partial<Ship>) =>
    set(
      produce((state) => {
        if (state.ship) {
          Object.assign(state.ship, ship);
        } else {
          state.ship = ship as Ship;
        }
      })
    ),

  getShipHoldsRemaining: () => {
    if (!get().ship.cargo_capacity) {
      return 0;
    }

    return (
      get().ship.cargo_capacity -
      Object.values(get().ship.cargo).reduce((acc, curr) => acc + curr, 0)
    );
  },

  setCoursePlot: (coursePlot: CoursePlot) =>
    set(
      produce((state) => {
        state.course_plot = coursePlot;
      })
    ),

  clearCoursePlot: () =>
    set(
      produce((state) => {
        state.course_plot = undefined;
      })
    ),

  setStarfieldInstance: (starfieldInstance: GalaxyStarfield | undefined) =>
    set({ starfieldInstance }),

  setDiamondFXInstance: (diamondFXInstance: DiamondFXController | undefined) =>
    set({ diamondFXInstance }),

  setGameState: (gameState: GameInitState) => set({ gameState }),
});

const useGameStoreBase = create<
  GameSlice & HistorySlice & TaskSlice & SettingsSlice & UISlice
>()(
  subscribeWithSelector((...a) => ({
    ...createGameSlice(...a),
    ...createHistorySlice(...a),
    ...createTaskSlice(...a),
    ...createSettingsSlice(...a),
    ...createUISlice(...a),
  }))
);

const useGameStore = createSelectors(useGameStoreBase);

export type GameStore = ReturnType<typeof useGameStoreBase>;
export default useGameStore;

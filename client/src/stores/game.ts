import { produce } from "immer";
import {
  create,
  type StateCreator,
  type StoreApi,
  type UseBoundStore,
} from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { DiamondFXController } from "@fx/frame";
import type { GalaxyStarfield } from "@fx/starfield";
import { createCombatSlice, type CombatSlice } from "./combatSlice";
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
type AlertTypes = "transfer";

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

  /* Buffers & Caches & Miscs */
  sectorBuffer?: Sector;
  alertTransfer: number;

  /* Game State */
  gameState: GameInitState;
  gameStateMessage?: string;
}

export interface GameSlice extends GameState {
  setState: (newState: Partial<GameState>) => void;
  addMessage: (message: ChatMessage) => void;
  setPlayer: (player: Partial<PlayerSelf>) => void;
  setSector: (sector: Sector) => void;
  updateSector: (sector: Partial<Sector>) => void;
  addSectorPlayer: (player: Player) => void;
  removeSectorPlayer: (player: Player) => void;
  setSectorBuffer: (sector: Sector) => void;
  setShip: (ship: Partial<ShipSelf>) => void;
  setLocalMapData: (localMapData: MapData) => void;
  setCoursePlot: (coursePlot: CoursePlot) => void;
  clearCoursePlot: () => void;
  setStarfieldInstance: (
    starfieldInstance: GalaxyStarfield | undefined
  ) => void;
  setDiamondFXInstance: (
    diamondFXInstance: DiamondFXController | undefined
  ) => void;
  getIncomingMessageLength: () => number;

  triggerAlert: (_ype: AlertTypes) => void;
  setGameState: (gameState: GameInitState) => void;
  setGameStateMessage: (gameStateMessage: string) => void;
}

const createGameSlice: StateCreator<
  GameSlice & CombatSlice & HistorySlice & TaskSlice & UISlice & SettingsSlice,
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

  alertTransfer: 0,
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

  // TODO: implement this properly
  // @ts-expect-error - we don't care about the type here, just want to trigger the alert
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  triggerAlert: (type: AlertTypes) =>
    set({ alertTransfer: Math.random() * 100 }),

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

  updateSector: (sectorUpdate: Partial<Sector>) =>
    set(
      produce((state) => {
        if (
          state.sector?.id !== undefined &&
          sectorUpdate.id === state.sector.id
        ) {
          state.sector = { ...state.sector, ...sectorUpdate };
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

  getIncomingMessageLength: () =>
    get().messages.filter(
      (message) =>
        message.type === "direct" && message.from_name !== get().player.name
    ).length,

  setGameState: (gameState: GameInitState) => set({ gameState }),
});

const useGameStoreBase = create<
  GameSlice & CombatSlice & HistorySlice & TaskSlice & SettingsSlice & UISlice
>()(
  subscribeWithSelector((...a) => ({
    ...createGameSlice(...a),
    ...createCombatSlice(...a),
    ...createHistorySlice(...a),
    ...createTaskSlice(...a),
    ...createSettingsSlice(...a),
    ...createUISlice(...a),
  }))
);

const useGameStore = createSelectors(useGameStoreBase);

export type GameStore = ReturnType<typeof useGameStoreBase>;
export default useGameStore;

import { produce } from "immer";
import {
  create,
  type StateCreator,
  type StoreApi,
  type UseBoundStore,
} from "zustand";

import { GalaxyStarfield } from "../fx/starfield";
import { createHistorySlice, type HistorySlice } from "./historySlice";
import { createMapSlice, type MapSlice } from "./mapSlice";
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

export interface GameState {
  player: PlayerSelf;
  ship: ShipSelf;
  sector?: Sector;
  local_map_data?: MapData;

  /* Singleton Instances */
  starfieldInstance?: GalaxyStarfield;

  /* Buffers & Caches */
  sectorBuffer?: Sector;
}

export interface GameSlice extends GameState {
  setState: (newState: Partial<GameState>) => void;
  setSector: (sector: Sector) => void;
  setSectorBuffer: (sector: Sector) => void;
  setShip: (ship: Partial<ShipSelf>) => void;
  setLocalMapData: (localMapData: MapData) => void;
  setStarfieldInstance: (
    starfieldInstance: GalaxyStarfield | undefined
  ) => void;
}

const createGameSlice: StateCreator<
  GameSlice & MapSlice & HistorySlice & TaskSlice & UISlice & SettingsSlice,
  [],
  [],
  GameSlice
> = (set, get) => ({
  player: {} as PlayerSelf,
  ship: {} as ShipSelf,
  sector: undefined,
  local_map_data: undefined, // TODO: Move to slice
  starfieldInstance: undefined,

  setState: (newState: Partial<GameState>) =>
    set({ ...get(), ...newState }, true),

  setSector: (sector: Sector) =>
    set(
      produce((state) => {
        state.sector = sector;
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

  setStarfieldInstance: (starfieldInstance: GalaxyStarfield | undefined) =>
    set({ starfieldInstance }),
});

const useGameStoreBase = create<
  GameSlice & MapSlice & HistorySlice & TaskSlice & SettingsSlice & UISlice
>()((...a) => ({
  ...createGameSlice(...a),
  ...createMapSlice(...a),
  ...createHistorySlice(...a),
  ...createTaskSlice(...a),
  ...createSettingsSlice(...a),
  ...createUISlice(...a),
}));

const useGameStore = createSelectors(useGameStoreBase);

export type GameStore = ReturnType<typeof useGameStoreBase>;
export default useGameStore;

import { produce } from "immer";
import {
  create,
  type StateCreator,
  type StoreApi,
  type UseBoundStore,
} from "zustand";

import { createHistorySlice, type HistorySlice } from "./historySlice";
import { createMapSlice, type MapSlice } from "./mapSlice";

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
  uiState: UIState;
  player: Player;
  ship: Ship | undefined;
  credits: number | undefined;
  sector: Sector | undefined;
}

interface GameSlice extends GameState {
  setState: (newState: Partial<GameState>) => void;
  setShip: (ship: Partial<Ship>) => void;
  setSector: (sector: Sector) => void;
  setPlayer: (player: Player) => void;
  setCredits: (credits: number) => void;
  setUIState: (state: UIState) => void;
}

const createGameSlice: StateCreator<
  GameSlice & MapSlice & HistorySlice,
  [],
  [],
  GameSlice
> = (set, get) => ({
  uiState: "idle",
  player: { name: "Unknown" },
  ship: undefined,
  sector: undefined,
  credits: undefined,

  setState: (newState: Partial<GameState>) =>
    set({ ...get(), ...newState }, true),

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
  setSector: (sector: Sector) => {
    const prevSector = get().sector?.id;
    // Update the current sector
    set(
      produce((state) => {
        state.sector = sector;
      })
    );
    // Update the sector map
    get().addMappedSector(sector);
    // Update movement history
    get().addMovementHistory(prevSector, sector);
  },
  setPlayer: (player: Player) =>
    set(
      produce((state) => {
        state.player = player;
      })
    ),
  setCredits: (credits: number) => set({ credits }),
  setUIState: (uiState: UIState) => set({ uiState }),
});

const useGameStoreBase = create<GameSlice & MapSlice & HistorySlice>()(
  (...a) => ({
    ...createGameSlice(...a),
    ...createMapSlice(...a),
    ...createHistorySlice(...a),
  })
);

const useGameStore = createSelectors(useGameStoreBase);

export type GameStore = ReturnType<typeof useGameStoreBase>;
export default useGameStore;

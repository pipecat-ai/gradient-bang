import { produce } from "immer";
import {
  create,
  type StateCreator,
  type StoreApi,
  type UseBoundStore,
} from "zustand";

import { GalaxyStarfield } from "../starfield/";
import { createActionsSlice, type ActionsSlice } from "./actionSlice";
import { createHistorySlice, type HistorySlice } from "./historySlice";
import { createMapSlice, type MapSlice } from "./mapSlice";
import { createTaskSlice, type TaskSlice } from "./taskSlice";

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

export interface GameObjectInstance {
  id: string;
  type: "port" | "ship" | "npc";
  data: Record<string, unknown>;
}

export interface GameState {
  uiState: UIState;
  player: Player;
  ship: Ship | undefined;
  credits: number | undefined;
  sector: Sector | undefined;

  /* GameObject & Singleton Instances */
  gameObjects: GameObjectInstance[];
  starfieldInstance: GalaxyStarfield | undefined;
}

export interface GameSlice extends GameState {
  setState: (newState: Partial<GameState>) => void;
  setShip: (ship: Partial<Ship>) => void;
  setSector: (sector: Sector, immediate?: boolean) => Promise<void>;
  setPlayer: (player: Player) => void;
  setCredits: (credits: number) => void;
  setUIState: (state: UIState) => void;
  setStarfieldInstance: (starfieldInstance: GalaxyStarfield) => void;
}

const createGameSlice: StateCreator<
  GameSlice & ActionsSlice & MapSlice & HistorySlice & TaskSlice,
  [],
  [],
  GameSlice
> = (set, get) => ({
  uiState: "idle",
  player: { name: "Unknown" },
  ship: undefined,
  sector: undefined,
  credits: undefined,
  gameObjects: [],
  starfieldInstance: undefined,

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
  setSector: async (sector: Sector, immediate = false) => {
    const prevSector = get().sector?.id;

    if (!immediate) {
      // Await movement action to sequence animation state
      await get().moveToSectorAction();
    }

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
  setStarfieldInstance: (starfieldInstance: GalaxyStarfield) =>
    set({ starfieldInstance }),
});

const useGameStoreBase = create<
  GameSlice & ActionsSlice & MapSlice & HistorySlice & TaskSlice
>()((...a) => ({
  ...createGameSlice(...a),
  ...createActionsSlice(...a),
  ...createMapSlice(...a),
  ...createHistorySlice(...a),
  ...createTaskSlice(...a),
}));

const useGameStore = createSelectors(useGameStoreBase);

export type GameStore = ReturnType<typeof useGameStoreBase>;
export default useGameStore;

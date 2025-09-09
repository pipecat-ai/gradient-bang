import { create } from "zustand";
import type { GalaxyStarfield } from "../starfield/Starfield";

interface StarfieldState {
  instance?: GalaxyStarfield;
  setInstance: (instance: GalaxyStarfield) => void;
  getInstance: () => GalaxyStarfield | undefined;
}

const useStarfieldStore = create<StarfieldState>((set, get) => ({
  instance: undefined,
  setInstance: (instance: GalaxyStarfield) => set({ instance }),
  getInstance: () => get().instance,
}));

export default useStarfieldStore;

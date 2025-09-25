// stores/actionsSlice.ts
import { type StateCreator } from "zustand";
import { type GameSlice } from "./game";

export interface ActionsSlice {
  moveToSectorAction: () => Promise<void>;
}

export const createActionsSlice: StateCreator<
  GameSlice & ActionsSlice,
  [],
  [],
  ActionsSlice
> = (set, get) => ({
  moveToSectorAction: async () => {
    const state = get();

    // Don't move if already moving
    if (state.uiState === "moving") {
      //@TODO: show sonner saying movement not allowed
      console.log("[ACTIONS] Already moving");
      return;
    }

    console.log("[ACTIONS] Beginning movement action");

    // 1. Start move animation
    set({ uiState: "moving" });

    // 2. Let animation play
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 3. End move animation
    set({ uiState: "idle" });
  },
});

// stores/actionsSlice.ts
import { type StateCreator } from "zustand";
import { type GameSlice } from "./game";

export interface ActionsSlice {
  moveToSectorAction: (
    newSector: Sector,
    bypassAnimation?: boolean
  ) => Promise<void>;
}

export const createActionsSlice: StateCreator<
  GameSlice & ActionsSlice,
  [],
  [],
  ActionsSlice
> = (set, get) => ({
  moveToSectorAction: async (
    newSector: Sector,
    bypassAnimation: boolean = false
  ) => {
    console.debug("[ACTION] Beginning movement action", newSector);

    // Early exit if starfield instance not found
    const starfield = get().starfieldInstance;
    if (!starfield) {
      console.error("[ACTION] Starfield instance not found");
      return;
    }

    // 1. Update ui state and starfield
    set({ uiState: "moving" });

    // 2. Await warp complete
    await starfield?.warpToSector(
      {
        id: newSector.id.toString(),
        config: {},
        gameObjects: newSector.port
          ? [
              {
                id: newSector.id.toString(),
                type: "port",
                name: newSector.port.code,
              },
            ]
          : [],
      },
      bypassAnimation
    );

    console.debug("[ACTION] Movement complete");

    // 3. Return to idle state
    set({ uiState: "idle" });

    // 4. Update the map store
    get().setSector(newSector);
  },
});

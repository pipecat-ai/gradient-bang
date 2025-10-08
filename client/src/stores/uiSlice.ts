import type { StateCreator } from "zustand";

import { produce } from "immer";

export interface UISlice {
  ui: {
    active_modal?: "trade" | "ship" | "self" | "player" | "map" | "combat";
    highlight_element_id?: string;
    state: "idle" | "moving" | "autopilot" | "plotting" | "trading";
  };
  setUIState: (
    newState: "idle" | "moving" | "autopilot" | "plotting" | "trading"
  ) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  ui: {
    active_modal: undefined,
    highlight_element_id: undefined,
    state: "idle",
  },
  setUIState: (
    newState: "idle" | "moving" | "autopilot" | "plotting" | "trading"
  ) => {
    set(
      produce((state) => {
        state.ui.state = newState;
      })
    );
  },
});

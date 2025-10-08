import type { StateCreator } from "zustand";

import { produce } from "immer";

export interface UISlice {
  ui: {
    active_modal?: "trade" | "ship" | "self" | "player" | "map" | "combat";
    highlight_element_id?: string;
    state: "idle" | "moving" | "plotting" | "trading";
    autopilot: boolean;
  };
  setUIState: (newState: "idle" | "moving" | "plotting" | "trading") => void;
  setAutopilot: (autopilot: boolean) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  ui: {
    active_modal: undefined,
    highlight_element_id: undefined,
    state: "idle",
    autopilot: false,
  },
  setUIState: (newState: "idle" | "moving" | "plotting" | "trading") => {
    set(
      produce((state) => {
        state.ui.state = newState;
      })
    );
  },
  setAutopilot: (autopilot: boolean) => {
    set(
      produce((state) => {
        state.ui.autopilot = autopilot;
      })
    );
  },
});

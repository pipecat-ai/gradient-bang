import type { StateCreator } from "zustand";

import { produce } from "immer";

export interface UISlice {
  ui: {
    active_modal?: "trade" | "ship" | "self" | "player" | "map" | "combat";
    highlight_element_id?: string;
    state: "idle" | "moving" | "plotting" | "trading";
    autopilot: boolean;
    modal: "settings" | undefined;
  };
  setUIState: (newState: "idle" | "moving" | "plotting" | "trading") => void;
  setAutopilot: (autopilot: boolean) => void;
  setModal: (modal: "settings" | undefined) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  ui: {
    active_modal: undefined,
    highlight_element_id: undefined,
    state: "idle",
    autopilot: false,
    modal: undefined,
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
  setModal: (modal: "settings" | undefined) => {
    set(
      produce((state) => {
        state.ui.modal = modal;
      })
    );
  },
});

import type { StateCreator } from "zustand";

import { produce } from "immer";

export interface UISlice {
  ui: {
    state: "idle" | "moving" | "plotting" | "trading";
    panel: "task_output" | "movement_history" | "trade_history" | "debug";
    highlight_element_id?: string;
    autopilot: boolean;
    modal: "settings" | undefined;
  };
  setUIState: (newState: "idle" | "moving" | "plotting" | "trading") => void;
  setPanel: (
    panel: "task_output" | "movement_history" | "trade_history" | "debug"
  ) => void;
  setAutopilot: (autopilot: boolean) => void;
  setModal: (modal: "settings" | undefined) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  ui: {
    panel: "task_output",
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
  setPanel: (
    panel: "task_output" | "movement_history" | "trade_history" | "debug"
  ) => {
    set(
      produce((state) => {
        state.ui.panel = panel;
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

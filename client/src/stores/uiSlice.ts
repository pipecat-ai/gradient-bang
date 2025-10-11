import type { StateCreator } from "zustand";

import { produce } from "immer";

export interface UISlice {
  uiState: UIState;
  activeScreen?: UIScreen;
  activeModal?: UIModal;
  activePanel?: string;

  //setUIState: (newState: UIState) => void;
  //setActiveScreen: (screen: UIScreen) => void;
  //setActiveModal: (modal: UIModal) => void;
  //setActivePanel: (panel: string) => void;

  // @TODO DO NOT NEST. Bad practice.
  /*
  ui: {
    state: "idle" | "moving" | "plotting" | "trading";
    panel: "task_output" | "movement_history" | "trade_history" | "debug";
    highlight_element_id?: string;
    autopilot: boolean;
    modal: "settings" | undefined;
    setModal: (modal: UIModal) => void;
  };*/
  setUIState: (newState: UIState) => void;
  setActiveScreen: (screen: UIScreen) => void;
  setActiveModal: (modal: UIModal) => void;
  setActivePanel: (panel: string) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  uiState: "idle",
  activeScreen: undefined,
  activeModal: undefined,
  activePanel: undefined,

  /*ui: {
    panel: "task_output",
    highlight_element_id: undefined,
    state: "idle",
    autopilot: false,
    modal: undefined,
    setModal: (modal: UIModal) => {
      set(
        produce((state) => {
          state.ui.modal = modal;
        })
      );
    },
  },*/
  setUIState: (newState: UIState) => {
    set(
      produce((state) => {
        state.uiState = newState;
      })
    );
  },
  setActiveScreen: (screen: UIScreen) => {
    set(
      produce((state) => {
        state.activeScreen = screen;
      })
    );
  },
  setActiveModal: (modal: UIModal) => {
    set(
      produce((state) => {
        state.activeModal = modal;
      })
    );
  },
  setActivePanel: (panel: string) => {
    set(
      produce((state) => {
        state.activePanel = panel;
      })
    );
  },
  setAutopilot: (autopilot: boolean) => {
    set(
      produce((state) => {
        state.uiState = autopilot;
      })
    );
  },
});

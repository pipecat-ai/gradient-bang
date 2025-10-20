import type { StateCreator } from "zustand";

import { produce } from "immer";

export interface UISlice {
  uiState: UIState;
  activeScreen?: UIScreen;
  activeModal?: UIModal;
  activePanel?: string;

  setUIState: (newState: UIState) => void;
  setActiveScreen: (screen?: UIScreen) => void;
  setActiveModal: (modal: UIModal) => void;
  setActivePanel: (panel: string) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  uiState: "idle",
  activeScreen: undefined,
  activeModal: undefined,
  activePanel: undefined,

  setUIState: (newState: UIState) => {
    set(
      produce((state) => {
        state.uiState = newState;
      })
    );
  },
  setActiveScreen: (screen?: UIScreen) => {
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

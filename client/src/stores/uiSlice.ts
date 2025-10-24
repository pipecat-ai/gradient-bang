import type { StateCreator } from "zustand";

import { produce } from "immer";

interface Notifications {
  newChatMessage: boolean;
}

export interface UISlice {
  uiState: UIState;
  activeScreen?: UIScreen;
  activeModal?: UIModal;
  activePanel?: string;

  notifications: Notifications;
  setNotifications: (notifications: Partial<Notifications>) => void;

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

  notifications: {
    newChatMessage: false,
  },

  setNotifications: (notifications: Partial<Notifications>) => {
    set(
      produce((state) => {
        state.notifications = {
          ...state.notifications,
          ...notifications,
        };
      })
    );
  },

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

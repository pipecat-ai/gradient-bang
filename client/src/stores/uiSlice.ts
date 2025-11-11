import type { StateCreator } from "zustand";

import type { Toast, ToastInput } from "@/types/toasts";
import { produce } from "immer";
import { nanoid } from "nanoid";

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

  toasts: Toast[];
  setToasts: (toasts: Toast[]) => void;
  addToast: (toast: ToastInput) => void;
  clearToasts: () => void;
  removeToast: (id: string) => void;

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

  toasts: [],
  setToasts: (toasts: Toast[]) => {
    set(
      produce((state) => {
        state.toasts = toasts;
      })
    );
  },
  addToast: (toast: ToastInput) => {
    set(
      produce((state) => {
        state.toasts.push({
          ...toast,
          id: nanoid(),
          timestamp: new Date().toISOString(),
        });
      })
    );
  },
  clearToasts: () => {
    set(
      produce((state) => {
        state.toasts = [];
      })
    );
  },
  removeToast: (id: string) => {
    set(
      produce((state) => {
        state.toasts = state.toasts.filter((toast: Toast) => toast?.id !== id);
      })
    );
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

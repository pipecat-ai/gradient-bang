import type { StateCreator } from "zustand";

import type { Toast, ToastInput } from "@/types/toasts";
import { produce } from "immer";
import { nanoid } from "nanoid";

interface Notifications {
  newChatMessage: boolean;
}

const DEDUPE_TOAST_TYPES = ["trade.executed"];

export interface UISlice {
  uiState: UIState;
  activeScreen?: UIScreen;
  activeModal?: UIModal;
  activePanel?: string;

  notifications: Notifications;
  setNotifications: (notifications: Partial<Notifications>) => void;

  toasts: Toast[];
  displayingToastId: string | null;
  setToasts: (toasts: Toast[]) => void;
  addToast: (toast: ToastInput) => void;
  clearToasts: () => void;
  removeToast: (id: string) => void;
  getNextToast: () => Toast | undefined;
  lockToast: (id: string) => void;

  setUIState: (newState: UIState) => void;
  setActiveScreen: (screen?: UIScreen) => void;
  setActiveModal: (modal: UIModal) => void;
  setActivePanel: (panel: string) => void;
}

export const createUISlice: StateCreator<UISlice> = (set, get) => ({
  uiState: "idle",
  activeScreen: undefined,
  activeModal: undefined,
  activePanel: undefined,

  notifications: {
    newChatMessage: false,
  },

  toasts: [],
  displayingToastId: null,
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
        // Check if this toast type should be deduplicated
        if (DEDUPE_TOAST_TYPES.includes(toast.type)) {
          // Find existing toast, but skip the locked one
          const existingIndex = state.toasts.findIndex(
            (t: Toast) =>
              t.type === toast.type && t.id !== state.displayingToastId
          );

          if (existingIndex !== -1) {
            // Update the unlocked matching toast
            state.toasts[existingIndex] = {
              ...state.toasts[existingIndex],
              meta: toast.meta,
              timestamp: new Date().toISOString(),
            };
            return;
          }
        }

        // No match found or type not in DEDUPE_TOAST_TYPES - add new toast
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
        // Clear lock if we're removing the locked toast
        if (state.displayingToastId === id) {
          state.displayingToastId = null;
        }
      })
    );
  },
  getNextToast: () => {
    const state = get();
    return state.toasts[0];
  },
  lockToast: (id: string) => {
    set(
      produce((draft) => {
        draft.displayingToastId = id;
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
});

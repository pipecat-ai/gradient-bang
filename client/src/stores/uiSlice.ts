import type { StateCreator } from "zustand";

export interface UIState {
  osdImage?: string;
}

export interface UISlice {
  visualElements: UIState;
}

export const createUISlice: StateCreator<UISlice> = (_set, get) => ({
  visualElements: {
    osdImage: undefined,
  },
  getVisualElements: () => get().visualElements,
});

import { create } from "zustand"

interface CallbackStore {
  onCreated: () => void
  onStart: () => void
  onStop: () => void
}

export const useCallbackStore = create<CallbackStore>((set) => ({
  onStart: () => {},
  onStop: () => {},
  onCreated: () => {},
  setOnCreated: (fn: () => void) => set({ onCreated: fn }),
  setOnStart: (fn: () => void) => set({ onStart: fn }),
  setOnStop: (fn: () => void) => set({ onStop: fn }),
}))

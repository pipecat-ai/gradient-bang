import { create } from "zustand"

import type { Scene, SceneChangeOptions } from "./types"

interface CallbackStore {
  onCreated: () => void
  onStart: () => void
  onStop: () => void
  onUnsupported: () => void
  enqueueScene: (scene: Scene, options?: SceneChangeOptions) => void
}

export const useCallbackStore = create<CallbackStore>((set) => ({
  onStart: () => {},
  onStop: () => {},
  onCreated: () => {},
  onUnsupported: () => {},
  enqueueScene: () => {},
  setOnCreated: (fn: () => void) => set({ onCreated: fn }),
  setOnStart: (fn: () => void) => set({ onStart: fn }),
  setOnStop: (fn: () => void) => set({ onStop: fn }),
}))

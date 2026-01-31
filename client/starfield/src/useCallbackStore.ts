import { create } from "zustand"

import type { PositionedGameObject, Scene, SceneChangeOptions } from "@/types"

interface CallbackStore {
  onCreated: () => void
  onReady: () => void
  onStart: () => void
  onStop: () => void
  onUnsupported: () => void
  enqueueScene: (scene: Scene, options?: SceneChangeOptions) => void
  onWarpAnimationStart: () => void
  onTargetRest: (target: PositionedGameObject) => void
  onTargetClear: () => void
}

export const useCallbackStore = create<CallbackStore>((set) => ({
  onStart: () => {},
  onStop: () => {},
  onCreated: () => {},
  onReady: () => {},
  onUnsupported: () => {},
  enqueueScene: () => {},
  setOnCreated: (fn: () => void) => set({ onCreated: fn }),
  setOnReady: (fn: () => void) => set({ onReady: fn }),
  setOnStart: (fn: () => void) => set({ onStart: fn }),
  setOnStop: (fn: () => void) => set({ onStop: fn }),
  setOnWarpAnimationStart: (fn: () => void) =>
    set({ onWarpAnimationStart: fn }),
  onWarpAnimationStart: () => {},
  onTargetRest: () => {},
  onTargetClear: () => {},
}))

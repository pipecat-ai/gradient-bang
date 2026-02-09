import { create } from "zustand"

import type { PositionedGameObject, Scene, SceneChangeOptions } from "@/types"

interface CallbackStore {
  onCreated: () => void
  onReady: () => void
  onUnsupported: () => void
  enqueueScene: (scene: Scene, options?: SceneChangeOptions) => void
  onSceneChangeStart: (isInitial?: boolean) => void
  onSceneChangeEnd: () => void
  onTargetRest: (target: PositionedGameObject) => void
  onTargetClear: () => void
}

export const useCallbackStore = create<CallbackStore>((set) => ({
  onCreated: () => {},
  onReady: () => {},
  onUnsupported: () => {},
  enqueueScene: () => {},
  onSceneChangeStart: () => {},
  onSceneChangeEnd: () => {},
  setOnCreated: (fn: () => void) => set({ onCreated: fn }),
  setOnReady: (fn: () => void) => set({ onReady: fn }),
  setOnSceneChangeStart: (fn: (isInitial?: boolean) => void) =>
    set({ onSceneChangeStart: fn }),
  onTargetRest: () => {},
  onTargetClear: () => {},
}))

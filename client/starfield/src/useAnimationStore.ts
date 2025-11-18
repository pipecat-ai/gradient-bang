import { create } from "zustand"

interface AnimationStore {
  isWarping: boolean
  startWarp: () => void
  stopWarp: () => void

  dimmed: boolean
  setDimmed: (dimmed: boolean) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  isWarping: false,
  startWarp: () => set({ isWarping: true }),
  stopWarp: () => set({ isWarping: false }),
  dimmed: false,
  setDimmed: (dimmed: boolean) => set({ dimmed }),
}))

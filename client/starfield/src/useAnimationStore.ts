import { create } from "zustand"

interface AnimationStore {
  isWarping: boolean
  warpIntensity: number
  startWarp: () => void
  stopWarp: () => void
  setWarpIntensity: (intensity: number) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  isWarping: false,
  warpIntensity: 1,
  startWarp: () => set({ isWarping: true }),
  stopWarp: () => set({ isWarping: false }),
  setWarpIntensity: (intensity) => set({ warpIntensity: intensity }),
}))

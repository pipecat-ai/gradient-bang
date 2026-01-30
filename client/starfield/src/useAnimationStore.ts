import { create } from "zustand"

interface AnimationStore {
  isWarping: boolean
  startWarp: () => void
  stopWarp: () => void

  isDimmed: boolean
  setIsDimmed: (isDimmed: boolean) => void

  exposure: number
  setExposure: (exposure: number) => void

  triggerShockwave: () => void
  setTriggerShockwave: (fn: () => void) => void

  isAnimating: boolean
  setIsAnimating: (isAnimating: boolean) => void

  isShaking: boolean
  setIsShaking: (isShaking: boolean) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  isWarping: false,
  startWarp: () => set({ isWarping: true }),
  stopWarp: () => set({ isWarping: false }),
  isDimmed: false,
  setIsDimmed: (isDimmed: boolean) => set({ isDimmed }),
  exposure: 1,
  setExposure: (exposure: number) => set({ exposure }),
  triggerShockwave: () => {},
  setTriggerShockwave: (fn: () => void) => set({ triggerShockwave: fn }),
  isAnimating: false,
  setIsAnimating: (isAnimating: boolean) => set({ isAnimating }),
  isShaking: false,
  setIsShaking: (isShaking: boolean) => set({ isShaking }),
}))

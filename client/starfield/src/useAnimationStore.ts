import { create } from "zustand"

type AnimationDirection = "enter" | "exit"

interface AnimationStore {
  isHyperspace: AnimationDirection | undefined
  setHyperspace: (direction: AnimationDirection | undefined) => void

  isShockwave: boolean
  setShockwave: (active: boolean) => void
  shockwaveSequence: number
  triggerShockwave: () => void
  shockwaveStartTime: number | null
  setShockwaveStartTime: (time: number | null) => void

  isWarping: boolean
  startWarp: () => void
  stopWarp: () => void

  isDimmed: boolean
  setIsDimmed: (isDimmed: boolean) => void

  exposure: number
  setExposure: (exposure: number) => void

  isAnimating: boolean
  setIsAnimating: (isAnimating: boolean) => void

  isShaking: boolean
  setIsShaking: (isShaking: boolean) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  isHyperspace: undefined,
  setHyperspace: (direction) => set({ isHyperspace: direction }),
  isShockwave: false,
  setShockwave: (active: boolean) => set({ isShockwave: active }),
  shockwaveSequence: 0,
  triggerShockwave: () =>
    set((state) => ({
      isShockwave: true,
      shockwaveSequence: state.shockwaveSequence + 1,
    })),
  shockwaveStartTime: null,
  setShockwaveStartTime: (time: number | null) => set({ shockwaveStartTime: time }),
  isWarping: false,
  startWarp: () => set({ isWarping: true }),
  stopWarp: () => set({ isWarping: false }),
  isDimmed: false,
  setIsDimmed: (isDimmed: boolean) => set({ isDimmed }),
  exposure: 1,
  setExposure: (exposure: number) => set({ exposure }),
  isAnimating: false,
  setIsAnimating: (isAnimating: boolean) => set({ isAnimating }),
  isShaking: false,
  setIsShaking: (isShaking: boolean) => set({ isShaking }),
}))

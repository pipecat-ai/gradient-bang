import { create } from "zustand"

type AnimationDirection = "enter" | "exit"

// Animation method types
export type DirectionalAnimationStart = (
  direction: AnimationDirection,
  onComplete?: () => void,
  overrides?: { initialExposure?: number }
) => void

export type ShakeAnimationStart = (config?: {
  mode?: "perlin" | "circular"
  strength?: number
  frequency?: number
  rampUpTime?: number
  settleTime?: number
  duration?: number
}) => void

// Registry of animation methods
interface AnimationMethods {
  sceneChange?: {
    start: (direction: AnimationDirection, onComplete?: () => void) => void
  }
  hyperspace?: {
    start: DirectionalAnimationStart
  }
  shake?: {
    start: ShakeAnimationStart
    stop: () => void
    kill: () => void
  }
  shockwave?: {
    start: () => void
  }
  dim?: {
    start: (direction: AnimationDirection, onComplete?: () => void) => void
  }
  exposure?: {
    start: (direction: AnimationDirection, onComplete?: () => void) => void
  }
}

interface AnimationStore {
  // Animation method registry
  animations: AnimationMethods
  registerAnimation: <K extends keyof AnimationMethods>(
    name: K,
    methods: AnimationMethods[K]
  ) => void

  isHyperspace: AnimationDirection | undefined
  setHyperspace: (direction: AnimationDirection | undefined) => void

  isShockwave: boolean
  setShockwave: (active: boolean) => void
  shockwaveSequence: number
  triggerShockwave: () => void
  shockwaveStartTime: number | null
  setShockwaveStartTime: (time: number | null) => void

  isDimmed: boolean
  setIsDimmed: (isDimmed: boolean) => void

  exposure: number
  setExposure: (exposure: number) => void

  /** Derived from _animatingCount — true when any spring is active */
  isAnimating: boolean
  /** Internal ref-count of active springs */
  _animatingCount: number
  incrementAnimating: () => void
  decrementAnimating: () => void

  isShaking: boolean
  setIsShaking: (isShaking: boolean) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  // Animation method registry
  animations: {},
  registerAnimation: (name, methods) =>
    set((state) => ({
      animations: { ...state.animations, [name]: methods },
    })),

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
  setShockwaveStartTime: (time: number | null) =>
    set({ shockwaveStartTime: time }),
  isDimmed: false,
  setIsDimmed: (isDimmed: boolean) => set({ isDimmed }),
  exposure: 0,
  setExposure: (exposure: number) => set({ exposure }),
  isAnimating: false,
  _animatingCount: 0,
  incrementAnimating: () =>
    set((state) => {
      const count = state._animatingCount + 1
      return { _animatingCount: count, isAnimating: count > 0 }
    }),
  decrementAnimating: () =>
    set((state) => {
      const count = Math.max(0, state._animatingCount - 1)
      return { _animatingCount: count, isAnimating: count > 0 }
    }),
  isShaking: false,
  setIsShaking: (isShaking: boolean) => set({ isShaking }),
}))

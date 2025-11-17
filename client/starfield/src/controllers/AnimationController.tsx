import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"
import { easings, useSpring, type SpringValue } from "@react-spring/three"
import { useThree } from "@react-three/fiber"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

type WarpSpringValues = {
  scale: SpringValue<number>
  rotationSpeed: SpringValue<number>
  warpProgress: SpringValue<number>
  glowIntensity: SpringValue<number>
  distortion: SpringValue<number>
}

type WarpAnimationContextValue = WarpSpringValues & {
  isWarping: boolean
  isAnimating: boolean
}

const WarpAnimationContext = createContext<WarpAnimationContextValue | null>(
  null
)

type ShockwaveContextValue = {
  shockwaveSequence: number
  triggerShockwave: () => void
}

const ShockwaveContext = createContext<ShockwaveContextValue | null>(null)

const SHOCKWAVE_BASE_DURATION_MS = 1500

export function AnimationController({ children }: PropsWithChildren) {
  const { isWarping } = useAnimationStore()
  const {
    hyperspaceEnterTime,
    hyperspaceExitTime,
    shockwaveSpeed = 1.25,
  } = useGameStore((state) => state.starfieldConfig)
  const [isAnimating, setIsAnimating] = useState(false)
  const { invalidate } = useThree()
  const rafRef = useRef<number | null>(null)
  const [shockwaveSequence, setShockwaveSequence] = useState(0)
  const shockwaveRafRef = useRef<number | null>(null)
  const shockwaveEndTimeRef = useRef<number>(0)

  const shockwaveActiveMs = useMemo(
    () => SHOCKWAVE_BASE_DURATION_MS / Math.max(shockwaveSpeed, 0.1),
    [shockwaveSpeed]
  )

  const runShockwaveLoop = useCallback(() => {
    const now = performance.now()
    shockwaveEndTimeRef.current = now + shockwaveActiveMs

    if (shockwaveRafRef.current) {
      return
    }

    const tick = () => {
      invalidate()

      if (performance.now() < shockwaveEndTimeRef.current) {
        shockwaveRafRef.current = requestAnimationFrame(tick)
      } else {
        shockwaveRafRef.current = null
      }
    }

    shockwaveRafRef.current = requestAnimationFrame(tick)
  }, [invalidate, shockwaveActiveMs])

  const triggerShockwave = useCallback(() => {
    setShockwaveSequence((value) => value + 1)
    runShockwaveLoop()
  }, [runShockwaveLoop])

  const warpSpring = useSpring<WarpSpringValues>({
    scale: isWarping ? 1.25 : 0.95,
    rotationSpeed: isWarping ? 2 : 0.3,
    warpProgress: isWarping ? 1 : 0,
    glowIntensity: isWarping ? 3 : 1,
    distortion: isWarping ? 0.5 : 0,
    config: () =>
      isWarping
        ? {
            duration: hyperspaceEnterTime,
            easing: easings.easeInQuad,
          }
        : {
            duration: hyperspaceExitTime,
            easing: easings.easeOutExpo,
          },
    onStart: () => setIsAnimating(true),
    onRest: () => setIsAnimating(false),
  })

  useEffect(() => {
    if (!isAnimating) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    const tick = () => {
      invalidate()
      rafRef.current = requestAnimationFrame(tick)
    }

    tick()

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isAnimating, invalidate])

  useEffect(() => {
    return () => {
      if (shockwaveRafRef.current) {
        cancelAnimationFrame(shockwaveRafRef.current)
        shockwaveRafRef.current = null
      }
    }
  }, [])

  const { scale, rotationSpeed, warpProgress, glowIntensity, distortion } =
    warpSpring

  const contextValue = useMemo<WarpAnimationContextValue>(
    () => ({
      scale,
      rotationSpeed,
      warpProgress,
      glowIntensity,
      distortion,
      isWarping,
      isAnimating: isWarping || isAnimating,
    }),
    [
      scale,
      rotationSpeed,
      warpProgress,
      glowIntensity,
      distortion,
      isWarping,
      isAnimating,
    ]
  )

  return (
    <ShockwaveContext.Provider value={{ triggerShockwave, shockwaveSequence }}>
      <WarpAnimationContext.Provider value={contextValue}>
        {children}
      </WarpAnimationContext.Provider>
    </ShockwaveContext.Provider>
  )
}

export function useWarpAnimation() {
  const context = useContext(WarpAnimationContext)
  if (!context) {
    throw new Error("useWarpAnimation must be used within AnimationController")
  }
  return context
}

export function useShockwave() {
  const context = useContext(ShockwaveContext)
  if (!context) {
    throw new Error("useShockwave must be used within AnimationController")
  }
  return context
}

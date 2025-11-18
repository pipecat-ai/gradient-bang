import {
  useCallback,
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

import {
  AnimationContext,
  type AnimationContextValue,
} from "./AnimationContext"

type WarpSpringValues = {
  scale: SpringValue<number>
  rotationSpeed: SpringValue<number>
  warpProgress: SpringValue<number>
  glowIntensity: SpringValue<number>
  distortion: SpringValue<number>
}

type DimSpringValues = {
  dimOpacity: SpringValue<number>
}

export function AnimationController({ children }: PropsWithChildren) {
  const { isWarping, dimmed } = useAnimationStore()
  const {
    hyperspaceEnterTime,
    hyperspaceExitTime,
    shockwaveSpeed = 1.25,
    layerDimDuration = 300,
  } = useGameStore((state) => state.starfieldConfig)
  const [isAnimating, setIsAnimating] = useState(false)
  const [isDimAnimating, setIsDimAnimating] = useState(false)
  const { invalidate } = useThree()
  const rafRef = useRef<number | null>(null)
  const dimRafRef = useRef<number | null>(null)
  const [shockwaveSequence, setShockwaveSequence] = useState(0)
  const shockwaveRafRef = useRef<number | null>(null)
  const shockwaveEndTimeRef = useRef<number>(0)

  const shockwaveActiveMs = useMemo(
    () => Math.max(shockwaveSpeed, 0) * 1000,
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

  const dimSpring = useSpring<DimSpringValues>({
    dimOpacity: dimmed ? 0.3 : 1.0,
    config: {
      duration: layerDimDuration,
      easing: easings.easeInOutQuad,
    },
    onStart: () => setIsDimAnimating(true),
    onRest: () => setIsDimAnimating(false),
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
    if (!isDimAnimating) {
      if (dimRafRef.current) {
        cancelAnimationFrame(dimRafRef.current)
        dimRafRef.current = null
      }
      return
    }

    const tick = () => {
      invalidate()
      dimRafRef.current = requestAnimationFrame(tick)
    }

    tick()

    return () => {
      if (dimRafRef.current) {
        cancelAnimationFrame(dimRafRef.current)
        dimRafRef.current = null
      }
    }
  }, [isDimAnimating, invalidate])

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

  const { dimOpacity } = dimSpring

  const contextValue = useMemo<AnimationContextValue>(
    () => ({
      scale,
      rotationSpeed,
      warpProgress,
      glowIntensity,
      distortion,
      isWarping,
      isAnimating: isWarping || isAnimating,
      dimOpacity,
      isDimmed: dimmed,
      isDimAnimating,
      shockwaveSequence,
      triggerShockwave,
    }),
    [
      scale,
      rotationSpeed,
      warpProgress,
      glowIntensity,
      distortion,
      isWarping,
      isAnimating,
      dimOpacity,
      dimmed,
      isDimAnimating,
      shockwaveSequence,
      triggerShockwave,
    ]
  )

  return (
    <AnimationContext.Provider value={contextValue}>
      {children}
    </AnimationContext.Provider>
  )
}

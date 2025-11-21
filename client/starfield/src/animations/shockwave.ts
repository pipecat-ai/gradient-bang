import { useCallback, useEffect, useState } from "react"
import { easings, useSpring, type SpringValue } from "@react-spring/three"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import type { AnimationRuntime } from "./runtime"

export function useShockwaveAnimation(runtime: AnimationRuntime) {
  const {
    shockwave: { shockwaveSpeed = 0.75, shockwaveEnabled = true },
  } = useGameStore((state) => state.starfieldConfig)
  const [shockwaveSequence, setShockwaveSequence] = useState(0)
  const setTriggerShockwave = useAnimationStore(
    (state) => state.setTriggerShockwave
  )

  const [spring, api] = useSpring<{
    shockwaveProgress: SpringValue<number>
  }>(() => ({
    shockwaveProgress: 0,
    config: { duration: shockwaveSpeed * 1000, easing: easings.linear },
    onStart: runtime.start,
    onRest: runtime.end,
    onChange: runtime.onChange,
  }))

  const triggerShockwave = useCallback(() => {
    if (!shockwaveEnabled) return
    setShockwaveSequence((value) => value + 1)
    runtime.onChange()
    api.start({
      from: { shockwaveProgress: 0 },
      to: { shockwaveProgress: 1 },
      reset: true,
      config: {
        duration: Math.max(shockwaveSpeed, 0) * 1000,
        easing: easings.linear,
      },
      onStart: runtime.start,
      onRest: runtime.end,
      onChange: runtime.onChange,
    })
  }, [api, shockwaveSpeed, runtime, shockwaveEnabled])

  useEffect(() => {
    if (!shockwaveEnabled) return
    setTriggerShockwave(triggerShockwave)
    return () => setTriggerShockwave(() => {})
  }, [setTriggerShockwave, triggerShockwave, shockwaveEnabled])

  return {
    shockwaveSequence,
    shockwaveProgress: spring.shockwaveProgress,
  }
}

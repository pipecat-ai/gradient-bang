import { useCallback, useEffect, useMemo, useRef } from "react"
import { useThree } from "@react-three/fiber"

export type AnimationRuntime = {
  start: () => void
  end: () => void
  onChange: () => void
}

export function useAnimationRuntime(
  onStateChange?: (isAnimating: boolean) => void
): AnimationRuntime {
  const { invalidate } = useThree()
  const activeAnimationsRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const onStateChangeRef = useRef(onStateChange)

  // Keep callback ref up to date
  useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      onStateChangeRef.current?.(false)
    }
  }, [])

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return
    const tick = () => {
      invalidate()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    onStateChangeRef.current?.(true)
  }, [invalidate])

  const start = useCallback(() => {
    activeAnimationsRef.current += 1
    if (activeAnimationsRef.current === 1) {
      startLoop()
    }
  }, [startLoop])

  const end = useCallback(() => {
    activeAnimationsRef.current -= 1
    if (activeAnimationsRef.current <= 0) {
      activeAnimationsRef.current = 0
      stopLoop()
    }
  }, [stopLoop])

  const onChange = useCallback(() => {
    if (rafRef.current === null) {
      invalidate()
    }
  }, [invalidate])

  useEffect(() => {
    return stopLoop
  }, [stopLoop])

  const runtime = useMemo(
    () => ({
      start,
      end,
      onChange,
    }),
    [start, end, onChange]
  )

  return runtime
}

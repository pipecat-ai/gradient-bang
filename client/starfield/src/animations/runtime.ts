import { useCallback, useEffect, useMemo, useRef } from "react"
import { useThree } from "@react-three/fiber"

export type AnimationRuntime = {
  start: () => void
  end: () => void
  onChange: () => void
}

const STOP_BUFFER_TIME = 1000

export function useAnimationRuntime(
  onStateChange?: (isAnimating: boolean) => void
): AnimationRuntime {
  const { invalidate } = useThree()
  const activeAnimationsRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const stopTimeoutRef = useRef<number | null>(null)
  const onStateChangeRef = useRef(onStateChange)

  // Keep callback ref up to date
  useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  const clearStopTimeout = useCallback(() => {
    if (stopTimeoutRef.current !== null) {
      clearTimeout(stopTimeoutRef.current)
      stopTimeoutRef.current = null
    }
  }, [])

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

    // Cancel any pending stop if a new animation starts
    clearStopTimeout()

    if (activeAnimationsRef.current === 1) {
      startLoop()
    }
  }, [startLoop, clearStopTimeout])

  const end = useCallback(() => {
    activeAnimationsRef.current -= 1
    if (activeAnimationsRef.current <= 0) {
      activeAnimationsRef.current = 0

      // Clear any existing timeout to debounce multiple end calls
      clearStopTimeout()

      // Add a 1-second buffer before stopping the loop
      stopTimeoutRef.current = window.setTimeout(() => {
        stopTimeoutRef.current = null
        stopLoop()
      }, STOP_BUFFER_TIME)
    }
  }, [stopLoop, clearStopTimeout])

  const onChange = useCallback(() => {
    if (rafRef.current === null) {
      invalidate()
    }
  }, [invalidate])

  useEffect(() => {
    return () => {
      clearStopTimeout()
      stopLoop()
    }
  }, [stopLoop, clearStopTimeout])

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

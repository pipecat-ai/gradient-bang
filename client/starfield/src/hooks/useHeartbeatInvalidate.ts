import { useEffect } from "react"
import { useThree } from "@react-three/fiber"

/**
 * Provides a low-frequency render heartbeat in demand mode.
 * Useful when the scene is otherwise idle but you still want
 * the renderer to refresh every `intervalMs` milliseconds.
 */
export function useHeartbeatInvalidate(intervalMs = 1000) {
  const { invalidate } = useThree()

  useEffect(() => {
    if (intervalMs <= 0) return

    const id = window.setInterval(() => {
      invalidate()
    }, intervalMs)

    return () => {
      window.clearInterval(id)
    }
  }, [intervalMs, invalidate])
}


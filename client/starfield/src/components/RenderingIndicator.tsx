import { useEffect, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { useControls } from "leva"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

export function RenderingIndicator() {
  const isAnimating = useAnimationStore((state) => state.isAnimating)
  const isPaused = useGameStore((state) => state.isPaused)

  const [, setRenderStatus] = useControls(() => ({
    renderStatus: {
      value: "Idle",
      editable: false,
      label: "Render Loop",
      order: -999,
    },
    isAnimating: {
      value: "Idle",
      editable: false,
      label: "Animating",
      order: -998,
    },
  }))
  const timeoutRef = useRef<number | null>(null)

  // Update isAnimating status
  useEffect(() => {
    setRenderStatus({ isAnimating: isAnimating ? "Animating" : "Idle" })
  }, [isAnimating, setRenderStatus])

  // Handle pause state - clear any pending timeouts
  useEffect(() => {
    if (isPaused) {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      setRenderStatus({ renderStatus: "Paused" })
    }
  }, [isPaused, setRenderStatus])

  // Track rendering in useFrame (only runs when not paused)
  useFrame(() => {
    if (isPaused) return

    setRenderStatus({ renderStatus: "Rendering" })

    // Clear existing timeout
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
    }

    // Set to idle after 100ms of no frames
    timeoutRef.current = window.setTimeout(() => {
      if (!isPaused) {
        setRenderStatus({ renderStatus: "Idle" })
      }
      timeoutRef.current = null
    }, 100)
  })

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return null
}

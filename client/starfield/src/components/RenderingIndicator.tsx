import { useEffect, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { useControls } from "leva"

import { useAnimationStore } from "@/useAnimationStore"

export function RenderingIndicator() {
  const isAnimating = useAnimationStore((state) => state.isAnimating)

  const [, setRenderStatus] = useControls(
    () => ({
      renderStatus: {
        value: "Idle",
        editable: false,
        label: "Render Loop",
        order: -999,
      },
      isAnimating: {
        value: isAnimating ? "Animating" : "Idle",
        editable: false,
        label: "Is Animating",
        order: -998,
      },
    }),
    [isAnimating]
  )
  const timeoutRef = useRef<number | null>(null)

  useFrame(() => {
    setRenderStatus({ renderStatus: "Rendering" })
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = window.setTimeout(() => {
      setRenderStatus({ renderStatus: "Idle" })
      timeoutRef.current = null
    }, 100)
  })

  useEffect(() => {
    setRenderStatus({ isAnimating: isAnimating ? "Animating" : "Idle" })
  }, [isAnimating, setRenderStatus])

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return null
}

import { useEffect, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import { useControls } from "leva"

export function RenderingIndicator() {
  const [, setRenderStatus] = useControls(() => ({
    renderStatus: {
      value: "Idle",
      editable: false,
      label: "Render Loop",
      order: -999,
    },
  }))
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
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return null
}

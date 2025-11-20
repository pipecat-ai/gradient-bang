import { useEffect, useRef } from "react"
import { useThree } from "@react-three/fiber"
import { useGameStore } from "@/useGameStore"

export function SceneController() {
  const { invalidate } = useThree()
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  const { isSceneChanging, allComponentsReady, completeSceneChange } =
    useGameStore()

  // Monitor ready flags during transition
  useEffect(() => {
    if (isSceneChanging && allComponentsReady()) {
      console.debug("[SCENE CONTROLLER] All components ready, resuming render")

      // Bit of air for pacing
      transitionTimeoutRef.current = setTimeout(() => {
        completeSceneChange()
        invalidate()
      }, 500)
    }

    return () => {
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current)
      }
    }
  }, [isSceneChanging, allComponentsReady, completeSceneChange, invalidate])

  return null
}

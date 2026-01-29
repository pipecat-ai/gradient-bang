import { useCallback } from "react"

import type { Scene, SceneChangeOptions } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"

export function useSceneChange() {
  const changeScene = useCallback(
    (scene: Scene, options?: SceneChangeOptions) => {
      const enqueueScene = useCallbackStore.getState().enqueueScene
      enqueueScene(scene, options)
    },
    []
  )

  return { changeScene }
}

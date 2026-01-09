import type { Scene, SceneChangeOptions } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"

export function useSceneChange() {
  const changeScene = (scene: Scene, options?: SceneChangeOptions) => {
    const enqueueScene = useCallbackStore.getState().enqueueScene
    enqueueScene(scene, options)
  }

  return { changeScene }
}

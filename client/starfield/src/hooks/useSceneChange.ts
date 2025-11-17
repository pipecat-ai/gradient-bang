import type { Scene } from "@/types"
import { useGameStore } from "@/useGameStore"

export function useSceneChange() {
  const enqueueScene = useGameStore((state) => state.enqueueScene)

  const changeScene = (scene: Scene) => {
    console.log("[useSceneChange] Requesting scene change:", scene.id)
    enqueueScene(scene)
  }

  return { changeScene }
}

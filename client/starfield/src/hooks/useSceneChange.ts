import { useGameStore } from "@/useGameStore"
import type { SceneConfig } from "@/types"

export function useSceneChange() {
  const startSceneChange = useGameStore((state) => state.startSceneChange)

  const changeScene = (newConfig: SceneConfig) => {
    startSceneChange(newConfig)
  }

  return { changeScene }
}

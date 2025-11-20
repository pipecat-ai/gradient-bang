import { useEffect, useRef } from "react"

import type { SceneConfig } from "@/types"
import { useGameStore } from "@/useGameStore"

export function useSceneObject(
  componentId: string,
  onApplyNewConfig?: (config: SceneConfig) => void | Promise<void>
) {
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const setComponentReady = useGameStore((state) => state.setComponentReady)
  const sceneConfig: SceneConfig | undefined = useGameStore(
    (state) => state.sceneConfig
  )
  const hasSignaledReady = useRef(false)
  const previousConfig = useRef<SceneConfig>(sceneConfig)

  useEffect(() => {
    if (isSceneChanging && !hasSignaledReady.current) {
      // Let component reconfigure first
      const applyNewConfig = async () => {
        console.debug(
          `[SCENE OBJECT ${componentId}] Applying new scene config`,
          sceneConfig
        )
        if (onApplyNewConfig) {
          await onApplyNewConfig(sceneConfig ?? {})
        }

        // Then signal ready after reconfiguration
        /*requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            console.debug(`[SCENE OBJECT ${componentId}] Ready`)
            setComponentReady(componentId, true)
            hasSignaledReady.current = true
          })
        })*/
      }
      applyNewConfig()
    } else if (!isSceneChanging) {
      hasSignaledReady.current = false
      previousConfig.current = sceneConfig
    }
  }, [
    isSceneChanging,
    sceneConfig,
    componentId,
    setComponentReady,
    onApplyNewConfig,
  ])

  return { sceneConfig, isSceneChanging }
}

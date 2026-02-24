import { useEffect, useMemo } from "react"
import { button, folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { getPaletteNames } from "@/colors"
import { DEFAULT_DPR, MAX_RENDER_PIXELS, PANEL_ORDERING } from "@/constants"
import { useSceneChange } from "@/hooks/useSceneChange"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"
import { generateRandomScene } from "@/utils/scene"

function getClampedDpr(): number {
  // Clamp so the framebuffer doesn't exceed MAX_RENDER_PIXELS on large displays
  const canvasPixels = window.innerWidth * window.innerHeight
  const maxDpr = Math.sqrt(MAX_RENDER_PIXELS / canvasPixels)
  return Math.min(DEFAULT_DPR.high, maxDpr)
}

export const useDevControls = () => {
  const showControls = useShowControls()
  const defaultDpr = useMemo(() => getClampedDpr(), [])

  const togglePause = useGameStore((state) => state.togglePause)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const sceneQueueLength = useGameStore((state) => state.sceneQueue.length)
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const currentSceneId = useGameStore((state) => state.currentScene?.id)
  const isSceneCooldownActive = useGameStore(
    (state) => state.isSceneCooldownActive
  )
  const setLookAtTarget = useGameStore((state) => state.setLookAtTarget)

  const { changeScene } = useSceneChange()

  const logSceneConfig = () => {
    console.log("[STARFIELD] Config", useGameStore.getState().starfieldConfig)
  }

  const [levaValues, setControls] = useControls(
    () =>
      (showControls
        ? {
            "Scene Settings": folder(
              {
                palette: {
                  value: starfieldConfig.palette,
                  options: getPaletteNames(),
                  label: "Color Palette",
                  onChange: (value: string, _path, context) => {
                    if (context.initial) return
                    setStarfieldConfig({ palette: value })
                  },
                  transient: false,
                },
                sceneQueueLength: {
                  value: sceneQueueLength.toString(),
                  editable: false,
                  label: "Scene Queue Length",
                },
                sceneChanging: {
                  value: isSceneChanging.toString(),
                  editable: false,
                  label: "Scene Changing",
                },
                sceneId: {
                  value: currentSceneId?.toString() ?? "",
                  editable: false,
                  label: "Current Scene ID",
                },
                sceneCooldownActive: {
                  value: isSceneCooldownActive ? "Active" : "Inactive",
                  editable: false,
                  label: "Scene Cooldown",
                },
                ["Generate Random Scene"]: button(() => {
                  changeScene({
                    id: Math.random().toString(36).substring(2, 15),
                    gameObjects: [],
                    config: generateRandomScene(),
                  })
                }),
                ["Random Scene no Animation"]: button(() => {
                  changeScene(
                    {
                      id: Math.random().toString(36).substring(2, 15),
                      gameObjects: [],
                      config: generateRandomScene(),
                    },
                    { bypassAnimation: true }
                  )
                }),
                ["Log Scene Config"]: button(logSceneConfig),
                ["Change to Scene 1"]: button(() => {
                  changeScene({
                    id: "1",
                    gameObjects: [],
                    config: {},
                  })
                }),
                ["Pause / Resume Rendering"]: button(() => {
                  togglePause()
                }),
                ["Clear Look At Target"]: button(() => {
                  setLookAtTarget(undefined)
                }),
                Performance: folder(
                  {
                    dpr: {
                      value: defaultDpr,
                      min: 0.5,
                      max: 1.5,
                      step: 0.5,
                      label: "DPR",
                    },
                  },
                  { collapsed: true, order: 99 }
                ),
              },
              { collapsed: true, order: PANEL_ORDERING.SCENE_SETTINGS }
            ),
          }
        : {}) as Schema
  )
  const levaDpr = (levaValues as { dpr?: number }).dpr

  // Sync: store palette -> Leva controls
  useEffect(() => {
    if (!showControls) return
    if (starfieldConfig.palette) {
      try {
        setControls({ palette: starfieldConfig.palette })
      } catch {
        // Controls not mounted yet
      }
    }
  }, [starfieldConfig.palette, setControls, showControls])

  useEffect(() => {
    if (!showControls) return

    try {
      setControls({
        sceneQueueLength: sceneQueueLength.toString(),
        sceneChanging: isSceneChanging.toString(),
        sceneId: currentSceneId?.toString() ?? "",
        sceneCooldownActive: isSceneCooldownActive ? "Active" : "Inactive",
      })
    } catch {
      // Controls not mounted yet
    }
  }, [
    sceneQueueLength,
    isSceneChanging,
    currentSceneId,
    isSceneCooldownActive,
    setControls,
    showControls,
  ])

  // Return Leva value when controls shown, default otherwise
  const dpr = showControls ? levaDpr : defaultDpr

  return { dpr, setControls }
}

import { useEffect } from "react"
import { button, folder, useControls } from "leva"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import { useSceneChange } from "./useSceneChange"

export const useDevControls = () => {
  const togglePause = useGameStore((state) => state.togglePause)
  const isPaused = useGameStore((state) => state.isPaused)
  const { changeScene } = useSceneChange()

  const { isWarping, startWarp, stopWarp } = useAnimationStore()

  const [, setSceneControls] = useControls(
    "Scene Settings",
    () => ({
      ["Log Config"]: button(() => {
        console.log("Config", useGameStore.getState().starfieldConfig)
      }),
      ["Random Scene Change"]: button(() => {
        changeScene({
          id: Math.random().toString(36).substring(2, 15),
          gameObjects: [],
          config: {},
        })
      }),
      ["Scene 1 Change"]: button(() => {
        changeScene({
          id: "1",
          gameObjects: [],
          config: {},
        })
      }),
      ["Start Warp"]: button(() => {
        startWarp()
      }),
      ["Stop Warp"]: button(() => {
        stopWarp()
      }),
      warpStatus: {
        value: isWarping ? "Warping" : "Not Warping",
        editable: false,
      },
      pauseStatus: {
        value: isPaused ? "Paused" : "Not Paused",
        editable: false,
      },
    }),
    [changeScene, startWarp, stopWarp]
  )

  useEffect(() => {
    setSceneControls({ warpStatus: isWarping ? "Warping" : "Not Warping" })
  }, [isWarping])

  const [{ dpr }, setPerformance] = useControls(() => ({
    "Render Settings": folder(
      {
        [isPaused ? "Resume" : "Pause"]: button(() => {
          togglePause()
        }),
        dpr: {
          value: 1.5,
          min: 1,
          max: 2,
          step: 0.1,
          label: "DPR",
        },
      },
      { collapsed: true }
    ),
  }))

  return { dpr, setPerformance }
}

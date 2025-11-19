import { useEffect } from "react"
import { button, folder, useControls } from "leva"

import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import { useSceneChange } from "./useSceneChange"

export const useDevControls = () => {
  const togglePause = useGameStore((state) => state.togglePause)
  const isPaused = useGameStore((state) => state.isPaused)
  const { changeScene } = useSceneChange()

  const isWarping = useAnimationStore((state) => state.isWarping)
  const startWarp = useAnimationStore((state) => state.startWarp)
  const stopWarp = useAnimationStore((state) => state.stopWarp)
  const isDimmed = useAnimationStore((state) => state.isDimmed)
  const setIsDimmed = useAnimationStore((state) => state.setIsDimmed)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  const [, _setSceneControls] = useControls(
    "Scene Settings",
    () => ({
      ["Log Config"]: button(() => {
        console.log("Config", useGameStore.getState().starfieldConfig)
      }),
      ["Generate New Scene"]: button(() => {
        changeScene({
          id: Math.random().toString(36).substring(2, 15),
          gameObjects: [],
          config: {},
        })
      }),
      ["Change to Scene 1"]: button(() => {
        changeScene({
          id: "1",
          gameObjects: [],
          config: {},
        })
      }),
    }),
    [changeScene, setIsDimmed]
  )

  const [{ dpr }, setPerformance] = useControls(() => ({
    "Scene Settings": folder({
      Rendering: folder(
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
    }),
  }))

  const [, setTriggers] = useControls(
    () => ({
      Triggers: folder({
        Warp: folder(
          {
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
          },
          { collapsed: true }
        ),
        Dim: folder(
          {
            ["Dim"]: button(() => {
              setIsDimmed(true)
            }),
            ["Undim"]: button(() => {
              setIsDimmed(false)
            }),
            dimStatus: {
              value: isDimmed ? "Dimmed" : "Not Dimmed",
              editable: false,
            },
          },
          { collapsed: true }
        ),
        Shockwave: folder(
          {
            ["Trigger Shockwave"]: button(() => {
              triggerShockwave()
            }),
          },
          { collapsed: true }
        ),
      }),
    }),
    [isWarping, startWarp, stopWarp, triggerShockwave]
  )

  useEffect(() => {
    setTriggers({
      warpStatus: isWarping ? "Warping" : "Not Warping",
      dimStatus: isDimmed ? "Dimmed" : "Not Dimmed",
    })
  }, [isWarping, isDimmed, setTriggers])

  return { dpr, setPerformance }
}

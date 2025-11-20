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
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  const [, _setSceneControls] = useControls(() => ({
    "Scene Settings": folder(
      {
        ["Log Config"]: button(() => {
          console.log("Config", useGameStore.getState().starfieldConfig)
        }),
        ["Use ASCII Renderer"]: button(() => {
          //@ not yet implemented
          setStarfieldConfig({ useASCIIRenderer: true })
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
      },
      { collapsed: true, order: -1 }
    ),
  }))

  const [{ dpr }, setPerformance] = useControls(() => ({
    "Scene Settings": folder(
      {
        Rendering: folder(
          {
            [isPaused ? "Resume" : "Pause"]: button(() => {
              togglePause()
            }),
            dpr: {
              value: 1.5,
              min: 0.5,
              max: 2,
              step: 0.5,
              label: "DPR",
            },
          },
          { collapsed: true, order: 99 }
        ),
      },
      { collapsed: true, order: -1 }
    ),
  }))

  const [, setTriggers] = useControls(
    () => ({
      Triggers: folder(
        {
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
        },
        { order: -1 }
      ),
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

import { useEffect, useMemo } from "react"
import { button, folder, useControls } from "leva"

import { getPaletteNames } from "@/colors"
import type { PerformanceProfile } from "@/types"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

import { useSceneChange } from "./useSceneChange"

export const useDevControls = ({
  profile,
}: {
  profile?: PerformanceProfile
}) => {
  const togglePause = useGameStore((state) => state.togglePause)
  const isPaused = useGameStore((state) => state.isPaused)
  const { changeScene } = useSceneChange()

  const isWarping = useAnimationStore((state) => state.isWarping)
  const startWarp = useAnimationStore((state) => state.startWarp)
  const stopWarp = useAnimationStore((state) => state.stopWarp)
  const isDimmed = useAnimationStore((state) => state.isDimmed)
  const setIsDimmed = useAnimationStore((state) => state.setIsDimmed)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  const initialDPRValue = useMemo(() => {
    return profile === "low" ? 0.5 : profile === "mid" ? 1.5 : 2
  }, [profile])

  const [{ palette }, _setSceneControls] = useControls(
    () => ({
      "Scene Settings": folder(
        {
          palette: {
            value: starfieldConfig.palette || "default",
            options: getPaletteNames(),
            label: "Color Palette",
          },
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
        },
        { collapsed: true, order: -1 }
      ),
    }),
    [starfieldConfig.palette]
  )

  const [{ dpr }, setPerformance] = useControls(() => ({
    "Scene Settings": folder(
      {
        Rendering: folder(
          {
            [isPaused ? "Resume" : "Pause"]: button(() => {
              togglePause()
            }),
            dpr: {
              value: initialDPRValue,
              min: 1,
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

  useEffect(() => {
    if (palette !== starfieldConfig.palette) {
      setStarfieldConfig({ palette })
    }
  }, [palette, starfieldConfig.palette, setStarfieldConfig])

  return { dpr, setPerformance }
}

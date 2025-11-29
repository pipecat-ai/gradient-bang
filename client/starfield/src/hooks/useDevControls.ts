import { useEffect, useMemo } from "react"
import { button, folder, levaStore, useControls } from "leva"

import { getPaletteNames } from "@/colors"
import { PANEL_ORDERING } from "@/constants"
import { useSceneChange } from "@/hooks/useSceneChange"
import type { PerformanceProfile } from "@/types"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"
import { generateRandomScene } from "@/utils/scene"

export const useDevControls = ({
  profile,
}: {
  profile?: PerformanceProfile
}) => {
  const togglePause = useGameStore((state) => state.togglePause)
  const isWarping = useAnimationStore((state) => state.isWarping)
  const startWarp = useAnimationStore((state) => state.startWarp)
  const stopWarp = useAnimationStore((state) => state.stopWarp)
  const isDimmed = useAnimationStore((state) => state.isDimmed)
  const setIsDimmed = useAnimationStore((state) => state.setIsDimmed)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const triggerShockwave = useAnimationStore((state) => state.triggerShockwave)

  const { changeScene } = useSceneChange()

  const logSceneConfig = () => {
    // We combine the leva state with our starfield state so any changes
    // made are reflected in the output
    const levaState = levaStore.getData()

    console.log("Config", useGameStore.getState().starfieldConfig, levaState)
  }

  const initialDPRValue = useMemo(() => {
    return profile === "low" ? 0.5 : profile === "mid" ? 1.5 : 2
  }, [profile])

  const [, _setSceneControls] = useControls(() => ({
    "Scene Settings": folder(
      {
        palette: {
          value: starfieldConfig.palette,
          options: getPaletteNames(),
          label: "Color Palette",
          onChange: (value: string, _path, context) => {
            if (context.initial) {
              return
            }
            setStarfieldConfig({ palette: value })
          },
          transient: false,
        },
        ["Generate Random Scene"]: button(() => {
          changeScene({
            id: Math.random().toString(36).substring(2, 15),
            gameObjects: [],
            config: generateRandomScene(),
          })
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
      },
      { collapsed: true, order: PANEL_ORDERING.SCENE_SETTINGS }
    ),
  }))

  const [{ dpr }, setPerformance] = useControls(() => ({
    "Scene Settings": folder(
      {
        Performance: folder(
          {
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
        { collapsed: true, order: PANEL_ORDERING.TRIGGERS }
      ),
    }),
    [isWarping, startWarp, stopWarp, triggerShockwave]
  )

  // Sync: store trigger statuses -> Leva controls
  useEffect(() => {
    setTriggers({
      warpStatus: isWarping ? "Warping" : "Not Warping",
      dimStatus: isDimmed ? "Dimmed" : "Not Dimmed",
    })
  }, [isWarping, isDimmed, setTriggers])

  // Sync: store palette -> Leva controls
  useEffect(() => {
    _setSceneControls({ palette: starfieldConfig.palette })
  }, [starfieldConfig.palette, _setSceneControls])

  return { dpr, setPerformance }
}

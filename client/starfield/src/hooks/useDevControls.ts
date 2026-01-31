import { startTransition, useEffect, useMemo, useRef } from "react"
import { button, folder, useControls } from "leva"

import { getPaletteNames } from "@/colors"
import { PANEL_ORDERING } from "@/constants"
import { useSceneChange } from "@/hooks/useSceneChange"
import type { GameObject, PerformanceProfile } from "@/types"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"
import { generateRandomScene } from "@/utils/scene"

const OBJECT_TYPES: GameObject["type"][] = [
  "port",
  "ship",
  "garrison",
  "salvage",
]

export const useDevControls = ({
  profile,
}: {
  profile?: PerformanceProfile
}) => {
  const togglePause = useGameStore((state) => state.togglePause)
  const exposure = useAnimationStore((state) => state.exposure)
  const setExposure = useAnimationStore((state) => state.setExposure)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const sceneQueueLength = useGameStore((state) => state.sceneQueue.length)
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)
  const setIsShaking = useAnimationStore((state) => state.setIsShaking)
  const currentSceneId = useGameStore((state) => state.currentScene?.id)
  const isWarpCooldownActive = useGameStore(
    (state) => state.isWarpCooldownActive
  )
  const performanceProfile = useGameStore((state) => state.performanceProfile)
  const gameObjects = useGameStore((state) => state.gameObjects)
  const setGameObjects = useGameStore((state) => state.setGameObjects)
  const setLookAtTarget = useGameStore((state) => state.setLookAtTarget)

  const { changeScene } = useSceneChange()

  const logSceneConfig = () => {
    // We combine the leva state with our starfield state so any changes
    // made are reflected in the output
    //const levaState = levaStore.getData()
    console.log("Config", useGameStore.getState().starfieldConfig) //, levaState)
  }

  const initialDPRValue = useMemo(() => {
    return profile === "low" ? 1 : profile === "mid" ? 1.5 : 2
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
        warpCooldownActive: {
          value: isWarpCooldownActive ? "Active" : "Inactive",
          editable: false,
          label: "Warp Cooldown",
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
          setLookAtTarget(null)
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

  useControls(
    () => ({
      Triggers: folder(
        {
          ["Camera Shake"]: folder(
            {
              ["Enable Camera Shake"]: button(() => {
                setIsShaking(true)
              }),
              ["Disable Camera Shake"]: button(() => {
                setIsShaking(false)
              }),
            },
            { collapsed: true }
          ),
          Exposure: folder(
            {
              ["Fade Out"]: button(() => {
                setExposure(0)
              }),
              ["Fade In"]: button(() => {
                setExposure(1)
              }),
              exposureStatus: {
                value:
                  exposure === 1
                    ? "100%"
                    : exposure === 0
                      ? "0%"
                      : `${Math.round(exposure * 100)}%`,
                editable: false,
                label: "Exposure",
              },
            },
            { collapsed: true }
          ),
        },
        { collapsed: true, order: PANEL_ORDERING.TRIGGERS }
      ),
    }),
    []
  )

  // Build dynamic game object controls
  const gameObjectControlsConfig = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectRows: Record<string, any> = {}

    // Add button at the top - use startTransition to prevent Suspense fallback
    objectRows["Add Object"] = button(() => {
      const currentObjects = useGameStore.getState().gameObjects
      const portCount =
        currentObjects.filter((o) => o.type === "port").length + 1
      const newObject: GameObject = {
        id: crypto.randomUUID(),
        type: "port",
        label: `PORT-${String(portCount).padStart(3, "0")}`,
      }
      startTransition(() => {
        setGameObjects([...currentObjects, newObject])
      })
    })

    // Clear all button
    objectRows["Clear All"] = button(() => {
      startTransition(() => {
        setGameObjects([])
      })
    })

    // Create controls for each game object (flat, no sub-folders)
    gameObjects.forEach((obj, index) => {
      const shortId = obj.id.slice(0, 8)
      const prefix = `${index + 1}`

      objectRows[`${prefix}_type_${shortId}`] = {
        value: obj.type ?? "port",
        options: OBJECT_TYPES,
        label: `${prefix}. Type`,
        onChange: (
          value: GameObject["type"],
          _path: string,
          context: { initial: boolean }
        ) => {
          // Skip initial render
          if (context.initial) return
          // Skip if value hasn't changed
          if (value === obj.type) return
          const current = useGameStore.getState().gameObjects
          const updated = current.map((o) =>
            o.id === obj.id ? { ...o, type: value } : o
          )
          startTransition(() => {
            setGameObjects(updated)
          })
        },
      }

      objectRows[`${prefix}_label_${shortId}`] = {
        value: obj.label ?? "",
        label: `${prefix}. Label`,
        onChange: (
          value: string,
          _path: string,
          context: { initial: boolean }
        ) => {
          if (context.initial) return
          if (value === obj.label) return
          const current = useGameStore.getState().gameObjects
          const updated = current.map((o) =>
            o.id === obj.id ? { ...o, label: value || undefined } : o
          )
          startTransition(() => {
            setGameObjects(updated)
          })
        },
      }

      objectRows[`${prefix}_lookAt_${shortId}`] = button(() => {
        setLookAtTarget(obj.id)
      })

      objectRows[`${prefix}_remove_${shortId}`] = button(() => {
        const current = useGameStore.getState().gameObjects
        startTransition(() => {
          setGameObjects(current.filter((o) => o.id !== obj.id))
        })
      })
    })

    return objectRows
  }, [gameObjects, setGameObjects, setLookAtTarget])

  useControls(
    () => ({
      "Game Objects": folder(gameObjectControlsConfig, {
        collapsed: true,
        order: PANEL_ORDERING.TRIGGERS + 1,
      }),
    }),
    [gameObjectControlsConfig]
  )

  // Sync: profile changes -> DPR control (only when profile changes, not on manual DPR edits)
  // Initialize with null so the first render always syncs if a profile is set
  const prevProfileRef = useRef<PerformanceProfile | null>(null)
  useEffect(() => {
    if (performanceProfile && prevProfileRef.current !== performanceProfile) {
      const newDpr =
        performanceProfile === "low"
          ? 1
          : performanceProfile === "mid"
            ? 1.5
            : 2
      setPerformance({ dpr: newDpr })
      prevProfileRef.current = performanceProfile
    }
  }, [performanceProfile, setPerformance])

  // Sync: store palette -> Leva controls
  useEffect(() => {
    _setSceneControls({ palette: starfieldConfig.palette })
  }, [starfieldConfig.palette, _setSceneControls])

  useEffect(() => {
    _setSceneControls({
      sceneQueueLength: sceneQueueLength.toString(),
      sceneChanging: isSceneChanging.toString(),
      sceneId: currentSceneId?.toString() ?? "",
      warpCooldownActive: isWarpCooldownActive ? "Active" : "Inactive",
    })
  }, [
    sceneQueueLength,
    isSceneChanging,
    currentSceneId,
    isWarpCooldownActive,
    _setSceneControls,
  ])

  return { dpr, setPerformance }
}

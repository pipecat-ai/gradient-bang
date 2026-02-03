import { useEffect, useRef } from "react"
import { useDetectGPU } from "@react-three/drei"
import { deepmerge } from "deepmerge-ts"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { PANEL_ORDERING, PERFORMANCE_PROFILES } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { EXCLUDED_PROFILE_KEYS, PROFILE_MAP } from "@/profiles"
import type { PerformanceProfile, StarfieldConfig } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

/** Omit specific keys from an object */
const omitKeys = <T extends object>(
  obj: T,
  keys: readonly (keyof T)[]
): Partial<T> => {
  const result = { ...obj }
  keys.forEach((key) => delete result[key])
  return result
}

export const usePerformanceProfile = ({
  initialProfile,
}: {
  initialProfile?: PerformanceProfile
}) => {
  const showControls = useShowControls()
  const setPerformanceProfile = useGameStore(
    (state) => state.setPerformanceProfile
  )
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const performanceProfile = useGameStore((state) => state.performanceProfile)
  const { tier, isMobile } = useDetectGPU()

  const [levaValues] = useControls(
    () =>
      (showControls
        ? {
            "Scene Settings": folder(
              {
                Performance: folder(
                  {
                    forcedProfile: {
                      value: initialProfile,
                      label: "Force Performance Profile",
                      options: PERFORMANCE_PROFILES,
                    },
                  },
                  { collapsed: true, order: 999 }
                ),
              },
              { collapsed: true, order: PANEL_ORDERING.SCENE_SETTINGS }
            ),
          }
        : {}) as Schema
  )
  const forcedProfile = showControls
    ? (levaValues as { forcedProfile?: PerformanceProfile }).forcedProfile
    : undefined

  useEffect(() => {
    // Degrade profile based on target against capability
    const currentProfile = useGameStore.getState().performanceProfile
    let targetProfile: PerformanceProfile = "high"

    if (forcedProfile && forcedProfile !== "auto") {
      targetProfile = forcedProfile as PerformanceProfile
    } else {
      if (tier === 0 || (isMobile && tier <= 1)) {
        // Trigger no WebGL callback
        useCallbackStore.getState().onUnsupported?.()
      } else {
        if (initialProfile && initialProfile !== "auto") {
          // Use specified profile
          targetProfile = initialProfile
        } else {
          // Use GPU detection
          if (tier === 1 || isMobile) {
            targetProfile = "low"
          } else if (tier === 2) {
            targetProfile = "mid"
          }
        }
      }
    }
    if (currentProfile !== targetProfile) {
      console.log("[STARFIELD] Setting Performance Profile:", targetProfile)
      setPerformanceProfile(targetProfile)
    }
  }, [initialProfile, setPerformanceProfile, tier, isMobile, forcedProfile])

  const prevProfileRef = useRef<PerformanceProfile | null>("high")

  useEffect(() => {
    if (!performanceProfile || prevProfileRef.current === performanceProfile)
      return
    prevProfileRef.current = performanceProfile

    console.log(
      "[STARFIELD] Updating Starfield Config to Profile:",
      performanceProfile
    )

    const previousConfig = useGameStore.getState().starfieldConfig
    const profile = PROFILE_MAP[performanceProfile as PerformanceProfile]
    const profileOverrides = omitKeys(profile, EXCLUDED_PROFILE_KEYS)

    // Update config with new performance profile defaults (excluding preserved keys)
    setStarfieldConfig({
      ...deepmerge(previousConfig, profileOverrides as StarfieldConfig),
    })
  }, [setStarfieldConfig, performanceProfile])
}

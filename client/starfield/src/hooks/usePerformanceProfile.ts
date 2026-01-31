import { useEffect } from "react"
import { useDetectGPU } from "@react-three/drei"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { PANEL_ORDERING, PERFORMANCE_PROFILES } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
import type { PerformanceProfile } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

export const usePerformanceProfile = ({
  initialProfile,
}: {
  initialProfile?: PerformanceProfile
}) => {
  const showControls = useShowControls()
  const setPerformanceProfile = useGameStore(
    (state) => state.setPerformanceProfile
  )
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
    let targetProfile: PerformanceProfile = "high"

    if (tier === 0 || (isMobile && tier <= 1)) {
      // Trigger no WebGL callback
      useCallbackStore.getState().onUnsupported?.()
      return
    }

    if (initialProfile) {
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

    if (forcedProfile) {
      targetProfile = forcedProfile
    }

    if (useGameStore.getState().performanceProfile !== targetProfile) {
      console.log("[STARFIELD] Setting Performance Profile:", targetProfile)
      setPerformanceProfile(targetProfile)
    }
  }, [initialProfile, setPerformanceProfile, tier, isMobile, forcedProfile])
}

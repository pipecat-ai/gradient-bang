import { useLayoutEffect } from "react"
import { useDetectGPU } from "@react-three/drei"
import { folder, useControls } from "leva"

import type { PerformanceProfile } from "@/types"
import { useCallbackStore } from "@/useCallbackStore"
import { useGameStore } from "@/useGameStore"

export const usePerformanceProfile = ({
  initialProfile,
}: {
  initialProfile?: PerformanceProfile
}) => {
  const setPerformanceProfile = useGameStore(
    (state) => state.setPerformanceProfile
  )
  const { tier, isMobile } = useDetectGPU()

  const [{ forcedProfile }] = useControls(() => ({
    "Scene Settings": folder({
      Rendering: folder(
        {
          forcedProfile: {
            value: undefined,
            options: ["low", "mid", "high"] as PerformanceProfile[],
          },
        },
        { collapsed: true, order: 99 }
      ),
    }),
  }))

  useLayoutEffect(() => {
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

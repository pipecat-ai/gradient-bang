import { useLayoutEffect } from "react"
import { useDetectGPU } from "@react-three/drei"
import { folder, useControls } from "leva"

import type { PerformanceProfile } from "@/types"
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
        { collapsed: true }
      ),
    }),
  }))

  useLayoutEffect(() => {
    let targetProfile: PerformanceProfile = "high"

    if (initialProfile) {
      // Use specified profile
      targetProfile = initialProfile
    } else {
      // Use GPU detection
      if (tier === 0 || isMobile) {
        targetProfile = "low"
      } else if (tier === 1) {
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

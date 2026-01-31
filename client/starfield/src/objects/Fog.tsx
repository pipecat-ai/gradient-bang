import { useEffect } from "react"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { getPalette } from "@/colors"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"

// Default fog config values
const DEFAULT_FOG_CONFIG = {
  enabled: true,
  near: 0,
  far: 80,
}

export const Fog = () => {
  const showControls = useShowControls()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { fog: fogConfig } = starfieldConfig
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  const palette = getPalette(starfieldConfig.palette)
  const defaultColor = fogConfig?.color ?? `#${palette.base.getHexString()}`

  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            "Scene Settings": folder({
              Fog: folder(
                {
                  enabled: {
                    value: fogConfig?.enabled ?? DEFAULT_FOG_CONFIG.enabled,
                    onChange: (value: boolean) => {
                      setStarfieldConfig({ fog: { enabled: value } })
                    },
                  },
                  color: {
                    value: defaultColor,
                  },
                  near: {
                    value: fogConfig?.near ?? DEFAULT_FOG_CONFIG.near,
                    min: 1,
                    max: 100,
                    step: 1,
                    label: "Near",
                  },
                  far: {
                    value: fogConfig?.far ?? DEFAULT_FOG_CONFIG.far,
                    min: 1,
                    max: 100,
                    step: 1,
                    label: "Far",
                  },
                },
                { collapsed: true }
              ),
            }),
          }
        : {}) as Schema
  )

  // Get values from Leva when showing controls, otherwise from config/defaults
  const color = showControls
    ? (levaValues as { color: string }).color
    : defaultColor
  const near = showControls
    ? (levaValues as { near: number }).near
    : (fogConfig?.near ?? DEFAULT_FOG_CONFIG.near)
  const far = showControls
    ? (levaValues as { far: number }).far
    : (fogConfig?.far ?? DEFAULT_FOG_CONFIG.far)

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (!showControls) return
    if (!fogConfig?.color) {
      set({ color: `#${palette.base.getHexString()}` })
    }
  }, [showControls, starfieldConfig.palette, palette, fogConfig, set])

  const enabled = fogConfig?.enabled ?? DEFAULT_FOG_CONFIG.enabled
  if (!enabled) return null

  return <fog attach="fog" args={[color, near, far]} />
}

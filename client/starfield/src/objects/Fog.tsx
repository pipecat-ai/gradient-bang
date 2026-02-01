import { useMemo } from "react"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"

import { getPalette } from "@/colors"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"

// Default fog config values
const DEFAULT_FOG_CONFIG = {
  enabled: true,
  base: "#000000",
  near: 0,
  far: 80,
}

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = ["enabled", "near", "far"] as const

export const Fog = () => {
  const showControls = useShowControls()
  const { fog: fogConfig, palette: paletteKey } = useGameStore(
    (state) => state.starfieldConfig
  )
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            "Scene Settings": folder({
              Fog: folder(
                {
                  enabled: {
                    value: fogConfig?.enabled ?? DEFAULT_FOG_CONFIG.enabled,
                    label: "Enable Fog",
                  },
                  base: {
                    value: `#${palette.base.getHexString()}`,
                    label: "Color",
                  },
                  near: {
                    value: fogConfig?.near ?? DEFAULT_FOG_CONFIG.near,
                    min: 0,
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

  // Get stable config - hook handles all stabilization and palette colors
  const controls = useControlSync({
    source: fogConfig as Partial<typeof DEFAULT_FOG_CONFIG> | undefined,
    defaults: DEFAULT_FOG_CONFIG,
    palette,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_FOG_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_FOG_CONFIG>) => void,
  })

  if (!controls.enabled) return null

  return <fog attach="fog" args={[controls.base, controls.near, controls.far]} />
}

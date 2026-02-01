import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import {
  AdditiveBlending,
  MultiplyBlending,
  NormalBlending,
  SubtractiveBlending,
  type Blending,
} from "three"

import { Stars as StarsComponent } from "@/components/Stars"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"

const BLENDING_MODES: Record<string, Blending> = {
  Normal: NormalBlending,
  Additive: AdditiveBlending,
  Subtractive: SubtractiveBlending,
  Multiply: MultiplyBlending,
}

// Default stars config values
const DEFAULT_STARS_CONFIG = {
  enabled: true,
  radius: 1,
  depth: 30,
  count: 6000,
  size: 0.8,
  fade: true,
  blendingMode: "Normal",
  opacityMin: 0.05,
  opacityMax: 0.5,
}

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = [
  "enabled",
  "radius",
  "depth",
  "count",
  "size",
] as const

export const Stars = () => {
  const showControls = useShowControls()
  const { stars: starsConfig } = useGameStore((state) => state.starfieldConfig)

  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                Stars: folder(
                  {
                    enabled: {
                      value:
                        starsConfig?.enabled ?? DEFAULT_STARS_CONFIG.enabled,
                      label: "Enable Stars",
                    },
                    radius: {
                      value: starsConfig?.radius ?? DEFAULT_STARS_CONFIG.radius,
                      min: 1,
                      max: 100,
                      step: 1,
                      label: "Radius",
                    },
                    depth: {
                      value: starsConfig?.depth ?? DEFAULT_STARS_CONFIG.depth,
                      min: 1,
                      max: 100,
                      step: 1,
                      label: "Depth",
                    },
                    count: {
                      value: starsConfig?.count ?? DEFAULT_STARS_CONFIG.count,
                      min: 1000,
                      max: 10000,
                      step: 100,
                      label: "Count",
                    },
                    size: {
                      value: starsConfig?.size ?? DEFAULT_STARS_CONFIG.size,
                      min: 0.1,
                      max: 20,
                      step: 0.1,
                      label: "Size",
                    },
                    fade: {
                      value: DEFAULT_STARS_CONFIG.fade,
                      label: "Fade",
                    },
                    blendingMode: {
                      value: DEFAULT_STARS_CONFIG.blendingMode,
                      options: Object.keys(BLENDING_MODES),
                      label: "Blending Mode",
                    },
                    opacityMin: {
                      value: DEFAULT_STARS_CONFIG.opacityMin,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      label: "Opacity Min",
                    },
                    opacityMax: {
                      value: DEFAULT_STARS_CONFIG.opacityMax,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      label: "Opacity Max",
                    },
                  },
                  { collapsed: true }
                ),
              },
              { collapsed: true, order: PANEL_ORDERING.RENDERING }
            ),
          }
        : {}) as Schema
  )

  // Get stable config - hook handles all stabilization
  const controls = useControlSync({
    source: starsConfig as Partial<typeof DEFAULT_STARS_CONFIG> | undefined,
    defaults: DEFAULT_STARS_CONFIG,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_STARS_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_STARS_CONFIG>) => void,
  })

  if (!controls.enabled) return null

  return (
    <StarsComponent
      radius={controls.radius}
      depth={controls.depth}
      count={controls.count}
      fade={controls.fade}
      size={controls.size}
      layers={LAYERS.BACKGROUND}
      blending={BLENDING_MODES[controls.blendingMode]}
      opacityRange={[controls.opacityMin, controls.opacityMax]}
    />
  )
}

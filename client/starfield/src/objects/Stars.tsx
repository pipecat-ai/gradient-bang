import { useControls } from "leva"
import {
  AdditiveBlending,
  MultiplyBlending,
  NormalBlending,
  SubtractiveBlending,
  type Blending,
} from "three"

import { Stars as StarsComponent } from "@/components/Stars"
import { LAYERS } from "@/constants"
import { useGameStore } from "@/useGameStore"

const BLENDING_MODES: Record<string, Blending> = {
  Normal: NormalBlending,
  Additive: AdditiveBlending,
  Subtractive: SubtractiveBlending,
  Multiply: MultiplyBlending,
}

export const Stars = () => {
  const { stars: starsConfig } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  const {
    radius,
    depth,
    count,
    factor,
    saturation,
    fade,
    speed,
    size,
    blendingMode,
    opacityMin,
    opacityMax,
  } = useControls(
    "Stars",
    {
      enabled: {
        value: starsConfig?.enabled ?? true,
        onChange: (value: boolean) => {
          setStarfieldConfig({ stars: { enabled: value } })
        },
      },
      radius: {
        value: starsConfig?.radius ?? 20,
        min: 1,
        max: 100,
        step: 1,
        label: "Radius",
      },
      depth: {
        value: starsConfig?.depth ?? 40,
        min: 1,
        max: 100,
        step: 1,
        label: "Depth",
      },
      count: {
        value: starsConfig?.count ?? 3000,
        min: 1000,
        max: 10000,
        step: 100,
        label: "Count",
      },
      factor: {
        value: starsConfig?.factor ?? 4,
        min: 1,
        max: 10,
        step: 1,
        label: "Factor",
      },
      size: {
        value: starsConfig?.size ?? 1.7,
        min: 0.1,
        max: 20,
        step: 0.1,
        label: "Size",
      },
      saturation: {
        value: starsConfig?.saturation ?? 0,
        min: 0,
        max: 1,
        step: 0.01,
        label: "Saturation",
      },
      fade: {
        value: true,
        label: "Fade",
      },
      speed: {
        value: 0,
        min: 0,
        max: 1,
        step: 0.01,
        label: "Speed",
      },
      blendingMode: {
        value: "Normal",
        options: Object.keys(BLENDING_MODES),
        label: "Blending Mode",
      },
      opacityMin: {
        value: 0.2,
        min: 0,
        max: 1,
        step: 0.01,
        label: "Opacity Min",
      },
      opacityMax: {
        value: 0.6,
        min: 0,
        max: 1,
        step: 0.01,
        label: "Opacity Max",
      },
    },
    {
      collapsed: true,
    }
  )

  return (
    starsConfig?.enabled && (
      <StarsComponent
        radius={radius}
        depth={depth}
        count={count}
        factor={factor}
        saturation={saturation}
        fade={fade}
        speed={speed}
        size={size}
        layers={LAYERS.BACKGROUND}
        blending={BLENDING_MODES[blendingMode]}
        opacityRange={[opacityMin, opacityMax]}
      />
    )
  )
}

import { useControls } from "leva"

import { Stars as StarsComponent } from "@/components/Stars"
import { LAYERS } from "@/Starfield"
import { useGameStore } from "@/useGameStore"

export const Stars = () => {
  const { stars: starsConfig } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  const { radius, depth, count, factor, saturation, fade, speed, size } =
    useControls(
      "Stars",
      {
        enabled: {
          value: starsConfig?.enabled ?? true,
          onChange: (value: boolean) => {
            setStarfieldConfig({ stars: { enabled: value } })
          },
        },
        radius: {
          value: 30,
          min: 1,
          max: 100,
          step: 1,
          label: "Radius",
        },
        depth: {
          value: 50,
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
          value: 4,
          min: 1,
          max: 10,
          step: 1,
          label: "Factor",
        },
        size: {
          value: 4,
          min: 0.1,
          max: 20,
          step: 0.1,
          label: "Size",
        },
        saturation: {
          value: 0,
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
      />
    )
  )
}

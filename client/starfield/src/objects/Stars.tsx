import { Stars as StarsDrei } from "@react-three/drei"
import { folder, useControls } from "leva"

import { useGameStore } from "@/useGameStore"

export const Stars = () => {
  const { stars: starsConfig } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  const [{ radius, depth, count, factor, saturation, fade, speed }] =
    useControls(() => ({
      Stars: folder(
        {
          enabled: {
            value: starsConfig?.enabled ?? true,
            onChange: (value: boolean) => {
              setStarfieldConfig({ stars: { enabled: value } })
            },
          },
          radius: {
            value: 10,
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
            value: 5000,
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
      ),
    }))

  return (
    starsConfig?.enabled && (
      <StarsDrei
        radius={radius}
        depth={depth}
        count={count}
        factor={factor}
        saturation={saturation}
        fade={fade}
        speed={speed}
      />
    )
  )
}

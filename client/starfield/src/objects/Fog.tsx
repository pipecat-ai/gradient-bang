import { folder, useControls } from "leva"

import { useGameStore } from "@/useGameStore"

export const Fog = () => {
  const { fog: fogConfig } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  const [{ color, near, far }] = useControls(() => ({
    "Scene Settings": folder({
      Fog: folder(
        {
          enabled: {
            value: fogConfig?.enabled ?? true,
            onChange: (value: boolean) => {
              setStarfieldConfig({ fog: { enabled: value } })
            },
          },
          color: {
            value: fogConfig?.color ?? "#000000",
          },
          near: {
            value: fogConfig?.near ?? 0,
            min: 1,
            max: 100,
            step: 1,
            label: "Near",
          },
          far: {
            value: fogConfig?.far ?? 80,
            min: 1,
            max: 100,
            step: 1,
            label: "Far",
          },
        },
        { collapsed: true }
      ),
    }),
  }))

  if (!fogConfig?.enabled) return null

  return <fog attach="fog" args={[color, near, far]} />
}

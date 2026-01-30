import { Html } from "@react-three/drei"

import { useIsTargeted } from "@/hooks/useIsTargeted"

interface GameObjectLabelProps {
  label: string
  position: [number, number, number]
  opacity?: number
  color?: string
  offsetY?: number
  targetThreshold?: number // Angle in degrees
}

export const GameObjectLabel = ({
  label,
  position,
  opacity = 1,
  color = "#00ff41",
  offsetY = 1.5,
  targetThreshold = 8,
}: GameObjectLabelProps) => {
  const isTargeted = useIsTargeted(position, targetThreshold)

  return (
    <Html
      position={[0, offsetY, 0]}
      center
      sprite
      distanceFactor={10}
      style={{
        color,
        opacity: isTargeted ? opacity : 0,
        fontSize: "12px",
        fontFamily: "monospace",
        fontWeight: "bold",
        textShadow: `0 0 4px ${color}, 0 0 8px ${color}`,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        userSelect: "none",
        transition: "opacity 0.2s ease-out",
        textTransform: "uppercase",
        letterSpacing: "1px",
      }}
    >
      {label}
    </Html>
  )
}

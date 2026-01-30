import { useRef } from "react"
import * as THREE from "three"

import { LAYERS } from "@/constants"
import type { PositionedGameObject } from "@/types"

// Predefined color options
const COLORS = {
  terminal: "#00ff41", // Classic terminal green
  amber: "#ffb000", // Amber monitor
  cyan: "#00ffff", // Cyber cyan
  red: "#ff3333", // Alert red
  white: "#ffffff", // Pure white
  blue: "#4a90e2", // Soft blue
} as const

export type PortColor = keyof typeof COLORS | string

export interface PortProps extends PositionedGameObject {
  color?: PortColor
  rotationSpeed?: number
}

export const Port = ({
  id,
  position,
  scale = 1,
  color = "terminal",
  opacity = 1,
  enabled = true,
}: PortProps) => {
  const meshRef = useRef<THREE.Mesh>(null)

  // Resolve color - use predefined or custom hex
  const resolvedColor =
    color in COLORS ? COLORS[color as keyof typeof COLORS] : color

  if (!enabled) return null

  return (
    <mesh
      ref={meshRef}
      name={id}
      position={position}
      scale={scale}
      layers={LAYERS.GAMEOBJECTS}
    >
      <octahedronGeometry args={[1, 0]} />
      <meshBasicMaterial
        color={resolvedColor}
        wireframe
        transparent={opacity < 1}
        opacity={opacity}
      />
    </mesh>
  )
}

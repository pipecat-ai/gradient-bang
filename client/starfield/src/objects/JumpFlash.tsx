import { memo, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import { useJumpFlashAnimation } from "@/animations/useJumpFlashAnimation"
import { LAYERS } from "@/constants"

export interface JumpFlashProps {
  position: [number, number, number]
  /** Base size of the flash. Default: 0.5 */
  scale?: number
  /** Flash color. Default: white */
  color?: string
  /** Animation duration in ms. Default: 400 */
  duration?: number
  /** Delay before animation starts in ms. Default: 0 */
  delay?: number
  /** Called when the flash animation finishes — parent should unmount */
  onComplete?: () => void
}

/**
 * A one-shot star-like flash effect. Renders a small burst of light
 * at the given position that scales up and fades out, then fires
 * `onComplete` so the parent can unmount it.
 *
 * Not a game object — managed independently by the caller.
 *
 * @example
 * {showFlash && (
 *   <JumpFlash
 *     position={[10, 5, -30]}
 *     onComplete={() => setShowFlash(false)}
 *   />
 * )}
 */
export const JumpFlash = memo(function JumpFlash({
  position,
  scale = 3,
  color = "#ffffff",
  duration = 400,
  delay = 0,
  onComplete,
}: JumpFlashProps) {
  const meshRef = useRef<THREE.Mesh>(null)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)

  const getProgress = useJumpFlashAnimation({
    duration,
    delay,
    onComplete,
  })

  useFrame(() => {
    const p = getProgress()
    if (p === null) return

    // Scale: burst outward from small to full size
    if (meshRef.current) {
      const s = scale * (0.2 + 0.8 * p)
      meshRef.current.scale.setScalar(s)
    }

    // Opacity: bell-curve envelope — peaks early then fades to 0
    if (materialRef.current) {
      materialRef.current.opacity = Math.sin(p * Math.PI)
    }
  })

  return (
    <mesh
      ref={meshRef}
      position={position}
      scale={0}
      layers={LAYERS.GAMEOBJECTS}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        ref={materialRef}
        color={color}
        transparent
        opacity={0}
        depthTest={false}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
})

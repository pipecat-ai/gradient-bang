import { memo, useCallback, useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import { LAYERS } from "@/constants"
import { useGameStore } from "@/useGameStore"

import { JumpFlash } from "./JumpFlash"
import { useGameObjectFade } from "./useGameObjectFade"

export interface ShipProps {
  id: string
  position: [number, number, number]
  scale?: number
  opacity?: number
  initial?: boolean
}

export const Ship = memo(function Ship({
  id,
  position,
  scale = 0.5,
  opacity = 0.8,
  initial = false,
}: ShipProps) {
  const setLookAtTarget = useGameStore((state) => state.setLookAtTarget)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)
  const fadeRef = useGameObjectFade()
  const [showFlash, setShowFlash] = useState(!initial)

  // Enable both layer 0 (raycasting) and GAMEOBJECTS layer (rendering)
  const meshRef = useCallback((mesh: THREE.Mesh | null) => {
    if (mesh) {
      mesh.layers.enable(0)
      mesh.layers.enable(LAYERS.GAMEOBJECTS)
    }
  }, [])

  useFrame(() => {
    if (materialRef.current) {
      materialRef.current.opacity = opacity * fadeRef.current
    }
  })

  return (
    <>
      {showFlash && (
        <JumpFlash
          position={position}
          onComplete={() => setShowFlash(false)}
        />
      )}
      <mesh
        ref={meshRef}
        position={position}
        scale={scale}
        onClick={() => setLookAtTarget(id)}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial
          ref={materialRef}
          color="#ffffff"
          wireframe
          transparent
          opacity={0}
          depthTest={false}
        />
      </mesh>
    </>
  )
}, shipPropsAreEqual)

function shipPropsAreEqual(prev: ShipProps, next: ShipProps): boolean {
  return (
    prev.id === next.id &&
    prev.position[0] === next.position[0] &&
    prev.position[1] === next.position[1] &&
    prev.position[2] === next.position[2] &&
    prev.scale === next.scale &&
    prev.opacity === next.opacity &&
    prev.initial === next.initial
  )
}

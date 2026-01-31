import { Suspense, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { LAYERS } from "@/constants"
import { useGameStore } from "@/useGameStore"

import { Port } from "./Port"

interface SelectionIndicatorProps {
  position: [number, number, number]
  scale?: number
}

const SelectionIndicator = ({
  position,
  scale = 1,
}: SelectionIndicatorProps) => {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()

  // Always face the camera
  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.lookAt(camera.position)
    }
  })

  // Size the indicator based on the object scale
  const size = scale * 2.5

  return (
    <group ref={groupRef} position={position}>
      <mesh layers={LAYERS.GAMEOBJECTS}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          color="#ffffff"
          wireframe
          transparent
          opacity={0.8}
          side={THREE.DoubleSide}
          depthTest={false}
        />
      </mesh>
    </group>
  )
}

export const GameObjects = () => {
  const positionedGameObjects = useGameStore(
    (state) => state.positionedGameObjects
  )
  const lookAtTarget = useGameStore((state) => state.lookAtTarget)

  // Find the targeted object
  const targetedObject = lookAtTarget
    ? positionedGameObjects.find((obj) => obj.id === lookAtTarget)
    : null

  return (
    <group name="game-objects">
      {positionedGameObjects.map((obj) => {
        switch (obj.type) {
          case "port":
            return (
              <Suspense key={obj.id} fallback={null}>
                <Port {...obj} />
              </Suspense>
            )
          // TODO: Add other object types as they're implemented
          // case "ship":
          //   return <Ship key={obj.id} {...obj} />
          // case "garrison":
          //   return <Garrison key={obj.id} {...obj} />
          // case "salvage":
          //   return <Salvage key={obj.id} {...obj} />
          default:
            return null
        }
      })}

      {/* Selection indicator for targeted object */}
      {targetedObject && (
        <SelectionIndicator
          position={targetedObject.position}
          scale={targetedObject.scale}
        />
      )}
    </group>
  )
}

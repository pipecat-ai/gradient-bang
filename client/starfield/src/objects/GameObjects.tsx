import { memo } from "react"

import { useGameStore } from "@/useGameStore"

import { BaseGameObject } from "./BaseGameObject"
import { Label } from "./Label"
import { Port } from "./Port"
import { Ship } from "./Ship"
import { useObjectsInFrustum } from "./useInFrustum"

/*
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { LAYERS } from "@/constants"
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
*/
export const GameObjects = memo(function GameObjects() {
  const positionedGameObjects = useGameStore(
    (state) => state.positionedGameObjects
  )

  // IDs of game objects currently within the inner frustum bounds
  const inFrustumIds = useObjectsInFrustum(positionedGameObjects)

  if (!positionedGameObjects.length) {
    return null
  }

  return (
    <group name="game-objects">
      {positionedGameObjects.map((obj) => {
        switch (obj.type) {
          case "port":
            return (
              <BaseGameObject key={obj.id} {...obj} fadeIn={!obj.initial}>
                <Port {...obj} />
              </BaseGameObject>
            )
          case "ship":
            return (
              <BaseGameObject key={obj.id} {...obj} fadeIn={!obj.initial}>
                <Ship {...obj} />
              </BaseGameObject>
            )
          // case "garrison":
          //   return <Garrison key={obj.id} {...obj} />
          // case "salvage":
          //   return <Salvage key={obj.id} {...obj} />
          default:
            return null
        }
      })}

      {/* Labels for game objects in the inner frustum */}
      {positionedGameObjects
        .filter((obj) => inFrustumIds.has(obj.id) && obj.label)
        .map((obj) => (
          <Label key={`label-${obj.id}`} {...obj} />
        ))}
    </group>
  )
})

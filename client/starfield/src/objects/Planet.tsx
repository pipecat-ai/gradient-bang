import { useRef } from "react"
import { Billboard } from "@react-three/drei"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

export const Planet = () => {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.set(
        camera.position.x,
        camera.position.y,
        camera.position.z - 100
      )
    }
  })

  return (
    <group ref={groupRef}>
      <Billboard follow={false} lockX={true} lockY={true} lockZ={true}>
        <mesh renderOrder={0}>
          <planeGeometry args={[10, 10]} />
          <meshBasicMaterial
            color="red"
            side={THREE.DoubleSide}
            fog={false}
            depthTest={true}
            depthWrite={true}
            transparent={true}
          />
        </mesh>
      </Billboard>
    </group>
  )
}

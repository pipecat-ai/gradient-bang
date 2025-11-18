import { useEffect, useRef } from "react"
import { invalidate, useFrame, useLoader, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useGameStore } from "@/useGameStore"

export const Planet = () => {
  const groupRef = useRef<THREE.Group>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const { planet: planetConfig } = useGameStore(
    (state) => state.starfieldConfig
  )
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  const [{ scale, opacity, position, imageIndex }] = useControls(() => ({
    Planet: folder(
      {
        enabled: {
          value: planetConfig?.enabled ?? true,
          onChange: (value: boolean) => {
            setStarfieldConfig({ planet: { enabled: value } })
          },
        },
        imageIndex: {
          value: planetConfig?.imageIndex ?? 1,
          min: 1,
          max: 9,
          step: 1,
          label: "Skybox Image",
        },
        scale: {
          value: planetConfig?.scale ?? 50,
          min: 10,
          max: 1000,
          step: 1,
        },
        opacity: {
          value: planetConfig?.opacity ?? 1,
          min: 0,
          max: 1,
          step: 0.01,
        },
        position: {
          value: planetConfig?.position ?? { x: 0, y: 0 },
          step: 1,
        },
      },
      { collapsed: true }
    ),
  }))

  // Load the texture
  const texture = useLoader(
    THREE.TextureLoader,
    `/images/skybox-${imageIndex}.png`
  )

  // Calculate dimensions based on texture aspect ratio
  const aspectRatio = texture.image.width / texture.image.height
  const width = scale * aspectRatio
  const height = scale

  useFrame(() => {
    if (groupRef.current && meshRef.current) {
      // Position the group relative to camera with offset
      groupRef.current.position.set(
        camera.position.x + position.x,
        camera.position.y + position.y,
        camera.position.z - 100
      )

      // Make the mesh look at the camera to face toward center
      meshRef.current.lookAt(camera.position)
    }
  })

  useEffect(() => {
    invalidate()
  }, [position, scale, opacity, imageIndex])

  if (!planetConfig?.enabled) return null

  return (
    <group ref={groupRef} frustumCulled={false}>
      <mesh ref={meshRef} renderOrder={0}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={texture}
          opacity={opacity}
          side={THREE.DoubleSide}
          fog={false}
          depthTest={true}
          depthWrite={true}
          transparent={true}
          // blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

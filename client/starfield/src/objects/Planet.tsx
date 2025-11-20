import { useEffect, useMemo, useRef } from "react"
import { useTexture } from "@react-three/drei"
import { invalidate, useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import SkyBox1 from "@/assets/skybox-1.png"
import { getPalette } from "@/colors"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import { LAYERS } from "@/Starfield"
import { useGameStore } from "@/useGameStore"

export const Planet = () => {
  const groupRef = useRef<THREE.Group>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const shadowMeshRef = useRef<THREE.Mesh>(null)
  const depthMeshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { planet: planetConfig } = starfieldConfig
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const planetTexture = useTexture(SkyBox1)

  // Get active palette
  const palette = getPalette(starfieldConfig.palette)

  const [
    {
      scale,
      opacity,
      position,
      imageIndex,
      tintColor,
      tintIntensity,
      shadowEnabled,
      shadowRadius,
      shadowOpacity,
      shadowFalloff,
      shadowColor,
    },
  ] = useControls(() => ({
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
        tintColor: {
          value: planetConfig?.tintColor ?? `#${palette.c1.getHexString()}`,
          label: "Tint Color",
        },
        tintIntensity: {
          value: planetConfig?.tintIntensity ?? 2.5,
          min: 0,
          max: 10,
          step: 0.1,
          label: "Tint Intensity",
        },
        shadowEnabled: {
          value: planetConfig?.shadowEnabled ?? true,
          label: "Shadow Enabled",
        },
        shadowRadius: {
          value: planetConfig?.shadowRadius ?? 0.6,
          min: 0.1,
          max: 1.0,
          step: 0.1,
          label: "Shadow Radius",
        },
        shadowOpacity: {
          value: planetConfig?.shadowOpacity ?? 0.7,
          min: 0,
          max: 1,
          step: 0.01,
          label: "Shadow Opacity",
        },
        shadowFalloff: {
          value: planetConfig?.shadowFalloff ?? 0.5,
          min: 0.0,
          max: 1.0,
          step: 0.1,
          label: "Shadow Falloff",
        },
        shadowColor: {
          value: planetConfig?.shadowColor ?? `#${palette.base.getHexString()}`,
          label: "Shadow Color",
        },
      },
      { collapsed: true }
    ),
  }))

  // Boosted tint color for vibrant effect with additive blending
  const boostedTintColor = useMemo(() => {
    const color = new THREE.Color(tintColor)
    return color.multiplyScalar(tintIntensity)
  }, [tintColor, tintIntensity])

  // Shadow material
  const shadowMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: shadowVertexShader,
      fragmentShader: shadowFragmentShader,
      uniforms: {
        uRadius: { value: shadowRadius },
        uOpacity: { value: shadowOpacity },
        uFalloff: { value: shadowFalloff },
        uColor: { value: new THREE.Color(shadowColor) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  }, [shadowFalloff, shadowOpacity, shadowRadius, shadowColor])

  // Calculate dimensions based on texture aspect ratio
  const aspectRatio = planetTexture.width / planetTexture.height
  const width = scale * aspectRatio
  const height = scale

  // Set layers on depth mesh to make it visible to both layers
  useEffect(() => {
    if (depthMeshRef.current) {
      depthMeshRef.current.layers.set(LAYERS.SKYBOX)
      depthMeshRef.current.layers.enable(LAYERS.BACKGROUND)
    }
  }, [])

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

      // Sync depth mesh rotation
      if (depthMeshRef.current) {
        depthMeshRef.current.quaternion.copy(meshRef.current.quaternion)
      }

      if (shadowEnabled && shadowMeshRef.current) {
        shadowMeshRef.current.lookAt(camera.position)
      }
    }
  })

  useEffect(() => {
    invalidate()
  }, [position, scale, opacity, imageIndex, tintColor, tintIntensity])

  if (!planetConfig?.enabled) return null

  return (
    <group ref={groupRef} frustumCulled={false}>
      {/* Depth-writing occluder mesh to occlude stars behind planet */}
      <mesh ref={depthMeshRef} renderOrder={-50}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color={0x000000}
          transparent={false}
          opacity={1}
          depthTest={false}
          depthWrite={true}
          visible={false}
        />
      </mesh>

      {/* Shadow mesh - rendered behind planet */}
      {shadowEnabled && (
        <mesh
          ref={shadowMeshRef}
          renderOrder={0}
          layers={[LAYERS.SKYBOX]}
          position={[0, 0, -0.1]}
        >
          <planeGeometry args={[width * 3, width * 3]} />
          <primitive object={shadowMaterial} attach="material" />
        </mesh>
      )}
      {/* Planet mesh */}
      <mesh ref={meshRef} renderOrder={1} layers={[LAYERS.SKYBOX]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          map={planetTexture}
          color={boostedTintColor}
          opacity={opacity}
          side={THREE.DoubleSide}
          fog={false}
          depthTest={true}
          depthWrite={false}
          transparent={true}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

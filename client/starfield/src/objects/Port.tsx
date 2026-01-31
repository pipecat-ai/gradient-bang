import { useEffect, useMemo, useRef } from "react"
import { useFrame, useLoader, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import type { PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"

const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax18ncAAAAASUVORK5CYII="

export interface PortProps extends PositionedGameObject {
  rotationSpeed?: number
  // Image rendering props (from Structure)
  imageUrl?: string
  tintColor?: string
  tintIntensity?: number
  // Shadow props
  shadowEnabled?: boolean
  shadowRadius?: number
  shadowOpacity?: number
  shadowFalloff?: number
  shadowColor?: string
  // Billboard mode - face camera like Structure did
  billboard?: boolean
  // Camera offset position (only used in billboard mode)
  cameraOffset?: { x: number; y: number }
}

export const Port = ({
  id,
  position,
  scale = 4,
  opacity = 0.7,
  enabled = true,
  // Image props - if not provided, picks random from imageAssets
  imageUrl,
  tintColor,
  tintIntensity = 0.7,
  // Shadow props
  shadowEnabled = true,
  shadowRadius = 1,
  shadowOpacity = 0.3,
  shadowFalloff = 1,
  shadowColor,
  // Billboard mode
  billboard = false,
  cameraOffset,
}: PortProps) => {
  const meshRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()

  // Get palette and image assets from store (separate selectors to avoid infinite loop)
  const paletteKey = useGameStore((state) => state.starfieldConfig.palette)
  const imageAssets = useGameStore((state) => state.starfieldConfig.imageAssets)
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  // Get port assets and pick a stable random one for this instance
  const portAssets = useMemo(
    () => imageAssets?.filter((asset) => asset.type === "port") ?? [],
    [imageAssets]
  )

  // Pick a random port asset once per instance (stable via useRef)
  const randomIndexRef = useRef<number | null>(null)
  if (randomIndexRef.current === null && portAssets.length > 0) {
    randomIndexRef.current = Math.floor(Math.random() * portAssets.length)
  }

  // Resolve final image URL: explicit prop > random from assets > fallback
  const resolvedImageUrl = useMemo(() => {
    if (imageUrl) return imageUrl
    if (portAssets.length > 0 && randomIndexRef.current !== null) {
      return portAssets[randomIndexRef.current]?.url
    }
    return undefined
  }, [imageUrl, portAssets])

  // Load texture if we have an image URL
  const textureUrl = resolvedImageUrl || TRANSPARENT_PIXEL
  const hasTexture = Boolean(resolvedImageUrl)
  const texture = useLoader(THREE.TextureLoader, textureUrl)

  // Boosted tint color - use palette tint as default
  const boostedTintColor = useMemo(() => {
    const clr = tintColor ? new THREE.Color(tintColor) : palette.tint.clone()
    return clr.multiplyScalar(tintIntensity)
  }, [tintColor, tintIntensity, palette.tint])

  // Resolved shadow color - use palette base as default
  const resolvedShadowColor = useMemo(() => {
    return shadowColor ? new THREE.Color(shadowColor) : palette.base.clone()
  }, [shadowColor, palette.base])

  // Shadow material ref for dynamic opacity updates in useFrame
  const shadowMaterialRef = useRef<THREE.ShaderMaterial>(null!)

  // Shadow material - create once to avoid shader recompilation
  const shadowMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shadowVertexShader,
        fragmentShader: shadowFragmentShader,
        uniforms: {
          uRadius: { value: shadowRadius },
          uOpacity: { value: shadowOpacity },
          uFalloff: { value: shadowFalloff },
          uColor: { value: resolvedShadowColor.clone() },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // Intentionally empty - create once per Port instance
  )

  // Sync shadow uniforms if props change (opacity is handled dynamically in useFrame)
  useEffect(() => {
    shadowMaterial.uniforms.uRadius.value = shadowRadius
    shadowMaterial.uniforms.uFalloff.value = shadowFalloff
    shadowMaterial.uniforms.uColor.value.copy(resolvedShadowColor)
  }, [shadowMaterial, shadowRadius, shadowFalloff, resolvedShadowColor])

  // Calculate dimensions based on texture aspect ratio
  const { width, height } = useMemo(() => {
    if (!hasTexture || !texture.image) {
      return { width: scale, height: scale }
    }
    const aspectRatio = texture.image.width / texture.image.height
    return {
      width: scale * aspectRatio,
      height: scale,
    }
  }, [texture, hasTexture, scale])

  // Image mode: always face camera, optionally follow camera position (billboard)
  // Also update shadow opacity based on distance to camera
  useFrame(() => {
    if (!groupRef.current || !hasTexture) return

    if (billboard) {
      // Billboard mode: follow camera with offset
      const offsetX = cameraOffset?.x ?? 0
      const offsetY = cameraOffset?.y ?? 0
      groupRef.current.position.set(
        camera.position.x + offsetX,
        camera.position.y + offsetY,
        camera.position.z - 100
      )
    }

    // Always face the camera when in image mode
    groupRef.current.lookAt(camera.position)

    // Update shadow opacity based on distance to camera
    if (shadowEnabled && shadowMaterialRef.current) {
      const distance = groupRef.current.position.distanceTo(camera.position)
      // Scale opacity: closer = base opacity, further = max opacity
      // Distance range: 8-15 units maps to shadowOpacity-maxOpacity
      const minDistance = 8
      const maxDistance = 15
      const maxOpacity = 0.85
      const distanceFactor = Math.min(
        Math.max((distance - minDistance) / (maxDistance - minDistance), 0),
        1
      )
      const dynamicOpacity =
        shadowOpacity + (maxOpacity - shadowOpacity) * distanceFactor
      shadowMaterialRef.current.uniforms.uOpacity.value = dynamicOpacity
    }
  })

  if (!enabled) return null

  // Render image mode (when imageUrl is provided)
  if (hasTexture) {
    return (
      <group
        ref={groupRef}
        position={billboard ? undefined : position}
        frustumCulled={false}
      >
        {/* Shadow mesh - rendered behind */}
        {shadowEnabled && (
          <mesh
            renderOrder={0}
            layers={[LAYERS.BACKGROUND]}
            position={[0, 0, -0.1]}
          >
            <planeGeometry args={[width * 3, width * 3]} />
            <primitive
              ref={shadowMaterialRef}
              object={shadowMaterial}
              attach="material"
            />
          </mesh>
        )}

        {/* Image mesh */}
        <mesh
          ref={meshRef}
          name={id}
          renderOrder={1}
          layers={LAYERS.GAMEOBJECTS}
        >
          <planeGeometry args={[width, height]} />
          <meshBasicMaterial
            map={texture}
            color={boostedTintColor}
            opacity={opacity}
            side={THREE.DoubleSide}
            fog={true}
            depthTest={true}
            depthWrite={false}
            transparent={true}
            blending={THREE.NormalBlending}
          />
        </mesh>
      </group>
    )
  }

  // Default wireframe octahedron mode (fallback when no image)
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
        color={palette.tint}
        wireframe
        transparent={opacity < 1}
        opacity={opacity}
      />
    </mesh>
  )
}

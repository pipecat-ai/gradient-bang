import { useEffect, useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { useGameObjectAnimation } from "@/animations/gameObjectFadeAnim"
import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import type { PositionedGameObject } from "@/types"
import { useGameStore } from "@/useGameStore"
import { useTextureCache } from "@/utils/textureCache"

const SHADOW_MIN_DISTANCE = 8
const SHADOW_MAX_DISTANCE = 15
const SHADOW_MAX_OPACITY = 0.9

export interface PortProps extends PositionedGameObject {
  rotationSpeed?: number
  // Image rendering props
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
  // Fade-in animation
  fadeIn?: boolean
  fadeInDuration?: number
  fadeInDelay?: number
}

export const Port = ({
  id,
  position,
  scale = 2,
  opacity = 0.8,
  enabled = true,
  // Image props
  imageUrl,
  tintColor,
  tintIntensity = 0.7,
  // Shadow props
  shadowEnabled = true,
  shadowRadius = 1,
  shadowOpacity = 0.6,
  shadowFalloff = 1,
  shadowColor,
  // Billboard mode
  billboard = false,
  cameraOffset,
  // Fade-in animation
  fadeIn = true,
  fadeInDuration = 2000,
  fadeInDelay = 300,
}: PortProps) => {
  const meshRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const imageMaterialRef = useRef<THREE.MeshBasicMaterial>(null)
  const { camera } = useThree()

  // Fade-in animation
  const updateFade = useGameObjectAnimation({
    duration: fadeInDuration,
    delay: fadeInDelay,
    enabled: fadeIn,
  })

  // Get palette and image assets from store (separate selectors to avoid infinite loop)
  const paletteKey = useGameStore((state) => state.starfieldConfig.palette)
  const imageAssets = useGameStore((state) => state.starfieldConfig.imageAssets)
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  // Get port assets and pick a stable random one for this instance
  const portAssets = useMemo(
    () => imageAssets?.filter((asset) => asset.type === "port") ?? [],
    [imageAssets]
  )

  // Random values set once per instance (lazy init survives StrictMode)
  const [randomValues] = useState(() => ({
    index: Math.floor(Math.random() * 100), // Will be modulo'd by actual length
    rotation: (Math.random() - 0.5) * (Math.PI / 2),
  }))

  // Get actual index based on available assets
  const assetIndex =
    portAssets.length > 0 ? randomValues.index % portAssets.length : null

  // Resolve final image URL: explicit prop > random from assets > fallback
  const resolvedImageUrl = useMemo(() => {
    if (imageUrl) return imageUrl
    if (portAssets.length > 0 && assetIndex !== null) {
      return portAssets[assetIndex]?.url
    }
    return undefined
  }, [imageUrl, portAssets, assetIndex])

  // Subscribe to texture cache - will re-render when texture becomes available
  const textureMap = useTextureCache((state) => state.textures)

  // Get texture from cache (populated by AssetPreloader)
  const texture = resolvedImageUrl
    ? (textureMap.get(resolvedImageUrl) ?? null)
    : null
  const hasTexture = texture !== null

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
    if (!texture?.image) {
      return { width: scale, height: scale }
    }
    const aspectRatio =
      (texture.image as HTMLImageElement).width /
      (texture.image as HTMLImageElement).height
    return {
      width: scale * aspectRatio,
      height: scale,
    }
  }, [texture, scale])

  // Image mode: always face camera, optionally follow camera position (billboard)
  // Also update shadow opacity based on distance to camera and fade progress
  useFrame(() => {
    // Update and get fade progress (0 to 1)
    const fade = updateFade()

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

    // Apply random Z rotation to mesh after lookAt
    if (meshRef.current) {
      meshRef.current.rotation.z = randomValues.rotation
    }

    // Update image material opacity with fade
    if (imageMaterialRef.current) {
      imageMaterialRef.current.opacity = opacity * fade
    }

    // Update shadow opacity based on distance to camera and fade
    if (shadowEnabled && shadowMaterialRef.current) {
      const distance = groupRef.current.position.distanceTo(camera.position)
      // Scale opacity: closer = max opacity, further = base opacity
      // Distance range: 8-15 units maps to maxOpacity-shadowOpacity
      const distanceFactor = Math.min(
        Math.max(
          (distance - SHADOW_MIN_DISTANCE) /
            (SHADOW_MAX_DISTANCE - SHADOW_MIN_DISTANCE),
          0
        ),
        1
      )
      const dynamicOpacity =
        SHADOW_MAX_OPACITY -
        (SHADOW_MAX_OPACITY - shadowOpacity) * distanceFactor
      shadowMaterialRef.current.uniforms.uOpacity.value = dynamicOpacity * fade
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
        {/* Shadow mesh - rendered on top of planet background */}
        {shadowEnabled && (
          <mesh
            renderOrder={10}
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
          renderOrder={11}
          layers={LAYERS.GAMEOBJECTS}
        >
          <planeGeometry args={[width, height]} />
          <meshBasicMaterial
            ref={imageMaterialRef}
            map={texture}
            color={boostedTintColor}
            side={THREE.DoubleSide}
            fog={false}
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

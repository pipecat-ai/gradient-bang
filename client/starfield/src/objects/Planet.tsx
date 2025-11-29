import { useEffect, useMemo, useRef } from "react"
import { invalidate, useFrame, useLoader, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

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
  const { camera } = useThree()

  // Optimized zustand selectors - only subscribe to what we need
  const backgroundImages = useGameStore(
    (state) => state.starfieldConfig.backgroundImages
  )
  const planetConfig = useGameStore((state) => state.starfieldConfig.planet)
  const paletteKey = useGameStore((state) => state.starfieldConfig.palette)

  // Get active palette
  const palette = getPalette(paletteKey)

  // Create simple options object for leva select
  const imageOptions = useMemo(() => {
    const images = backgroundImages || []
    return images.reduce(
      (acc, imagePath) => {
        acc[imagePath] = imagePath
        return acc
      },
      {} as Record<string, string>
    )
  }, [backgroundImages])

  // Get the selected image path
  const selectedImagePath =
    backgroundImages && backgroundImages.length > 0
      ? backgroundImages[planetConfig?.imageIndex ?? 0] || backgroundImages[0]
      : "/skybox-1.png"

  const [
    {
      enabled,
      selectedImage,
      scale,
      opacity,
      position,
      tintColor,
      tintIntensity,
      shadowEnabled,
      shadowRadius,
      shadowOpacity,
      shadowFalloff,
      shadowColor,
    },
    set,
  ] = useControls(
    () => ({
      Planet: folder(
        {
          enabled: {
            value: planetConfig?.enabled ?? true,
          },
          selectedImage: {
            value: selectedImagePath,
            options: imageOptions,
            label: "Image",
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
            value: planetConfig?.tintColor ?? `#${palette.tint.getHexString()}`,
            label: "Tint Color",
          },
          tintIntensity: {
            value: planetConfig?.tintIntensity ?? 1.5,
            min: 0,
            max: 2,
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
            value: planetConfig?.shadowOpacity ?? 0.85,
            min: 0,
            max: 1,
            step: 0.01,
            label: "Shadow Opacity",
          },
          shadowFalloff: {
            value: planetConfig?.shadowFalloff ?? 0.8,
            min: 0.0,
            max: 1.0,
            step: 0.1,
            label: "Shadow Falloff",
          },
          shadowColor: {
            value:
              planetConfig?.shadowColor ?? `#${palette.base.getHexString()}`,
            label: "Shadow Color",
          },
        },
        { collapsed: true }
      ),
    }),
    [imageOptions, selectedImagePath]
  )

  // Memoize the texture URL to prevent unnecessary reloads
  const textureUrl = useMemo(() => {
    // Use selectedImage from controls if available, otherwise fall back to store value
    return selectedImage || selectedImagePath
  }, [selectedImage, selectedImagePath])

  // Load the texture using useLoader (only when textureUrl changes)
  const planetTexture = useLoader(THREE.TextureLoader, textureUrl)

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (!planetConfig?.tintColor && !planetConfig?.shadowColor) {
      set({
        tintColor: `#${palette.tint.getHexString()}`,
        shadowColor: `#${palette.base.getHexString()}`,
      })
    }
  }, [
    paletteKey,
    palette,
    planetConfig?.tintColor,
    planetConfig?.shadowColor,
    set,
  ])

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

  useFrame(() => {
    if (groupRef.current && meshRef.current) {
      groupRef.current.position.set(
        camera.position.x + position.x,
        camera.position.y + position.y,
        camera.position.z - 100
      )

      groupRef.current.lookAt(camera.position)
    }
  })

  useEffect(() => {
    invalidate()
  }, [position, scale, opacity, textureUrl, tintColor, tintIntensity])

  // Return null if no background images available or planet is disabled
  if (!backgroundImages || backgroundImages.length === 0) {
    return null
  }

  if (!enabled) return null

  return (
    <group ref={groupRef} frustumCulled={false}>
      {/* Shadow mesh - rendered behind planet */}
      {shadowEnabled && (
        <mesh
          renderOrder={0}
          layers={[LAYERS.BACKGROUND]}
          position={[0, 0, -0.1]}
        >
          <planeGeometry args={[width * 3, width * 3]} />
          <primitive object={shadowMaterial} attach="material" />
        </mesh>
      )}

      {/* Planet mesh */}
      <mesh ref={meshRef} renderOrder={1} layers={[LAYERS.BACKGROUND]}>
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

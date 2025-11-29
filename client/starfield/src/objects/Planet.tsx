import { useEffect, useMemo, useRef } from "react"
import { invalidate, useFrame, useLoader, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"
import { useShallow } from "zustand/react/shallow"

import { getPalette } from "@/colors"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import { LAYERS } from "@/types"
import { useGameStore } from "@/useGameStore"

const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax18ncAAAAASUVORK5CYII="

export const Planet = () => {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()

  const { imageAssets, planetConfig, paletteKey } = useGameStore(
    useShallow((state) => ({
      imageAssets: state.starfieldConfig.imageAssets,
      planetConfig: state.starfieldConfig.planet,
      paletteKey: state.starfieldConfig.palette,
    }))
  )
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  // Get active palette
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  const selectedImagePath = useMemo(() => {
    if (!imageAssets?.length) return undefined
    const index = planetConfig?.imageIndex ?? 0
    return imageAssets[index] ?? imageAssets[0]
  }, [imageAssets, planetConfig?.imageIndex])

  // Create simple options object for leva select
  const imageOptions = useMemo(() => {
    const images = imageAssets || []
    return images.reduce(
      (acc, imagePath) => {
        acc[imagePath] = imagePath
        return acc
      },
      {} as Record<string, string>
    )
  }, [imageAssets])

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
            onChange: (value: boolean) => {
              setStarfieldConfig({
                planet: { ...planetConfig, enabled: value },
              })
            },
            transient: false,
          },
          selectedImage: {
            value: selectedImagePath ?? "",
            options: imageOptions,
            label: "Image",
            onChange: (value: string) => {
              if (imageAssets && value) {
                const newIndex = imageAssets.indexOf(value)
                if (newIndex !== -1) {
                  setStarfieldConfig({
                    planet: { ...planetConfig, imageIndex: newIndex },
                  })
                }
              }
            },
            transient: false,
          },
          scale: {
            value: planetConfig?.scale ?? 50,
            min: 10,
            max: 1000,
            step: 1,
            onChange: (value: number) => {
              setStarfieldConfig({
                planet: { ...planetConfig, scale: value },
              })
            },
            transient: false,
          },
          opacity: {
            value: planetConfig?.opacity ?? 1,
            min: 0,
            max: 1,
            step: 0.01,
            onChange: (value: number) => {
              setStarfieldConfig({
                planet: { ...planetConfig, opacity: value },
              })
            },
            transient: false,
          },
          position: {
            value: planetConfig?.position ?? { x: 0, y: 0 },
            step: 1,
            onChange: (value: { x: number; y: number }) => {
              setStarfieldConfig({
                planet: { ...planetConfig, position: value },
              })
            },
            transient: false,
          },
          tintColor: {
            value: planetConfig?.tintColor ?? `#${palette.tint.getHexString()}`,
            label: "Tint Color",
            onChange: (value: string) => {
              setStarfieldConfig({
                planet: { ...planetConfig, tintColor: value },
              })
            },
            transient: false,
          },
          tintIntensity: {
            value: planetConfig?.tintIntensity ?? 1.5,
            min: 0,
            max: 2,
            step: 0.1,
            label: "Tint Intensity",
            onChange: (value: number) => {
              setStarfieldConfig({
                planet: { ...planetConfig, tintIntensity: value },
              })
            },
            transient: false,
          },
          shadowEnabled: {
            value: planetConfig?.shadowEnabled ?? true,
            label: "Shadow Enabled",
            onChange: (value: boolean) => {
              setStarfieldConfig({
                planet: { ...planetConfig, shadowEnabled: value },
              })
            },
            transient: false,
          },
          shadowRadius: {
            value: planetConfig?.shadowRadius ?? 0.6,
            min: 0.1,
            max: 1.0,
            step: 0.1,
            label: "Shadow Radius",
            onChange: (value: number) => {
              setStarfieldConfig({
                planet: { ...planetConfig, shadowRadius: value },
              })
            },
            transient: false,
          },
          shadowOpacity: {
            value: planetConfig?.shadowOpacity ?? 0.85,
            min: 0,
            max: 1,
            step: 0.01,
            label: "Shadow Opacity",
            onChange: (value: number) => {
              setStarfieldConfig({
                planet: { ...planetConfig, shadowOpacity: value },
              })
            },
            transient: false,
          },
          shadowFalloff: {
            value: planetConfig?.shadowFalloff ?? 0.8,
            min: 0.0,
            max: 1.0,
            step: 0.1,
            label: "Shadow Falloff",
            onChange: (value: number) => {
              setStarfieldConfig({
                planet: { ...planetConfig, shadowFalloff: value },
              })
            },
            transient: false,
          },
          shadowColor: {
            value:
              planetConfig?.shadowColor ?? `#${palette.base.getHexString()}`,
            label: "Shadow Color",
            onChange: (value: string) => {
              setStarfieldConfig({
                planet: { ...planetConfig, shadowColor: value },
              })
            },
            transient: false,
          },
        },
        { collapsed: true }
      ),
    }),
    [
      imageOptions,
      selectedImagePath,
      imageAssets,
      planetConfig,
      setStarfieldConfig,
      palette,
    ]
  )

  const { x: positionX, y: positionY } = position

  const resolvedTextureUrl = useMemo(() => {
    if (selectedImage) return selectedImage
    if (selectedImagePath) return selectedImagePath
    if (imageAssets?.length) return imageAssets[0]
    return null
  }, [imageAssets, selectedImage, selectedImagePath])

  const hasTexture = Boolean(resolvedTextureUrl)
  const textureUrl = resolvedTextureUrl ?? TRANSPARENT_PIXEL

  // Load the texture using useLoader (only when textureUrl changes)
  const planetTexture = useLoader(THREE.TextureLoader, textureUrl)

  // Unified sync: store changes → Leva controls (one-way)
  useEffect(() => {
    const updates: Record<
      string,
      string | number | boolean | { x: number; y: number }
    > = {}

    // Sync image selection
    if (selectedImagePath && selectedImage !== selectedImagePath) {
      updates.selectedImage = selectedImagePath
    }

    // Sync all planet config values
    if (
      planetConfig?.enabled !== undefined &&
      enabled !== planetConfig.enabled
    ) {
      updates.enabled = planetConfig.enabled
    }
    if (planetConfig?.scale !== undefined && scale !== planetConfig.scale) {
      updates.scale = planetConfig.scale
    }
    if (
      planetConfig?.opacity !== undefined &&
      opacity !== planetConfig.opacity
    ) {
      updates.opacity = planetConfig.opacity
    }
    if (
      planetConfig?.position &&
      (positionX !== planetConfig.position.x ||
        positionY !== planetConfig.position.y)
    ) {
      // Create a fresh object (planetConfig.position may be readonly/frozen)
      updates.position = {
        x: planetConfig.position.x,
        y: planetConfig.position.y,
      }
    }
    if (planetConfig?.tintColor && tintColor !== planetConfig.tintColor) {
      updates.tintColor = planetConfig.tintColor
    }
    if (
      planetConfig?.tintIntensity !== undefined &&
      tintIntensity !== planetConfig.tintIntensity
    ) {
      updates.tintIntensity = planetConfig.tintIntensity
    }
    if (
      planetConfig?.shadowEnabled !== undefined &&
      shadowEnabled !== planetConfig.shadowEnabled
    ) {
      updates.shadowEnabled = planetConfig.shadowEnabled
    }
    if (
      planetConfig?.shadowRadius !== undefined &&
      shadowRadius !== planetConfig.shadowRadius
    ) {
      updates.shadowRadius = planetConfig.shadowRadius
    }
    if (
      planetConfig?.shadowOpacity !== undefined &&
      shadowOpacity !== planetConfig.shadowOpacity
    ) {
      updates.shadowOpacity = planetConfig.shadowOpacity
    }
    if (
      planetConfig?.shadowFalloff !== undefined &&
      shadowFalloff !== planetConfig.shadowFalloff
    ) {
      updates.shadowFalloff = planetConfig.shadowFalloff
    }
    if (planetConfig?.shadowColor && shadowColor !== planetConfig.shadowColor) {
      updates.shadowColor = planetConfig.shadowColor
    }

    // Apply all updates at once
    if (Object.keys(updates).length > 0) {
      set(updates)
    }
  }, [
    planetConfig,
    selectedImagePath,
    selectedImage,
    enabled,
    scale,
    opacity,
    positionX,
    positionY,
    tintColor,
    tintIntensity,
    shadowEnabled,
    shadowRadius,
    shadowOpacity,
    shadowFalloff,
    shadowColor,
    set,
  ])

  // Boosted tint color for vibrant effect with additive blending
  const boostedTintColor = useMemo(() => {
    const color = new THREE.Color(tintColor)
    return color.multiplyScalar(tintIntensity)
  }, [tintColor, tintIntensity])

  // Shadow material
  const shadowMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
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
      }),
    [shadowColor, shadowFalloff, shadowOpacity, shadowRadius]
  )

  useEffect(() => {
    return () => {
      shadowMaterial.dispose()
    }
  }, [shadowMaterial])

  // Calculate dimensions based on texture aspect ratio
  const aspectRatio = planetTexture.width / planetTexture.height
  const width = scale * aspectRatio
  const height = scale

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.set(
        camera.position.x + positionX,
        camera.position.y + positionY,
        camera.position.z - 100
      )

      groupRef.current.lookAt(camera.position)
    }
  })

  useEffect(() => {
    invalidate()
  }, [
    positionX,
    positionY,
    scale,
    opacity,
    textureUrl,
    tintColor,
    tintIntensity,
  ])

  // Return null if no image assets available or planet is disabled
  if (!imageAssets || imageAssets.length === 0) {
    return null
  }

  if (!hasTexture || planetConfig?.imageIndex == null) {
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
      <mesh renderOrder={1} layers={[LAYERS.BACKGROUND]}>
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

import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"
import { useShallow } from "zustand/react/shallow"

import { getPalette } from "@/colors"
import { useTextureCache } from "@/utils/textureCache"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"

// Default planet config values
const DEFAULT_PLANET_CONFIG = {
  enabled: true,
  scale: 80,
  opacity: 1,
  position: { x: 0, y: 0 },
  tintIntensity: 1,
  shadowEnabled: true,
  shadowRadius: 0.5,
  shadowOpacity: 0.7,
  shadowFalloff: 0.6,
}

export const Planet = () => {
  const showControls = useShowControls()
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()

  const { imageAssets, planetConfig, paletteKey } = useGameStore(
    useShallow((state) => ({
      imageAssets: state.starfieldConfig.imageAssets,
      planetConfig: state.starfieldConfig.planet,
      paletteKey: state.starfieldConfig.palette,
    }))
  )

  // Filter to only skybox images for planet backgrounds
  const skyboxAssets = useMemo(
    () => imageAssets?.filter((asset) => asset.type === "skybox") ?? [],
    [imageAssets]
  )

  // Get active palette (memoized to prevent unnecessary recalculations)
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  // Default colors from palette (memoized to stabilize references)
  const defaultTintColor = useMemo(
    () => planetConfig?.tintColor ?? `#${palette.tint.getHexString()}`,
    [planetConfig, palette]
  )
  const defaultShadowColor = useMemo(
    () => planetConfig?.shadowColor ?? `#${palette.base.getHexString()}`,
    [planetConfig, palette]
  )

  const selectedImagePath = useMemo(() => {
    if (!skyboxAssets.length) return undefined
    const index = planetConfig?.imageIndex ?? 0
    return skyboxAssets[index]?.url ?? skyboxAssets[0]?.url
  }, [skyboxAssets, planetConfig?.imageIndex])

  // Create simple options object for leva select
  const imageOptions = useMemo(() => {
    return skyboxAssets.reduce(
      (acc, asset) => {
        acc[asset.url] = asset.url
        return acc
      },
      {} as Record<string, string>
    )
  }, [skyboxAssets])

  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                Planet: folder(
                  {
                    enabled: {
                      value:
                        planetConfig?.enabled ?? DEFAULT_PLANET_CONFIG.enabled,
                      label: "Enable Planet",
                    },
                    selectedImage: {
                      value: selectedImagePath ?? "",
                      options: imageOptions,
                      label: "Image",
                    },
                    scale: {
                      value: planetConfig?.scale ?? DEFAULT_PLANET_CONFIG.scale,
                      min: 10,
                      max: 250,
                      step: 1,
                    },
                    opacity: {
                      value:
                        planetConfig?.opacity ?? DEFAULT_PLANET_CONFIG.opacity,
                      min: 0,
                      max: 1,
                      step: 0.01,
                    },
                    position: {
                      value:
                        planetConfig?.position ??
                        DEFAULT_PLANET_CONFIG.position,
                      step: 1,
                    },
                    tintColor: {
                      value: defaultTintColor,
                      label: "Tint Color",
                    },
                    tintIntensity: {
                      value:
                        planetConfig?.tintIntensity ??
                        DEFAULT_PLANET_CONFIG.tintIntensity,
                      min: 0,
                      max: 2,
                      step: 0.1,
                      label: "Tint Intensity",
                    },
                    shadowEnabled: {
                      value:
                        planetConfig?.shadowEnabled ??
                        DEFAULT_PLANET_CONFIG.shadowEnabled,
                      label: "Shadow Enabled",
                    },
                    shadowRadius: {
                      value:
                        planetConfig?.shadowRadius ??
                        DEFAULT_PLANET_CONFIG.shadowRadius,
                      min: 0.1,
                      max: 1.0,
                      step: 0.1,
                      label: "Shadow Radius",
                    },
                    shadowOpacity: {
                      value:
                        planetConfig?.shadowOpacity ??
                        DEFAULT_PLANET_CONFIG.shadowOpacity,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      label: "Shadow Opacity",
                    },
                    shadowFalloff: {
                      value:
                        planetConfig?.shadowFalloff ??
                        DEFAULT_PLANET_CONFIG.shadowFalloff,
                      min: 0.0,
                      max: 1.0,
                      step: 0.1,
                      label: "Shadow Falloff",
                    },
                    shadowColor: {
                      value: defaultShadowColor,
                      label: "Shadow Color",
                    },
                  },
                  { collapsed: true }
                ),
              },
              { collapsed: true, order: PANEL_ORDERING.RENDERING }
            ),
          }
        : {}) as Schema
  )

  // Get values from Leva when showing controls, otherwise from config/defaults
  const controls = useMemo(
    () =>
      showControls
        ? (levaValues as typeof DEFAULT_PLANET_CONFIG & {
            selectedImage: string
            tintColor: string
            shadowColor: string
          })
        : {
            enabled: planetConfig?.enabled ?? DEFAULT_PLANET_CONFIG.enabled,
            selectedImage: selectedImagePath ?? "",
            scale: planetConfig?.scale ?? DEFAULT_PLANET_CONFIG.scale,
            opacity: planetConfig?.opacity ?? DEFAULT_PLANET_CONFIG.opacity,
            position: planetConfig?.position ?? DEFAULT_PLANET_CONFIG.position,
            tintColor: defaultTintColor,
            tintIntensity:
              planetConfig?.tintIntensity ??
              DEFAULT_PLANET_CONFIG.tintIntensity,
            shadowEnabled:
              planetConfig?.shadowEnabled ??
              DEFAULT_PLANET_CONFIG.shadowEnabled,
            shadowRadius:
              planetConfig?.shadowRadius ?? DEFAULT_PLANET_CONFIG.shadowRadius,
            shadowOpacity:
              planetConfig?.shadowOpacity ??
              DEFAULT_PLANET_CONFIG.shadowOpacity,
            shadowFalloff:
              planetConfig?.shadowFalloff ??
              DEFAULT_PLANET_CONFIG.shadowFalloff,
            shadowColor: defaultShadowColor,
          },
    [
      showControls,
      levaValues,
      planetConfig,
      selectedImagePath,
      defaultTintColor,
      defaultShadowColor,
    ]
  )

  // Sync: palette changes -> Leva controls
  useEffect(() => {
    if (!showControls) return
    try {
      set({
        tintColor: `#${palette.tint.getHexString()}`,
        shadowColor: `#${palette.base.getHexString()}`,
      })
    } catch {
      // Controls may not be mounted
    }
  }, [showControls, palette, set])

  // Sync: store config -> Leva controls
  useEffect(() => {
    if (!showControls) return
    if (!planetConfig) return
    try {
      // Omit imageIndex from leva config as we pass filename instead of index
      const { imageIndex: _imageIndex, ...rest } = planetConfig
      set({
        ...rest,
        selectedImage: selectedImagePath ?? "",
        position: {
          x: planetConfig.position?.x ?? 0,
          y: planetConfig.position?.y ?? 0,
        },
      })
    } catch {
      // Controls may not be mounted
    }
  }, [showControls, planetConfig, selectedImagePath, set])

  // Get texture URL - prioritize Leva selection, then config, then first available
  const resolvedTextureUrl = useMemo(() => {
    if (controls.selectedImage) return controls.selectedImage
    if (selectedImagePath) return selectedImagePath
    if (skyboxAssets.length) return skyboxAssets[0].url
    return null
  }, [skyboxAssets, controls.selectedImage, selectedImagePath])

  // Subscribe to texture cache - will re-render when texture becomes available
  const textureMap = useTextureCache((state) => state.textures)
  
  // Get texture from cache (populated by AssetPreloader)
  // This avoids suspense when switching textures - just reads from cache
  const planetTexture = resolvedTextureUrl
    ? textureMap.get(resolvedTextureUrl) ?? null
    : null

  // Boosted tint color for vibrant effect with additive blending
  const boostedTintColor = useMemo(() => {
    const color = new THREE.Color(controls.tintColor)
    return color.multiplyScalar(controls.tintIntensity)
  }, [controls.tintColor, controls.tintIntensity])

  // Shadow material
  const shadowMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shadowVertexShader,
        fragmentShader: shadowFragmentShader,
        uniforms: {
          uRadius: { value: controls.shadowRadius },
          uOpacity: { value: controls.shadowOpacity },
          uFalloff: { value: controls.shadowFalloff },
          uColor: { value: new THREE.Color(controls.shadowColor) },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [
      controls.shadowColor,
      controls.shadowFalloff,
      controls.shadowOpacity,
      controls.shadowRadius,
    ]
  )

  // Calculate dimensions based on texture aspect ratio
  const { width, height } = useMemo(() => {
    if (!planetTexture?.image) {
      return { width: controls.scale, height: controls.scale }
    }
    const img = planetTexture.image as HTMLImageElement
    const aspectRatio = img.width / img.height
    return {
      width: controls.scale * aspectRatio,
      height: controls.scale,
    }
  }, [planetTexture, controls.scale])

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.set(
        camera.position.x + controls.position.x,
        camera.position.y + controls.position.y,
        camera.position.z - 100
      )

      groupRef.current.lookAt(camera.position)
    }
  })

  // Return null if no skybox assets available, no texture, or planet is disabled
  if (skyboxAssets.length === 0 || !planetTexture || !controls.enabled) {
    return null
  }

  return (
    <group ref={groupRef} frustumCulled={false}>
      {/* Shadow mesh - rendered behind planet */}
      {controls.shadowEnabled && (
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
          opacity={controls.opacity}
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

import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"
import { useShallow } from "zustand/react/shallow"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"
import { useTextureCache } from "@/utils/textureCache"

// Default planet config values
const DEFAULT_PLANET_CONFIG = {
  enabled: true,
  scale: 60,
  opacity: 1,
  positionX: 0,
  positionY: 0,
  color: "#000000", // tint color -> palette.tint
  tintIntensity: 1,
  shadowEnabled: true,
  shadowRadius: 0.5,
  shadowOpacity: 0.8,
  shadowFalloff: 0.6,
  base: "#000000", // shadow color -> palette.base
}

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = [
  "enabled",
  "scale",
  "opacity",
  "tintIntensity",
  "shadowEnabled",
  "shadowRadius",
  "shadowOpacity",
  "shadowFalloff",
] as const

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
                    positionX: {
                      value:
                        planetConfig?.position?.x ??
                        DEFAULT_PLANET_CONFIG.positionX,
                      min: -100,
                      max: 100,
                      step: 1,
                      label: "Position X",
                    },
                    positionY: {
                      value:
                        planetConfig?.position?.y ??
                        DEFAULT_PLANET_CONFIG.positionY,
                      min: -100,
                      max: 100,
                      step: 1,
                      label: "Position Y",
                    },
                    color: {
                      value: `#${palette.tint.getHexString()}`,
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
                    base: {
                      value: `#${palette.base.getHexString()}`,
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

  // Map planet config to match our defaults shape (flatten position)
  const mappedSource = useMemo(() => {
    if (!planetConfig) return undefined
    return {
      ...planetConfig,
      positionX: planetConfig.position?.x,
      positionY: planetConfig.position?.y,
      color: planetConfig.tintColor,
      base: planetConfig.shadowColor,
    } as Partial<typeof DEFAULT_PLANET_CONFIG>
  }, [planetConfig])

  // Get stable config - hook handles all stabilization and palette colors
  const controls = useControlSync({
    source: mappedSource,
    defaults: DEFAULT_PLANET_CONFIG,
    palette,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<
      typeof DEFAULT_PLANET_CONFIG & { selectedImage: string }
    >,
    set: set as (values: Partial<typeof DEFAULT_PLANET_CONFIG>) => void,
  })

  // Get selected image from Leva or fallback
  const selectedImage = showControls
    ? ((levaValues as { selectedImage?: string }).selectedImage ?? "")
    : (selectedImagePath ?? "")

  // Get texture URL - prioritize Leva selection, then config, then first available
  const resolvedTextureUrl = useMemo(() => {
    if (selectedImage) return selectedImage
    if (selectedImagePath) return selectedImagePath
    if (skyboxAssets.length) return skyboxAssets[0].url
    return null
  }, [skyboxAssets, selectedImage, selectedImagePath])

  // Subscribe to texture cache - will re-render when texture becomes available
  const textureMap = useTextureCache((state) => state.textures)

  // Get texture from cache (populated by AssetPreloader)
  // This avoids suspense when switching textures - just reads from cache
  const planetTexture = resolvedTextureUrl
    ? (textureMap.get(resolvedTextureUrl) ?? null)
    : null

  // Boosted tint color for vibrant effect with additive blending
  const boostedTintColor = useMemo(() => {
    const color = new THREE.Color(controls.color)
    return color.multiplyScalar(controls.tintIntensity)
  }, [controls.color, controls.tintIntensity])

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
          uColor: { value: new THREE.Color(controls.base) },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [
      controls.base,
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
        camera.position.x + controls.positionX,
        camera.position.y + controls.positionY,
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

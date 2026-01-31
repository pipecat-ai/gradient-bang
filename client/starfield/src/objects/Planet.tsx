import { useEffect, useMemo, useRef } from "react"
import { useFrame, useLoader, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"
import { useShallow } from "zustand/react/shallow"

import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import {
  shadowFragmentShader,
  shadowVertexShader,
} from "@/fx/PlanetShadowShader"
import { useGameStore } from "@/useGameStore"

const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax18ncAAAAASUVORK5CYII="

export const Planet = () => {
  const groupRef = useRef<THREE.Group>(null)
  const preloadedAssetsRef = useRef<Set<string>>(new Set())
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

  // Get active palette
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

  const [planetUniforms, set] = useControls(() => ({
    Planet: folder(
      {
        enabled: {
          value: planetConfig?.enabled ?? true,
          label: "Enable Planet",
        },
        selectedImage: {
          value: selectedImagePath ?? "",
          options: imageOptions,
          label: "Image",
        },
        scale: {
          value: planetConfig?.scale ?? 100,
          min: 10,
          max: 250,
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
          value: planetConfig?.tintIntensity ?? 1,
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
          value: planetConfig?.shadowRadius ?? 0.5,
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
          value: planetConfig?.shadowFalloff ?? 0.6,
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

  // Sync: palette changes -> Leva controls
  useEffect(() => {
    set({
      tintColor: `#${palette.tint.getHexString()}`,
      shadowColor: `#${palette.base.getHexString()}`,
    })
  }, [palette, set])

  // Sync: store config -> Leva controls
  useEffect(() => {
    if (!planetConfig) return
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
  }, [planetConfig, selectedImagePath, set])

  useEffect(() => {
    if (skyboxAssets.length > 0) {
      const assetsToPreload = skyboxAssets.filter(
        (asset) => !preloadedAssetsRef.current.has(asset.url)
      )

      if (assetsToPreload.length > 0) {
        console.debug(
          "[STARFIELD PLANET] Preloading image assets",
          assetsToPreload.map((a) => a.url)
        )
        assetsToPreload.forEach((asset) => {
          useLoader.preload(THREE.TextureLoader, asset.url)
          preloadedAssetsRef.current.add(asset.url)
        })
      }
    }
  }, [skyboxAssets])

  const resolvedTextureUrl = useMemo(() => {
    if (planetUniforms.selectedImage) return planetUniforms.selectedImage
    if (selectedImagePath) return selectedImagePath
    if (skyboxAssets.length) return skyboxAssets[0].url
    return null
  }, [skyboxAssets, planetUniforms.selectedImage, selectedImagePath])
  const hasTexture = Boolean(resolvedTextureUrl)
  const textureUrl = resolvedTextureUrl ? resolvedTextureUrl : TRANSPARENT_PIXEL
  const planetTexture = useLoader(THREE.TextureLoader, textureUrl)

  // Boosted tint color for vibrant effect with additive blending
  const boostedTintColor = useMemo(() => {
    const color = new THREE.Color(planetUniforms.tintColor)
    return color.multiplyScalar(planetUniforms.tintIntensity)
  }, [planetUniforms.tintColor, planetUniforms.tintIntensity])

  // Shadow material
  const shadowMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shadowVertexShader,
        fragmentShader: shadowFragmentShader,
        uniforms: {
          uRadius: { value: planetUniforms.shadowRadius },
          uOpacity: { value: planetUniforms.shadowOpacity },
          uFalloff: { value: planetUniforms.shadowFalloff },
          uColor: { value: new THREE.Color(planetUniforms.shadowColor) },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [
      planetUniforms.shadowColor,
      planetUniforms.shadowFalloff,
      planetUniforms.shadowOpacity,
      planetUniforms.shadowRadius,
    ]
  )

  // Calculate dimensions based on texture aspect ratio
  const { width, height } = useMemo(() => {
    const aspectRatio = planetTexture.width / planetTexture.height
    return {
      width: planetUniforms.scale * aspectRatio,
      height: planetUniforms.scale,
    }
  }, [planetTexture.width, planetTexture.height, planetUniforms.scale])

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.set(
        camera.position.x + planetUniforms.position.x,
        camera.position.y + planetUniforms.position.y,
        camera.position.z - 100
      )

      groupRef.current.lookAt(camera.position)
    }
  })

  // Return null if no skybox assets available, no texture, or planet is disabled
  if (skyboxAssets.length === 0 || !hasTexture || !planetUniforms.enabled) {
    return null
  }

  return (
    <group ref={groupRef} frustumCulled={false}>
      {/* Shadow mesh - rendered behind planet */}
      {planetUniforms.shadowEnabled && (
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
          opacity={planetUniforms.opacity}
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

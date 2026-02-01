import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { sunFragmentShader, sunVertexShader } from "@/shaders/SunShader"
import { useGameStore } from "@/useGameStore"
import { createValueNoiseTexture } from "@/utils/noise"

const sunNoiseTexture = createValueNoiseTexture(256)

// Default sun config values
const DEFAULT_SUN_CONFIG = {
  enabled: true,
  scale: 100,
  intensity: 0.5,
  primaryColor: "#000000", // core color -> palette.c1
  secondaryColor: "#000000", // corona color -> palette.c2
  positionX: 30,
  positionY: 30,
  positionZ: -80,
}

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = [
  "enabled",
  "scale",
  "intensity",
  "positionX",
  "positionY",
  "positionZ",
] as const

export const Sun = () => {
  const showControls = useShowControls()
  const groupRef = useRef<THREE.Group>(null)
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  const { camera } = useThree()
  const { sun: sunConfig, palette: paletteKey } = useGameStore(
    (state) => state.starfieldConfig
  )

  // Get active palette (memoized to prevent unnecessary recalculations)
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  // Leva controls for all sun parameters with palette cascade
  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                Sun: folder(
                  {
                    enabled: {
                      value: sunConfig?.enabled ?? DEFAULT_SUN_CONFIG.enabled,
                      label: "Enable Sun",
                    },
                    scale: {
                      value: sunConfig?.scale ?? DEFAULT_SUN_CONFIG.scale,
                      min: 1,
                      max: 300,
                      step: 1,
                      label: "Size",
                    },
                    intensity: {
                      value:
                        sunConfig?.intensity ?? DEFAULT_SUN_CONFIG.intensity,
                      min: 0,
                      max: 3,
                      step: 0.1,
                      label: "Intensity",
                    },
                    primaryColor: {
                      value: `#${palette.c1.getHexString()}`,
                      label: "Core Color",
                    },
                    secondaryColor: {
                      value: `#${palette.c2.getHexString()}`,
                      label: "Corona Color",
                    },
                    positionX: {
                      value:
                        sunConfig?.position?.x ?? DEFAULT_SUN_CONFIG.positionX,
                      min: -300,
                      max: 300,
                      step: 1,
                      label: "Position X",
                    },
                    positionY: {
                      value:
                        sunConfig?.position?.y ?? DEFAULT_SUN_CONFIG.positionY,
                      min: -300,
                      max: 300,
                      step: 1,
                      label: "Position Y",
                    },
                    positionZ: {
                      value:
                        sunConfig?.position?.z ?? DEFAULT_SUN_CONFIG.positionZ,
                      min: -300,
                      max: 300,
                      step: 1,
                      label: "Position Z",
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

  // Map sun config to match our defaults shape (flatten position, rename colors)
  const mappedSource = useMemo(() => {
    if (!sunConfig) return undefined
    return {
      ...sunConfig,
      positionX: sunConfig.position?.x,
      positionY: sunConfig.position?.y,
      positionZ: sunConfig.position?.z,
      primaryColor: sunConfig.color
        ? `#${new THREE.Color(sunConfig.color).getHexString()}`
        : undefined,
      secondaryColor: sunConfig.coronaColor
        ? `#${new THREE.Color(sunConfig.coronaColor).getHexString()}`
        : undefined,
    } as Partial<typeof DEFAULT_SUN_CONFIG>
  }, [sunConfig])

  // Get stable config - hook handles all stabilization and palette colors
  const controls = useControlSync({
    source: mappedSource,
    defaults: DEFAULT_SUN_CONFIG,
    palette,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_SUN_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_SUN_CONFIG>) => void,
  })

  // Create shader material for the sun (only once)
  const sunMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uIntensity: { value: 1.0 },
        uCoreColor: {
          value: new THREE.Vector3(1, 1, 1),
        },
        uCoronaColor: {
          value: new THREE.Vector3(1, 1, 1),
        },
        uScale: { value: 100 },
        uCameraPosition: { value: new THREE.Vector3() },
        uNoiseTexture: { value: sunNoiseTexture },
      },
      vertexShader: sunVertexShader,
      fragmentShader: sunFragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
  }, [])

  // Store material in ref for mutations in useFrame
  useEffect(() => {
    materialRef.current = sunMaterial
  }, [sunMaterial])

  // Update shader uniforms on each frame
  useFrame(() => {
    if (!groupRef.current || !materialRef.current) return

    const material = materialRef.current

    // Update camera position for shader
    material.uniforms.uCameraPosition.value.copy(camera.position)

    // Update position relative to camera
    groupRef.current.position.set(
      camera.position.x + controls.positionX,
      camera.position.y + controls.positionY,
      camera.position.z + controls.positionZ
    )

    // Update dynamic uniforms if controls change
    material.uniforms.uIntensity.value = controls.intensity
    material.uniforms.uScale.value = controls.scale

    const coreColorObj = new THREE.Color(controls.primaryColor)
    const coronaColorObj = new THREE.Color(controls.secondaryColor)
    material.uniforms.uCoreColor.value.set(
      coreColorObj.r,
      coreColorObj.g,
      coreColorObj.b
    )
    material.uniforms.uCoronaColor.value.set(
      coronaColorObj.r,
      coronaColorObj.g,
      coronaColorObj.b
    )
  })

  if (!controls.enabled) return null

  return (
    <group ref={groupRef} frustumCulled={false}>
      {/* Outer glow layer - largest, most diffuse */}
      <mesh
        renderOrder={-100}
        layers={LAYERS.FOREGROUND}
        material={sunMaterial}
        scale={[
          controls.scale * 2.5,
          controls.scale * 2.5,
          controls.scale * 2.5,
        ]}
      >
        <sphereGeometry args={[1, 32, 32]} />
      </mesh>

      {/* Mid glow layer */}
      <mesh
        renderOrder={-99}
        layers={LAYERS.FOREGROUND}
        material={sunMaterial}
        scale={[
          controls.scale * 1.5,
          controls.scale * 1.5,
          controls.scale * 1.5,
        ]}
      >
        <sphereGeometry args={[1, 32, 32]} />
      </mesh>

      {/* Core layer - brightest, smallest */}
      <mesh
        renderOrder={-98}
        layers={LAYERS.FOREGROUND}
        material={sunMaterial}
        scale={[controls.scale, controls.scale, controls.scale]}
      >
        <sphereGeometry args={[1, 32, 32]} />
      </mesh>
    </group>
  )
}

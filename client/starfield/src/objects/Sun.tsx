import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
import { sunFragmentShader, sunVertexShader } from "@/shaders/SunShader"
import { useGameStore } from "@/useGameStore"
import { createValueNoiseTexture } from "@/utils/noise"

const sunNoiseTexture = createValueNoiseTexture(256)

// Default sun config values
const DEFAULT_SUN_CONFIG = {
  enabled: true,
  scale: 100,
  intensity: 1.2,
  positionX: -40,
  positionY: 30,
  positionZ: -80,
}

export const Sun = () => {
  const showControls = useShowControls()
  const groupRef = useRef<THREE.Group>(null)
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  const { camera } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { sun: sunConfig } = starfieldConfig

  // Get active palette (memoized to prevent unnecessary recalculations)
  const palette = useMemo(
    () => getPalette(starfieldConfig.palette),
    [starfieldConfig.palette]
  )

  // Default colors from palette (memoized to stabilize references)
  const defaultCoreColor = useMemo(
    () =>
      sunConfig?.color
        ? `#${new THREE.Color(sunConfig.color).getHexString()}`
        : `#${palette.c1.getHexString()}`,
    [sunConfig, palette]
  )
  const defaultCoronaColor = useMemo(
    () =>
      sunConfig?.coronaColor
        ? `#${new THREE.Color(sunConfig.coronaColor).getHexString()}`
        : `#${palette.c2.getHexString()}`,
    [sunConfig, palette]
  )

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
                    coreColor: {
                      value: defaultCoreColor,
                      label: "Core Color",
                    },
                    coronaColor: {
                      value: defaultCoronaColor,
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

  // Get values from Leva when showing controls, otherwise from config/defaults
  const controls = useMemo(
    () =>
      showControls
        ? (levaValues as typeof DEFAULT_SUN_CONFIG & {
            coreColor: string
            coronaColor: string
          })
        : {
            enabled: sunConfig?.enabled ?? DEFAULT_SUN_CONFIG.enabled,
            scale: sunConfig?.scale ?? DEFAULT_SUN_CONFIG.scale,
            intensity: sunConfig?.intensity ?? DEFAULT_SUN_CONFIG.intensity,
            coreColor: defaultCoreColor,
            coronaColor: defaultCoronaColor,
            positionX: sunConfig?.position?.x ?? DEFAULT_SUN_CONFIG.positionX,
            positionY: sunConfig?.position?.y ?? DEFAULT_SUN_CONFIG.positionY,
            positionZ: sunConfig?.position?.z ?? DEFAULT_SUN_CONFIG.positionZ,
          },
    [showControls, levaValues, sunConfig, defaultCoreColor, defaultCoronaColor]
  )

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (!showControls) return
    if (!sunConfig?.color && !sunConfig?.coronaColor) {
      try {
        set({
          coreColor: `#${palette.c1.getHexString()}`,
          coronaColor: `#${palette.c2.getHexString()}`,
        })
      } catch {
        // Controls may not be mounted
      }
    }
  }, [showControls, starfieldConfig.palette, palette, sunConfig, set])

  // Sync sun config changes to Leva controls (only set defined values, let Leva keep defaults)
  useEffect(() => {
    if (!showControls) return
    if (!sunConfig) return
    const updates: Record<string, number> = {}
    if (sunConfig.intensity !== undefined)
      updates.intensity = sunConfig.intensity
    try {
      set(updates)
    } catch {
      // Controls may not be mounted
    }
  }, [showControls, sunConfig, set])

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

    const coreColorObj = new THREE.Color(controls.coreColor)
    const coronaColorObj = new THREE.Color(controls.coronaColor)
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

import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
import {
  nebulaFragmentShader,
  nebulaVertexShader,
} from "@/shaders/NebulaShader"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

// Default nebula config values
const DEFAULT_NEBULA_CONFIG = {
  enabled: true,
  intensity: 0.8,
  domainScale: 1,
  iterPrimary: 23,
  iterSecondary: 5,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  warpOffsetX: -0.5,
  warpOffsetY: -0.4,
  warpOffsetZ: -1.487,
  warpDecay: 5.0,
}

export const Nebula = () => {
  const showControls = useShowControls()
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera, size } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { nebula: nebulaConfig } = starfieldConfig
  const registerUniform = useUniformStore((state) => state.registerUniform)
  const removeUniform = useUniformStore((state) => state.removeUniform)

  // Get active palette (memoized to prevent unnecessary recalculations)
  const palette = useMemo(
    () => getPalette(starfieldConfig.palette),
    [starfieldConfig.palette]
  )

  // Default colors from palette (memoized to stabilize references)
  const defaultColor = useMemo(
    () =>
      nebulaConfig?.color
        ? `#${new THREE.Color(nebulaConfig.color).getHexString()}`
        : `#${palette.tint.getHexString()}`,
    [nebulaConfig, palette]
  )
  const defaultPrimaryColor = useMemo(
    () =>
      nebulaConfig?.primaryColor
        ? `#${new THREE.Color(nebulaConfig.primaryColor).getHexString()}`
        : `#${palette.c1.getHexString()}`,
    [nebulaConfig, palette]
  )
  const defaultSecondaryColor = useMemo(
    () =>
      nebulaConfig?.secondaryColor
        ? `#${new THREE.Color(nebulaConfig.secondaryColor).getHexString()}`
        : `#${palette.c2.getHexString()}`,
    [nebulaConfig, palette]
  )

  // Leva controls for all nebula uniforms with palette cascade
  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                Nebula: folder(
                  {
                    enabled: {
                      value:
                        nebulaConfig?.enabled ?? DEFAULT_NEBULA_CONFIG.enabled,
                      label: "Enable Nebula",
                    },
                    intensity: {
                      value:
                        nebulaConfig?.intensity ??
                        DEFAULT_NEBULA_CONFIG.intensity,
                      min: 0,
                      max: 1,
                      step: 0.1,
                      label: "Intensity",
                    },
                    color: {
                      value: defaultColor,
                      label: "Global Tint",
                    },
                    primaryColor: {
                      value: defaultPrimaryColor,
                      label: "Primary Color",
                    },
                    secondaryColor: {
                      value: defaultSecondaryColor,
                      label: "Secondary Color",
                    },
                    domainScale: {
                      value:
                        nebulaConfig?.domainScale ??
                        DEFAULT_NEBULA_CONFIG.domainScale,
                      min: 0.1,
                      max: 3,
                      step: 0.1,
                      label: "Domain Scale",
                    },
                    iterPrimary: {
                      value:
                        nebulaConfig?.iterPrimary ??
                        DEFAULT_NEBULA_CONFIG.iterPrimary,
                      min: 1,
                      max: 50,
                      step: 0.1,
                      label: "Primary Iterations",
                    },
                    iterSecondary: {
                      value:
                        nebulaConfig?.iterSecondary ??
                        DEFAULT_NEBULA_CONFIG.iterSecondary,
                      min: 0,
                      max: 50,
                      step: 1,
                      label: "Secondary Iterations",
                    },
                    rotationX: {
                      value:
                        nebulaConfig?.rotation?.[0] ??
                        DEFAULT_NEBULA_CONFIG.rotationX,
                      min: -Math.PI,
                      max: Math.PI,
                      step: 0.01,
                      label: "Rotation X",
                    },
                    rotationY: {
                      value:
                        nebulaConfig?.rotation?.[1] ??
                        DEFAULT_NEBULA_CONFIG.rotationY,
                      min: -Math.PI,
                      max: Math.PI,
                      step: 0.01,
                      label: "Rotation Y",
                    },
                    rotationZ: {
                      value:
                        nebulaConfig?.rotation?.[2] ??
                        DEFAULT_NEBULA_CONFIG.rotationZ,
                      min: -Math.PI,
                      max: Math.PI,
                      step: 0.01,
                      label: "Rotation Z",
                    },
                    warpOffsetX: {
                      value: DEFAULT_NEBULA_CONFIG.warpOffsetX,
                      min: -2,
                      max: 2,
                      step: 0.01,
                      label: "Warp Offset X",
                    },
                    warpOffsetY: {
                      value: DEFAULT_NEBULA_CONFIG.warpOffsetY,
                      min: -2,
                      max: 2,
                      step: 0.01,
                      label: "Warp Offset Y",
                    },
                    warpOffsetZ: {
                      value: DEFAULT_NEBULA_CONFIG.warpOffsetZ,
                      min: -3,
                      max: 3,
                      step: 0.001,
                      label: "Warp Offset Z",
                    },
                    warpDecay: {
                      value:
                        nebulaConfig?.warpDecay ??
                        DEFAULT_NEBULA_CONFIG.warpDecay,
                      min: 0.1,
                      max: 20,
                      step: 0.1,
                      label: "Warp Decay",
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
        ? (levaValues as typeof DEFAULT_NEBULA_CONFIG & {
            color: string
            primaryColor: string
            secondaryColor: string
          })
        : {
            enabled: nebulaConfig?.enabled ?? DEFAULT_NEBULA_CONFIG.enabled,
            intensity:
              nebulaConfig?.intensity ?? DEFAULT_NEBULA_CONFIG.intensity,
            color: defaultColor,
            primaryColor: defaultPrimaryColor,
            secondaryColor: defaultSecondaryColor,
            domainScale:
              nebulaConfig?.domainScale ?? DEFAULT_NEBULA_CONFIG.domainScale,
            iterPrimary:
              nebulaConfig?.iterPrimary ?? DEFAULT_NEBULA_CONFIG.iterPrimary,
            iterSecondary:
              nebulaConfig?.iterSecondary ??
              DEFAULT_NEBULA_CONFIG.iterSecondary,
            rotationX:
              nebulaConfig?.rotation?.[0] ?? DEFAULT_NEBULA_CONFIG.rotationX,
            rotationY:
              nebulaConfig?.rotation?.[1] ?? DEFAULT_NEBULA_CONFIG.rotationY,
            rotationZ:
              nebulaConfig?.rotation?.[2] ?? DEFAULT_NEBULA_CONFIG.rotationZ,
            warpOffsetX: DEFAULT_NEBULA_CONFIG.warpOffsetX,
            warpOffsetY: DEFAULT_NEBULA_CONFIG.warpOffsetY,
            warpOffsetZ: DEFAULT_NEBULA_CONFIG.warpOffsetZ,
            warpDecay:
              nebulaConfig?.warpDecay ?? DEFAULT_NEBULA_CONFIG.warpDecay,
          },
    [
      showControls,
      levaValues,
      nebulaConfig,
      defaultColor,
      defaultPrimaryColor,
      defaultSecondaryColor,
    ]
  )

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (!showControls) return
    if (
      !nebulaConfig?.color &&
      !nebulaConfig?.primaryColor &&
      !nebulaConfig?.secondaryColor
    ) {
      try {
        set({
          color: `#${palette.tint.getHexString()}`,
          primaryColor: `#${palette.c1.getHexString()}`,
          secondaryColor: `#${palette.c2.getHexString()}`,
        })
      } catch {
        // Controls may not be mounted
      }
    }
  }, [showControls, starfieldConfig.palette, palette, nebulaConfig, set])

  // Sync nebula config changes to Leva controls (only set defined values, let Leva keep defaults)
  useEffect(() => {
    if (!showControls) return
    if (!nebulaConfig) return
    const updates: Record<string, number> = {}
    if (nebulaConfig.intensity !== undefined)
      updates.intensity = nebulaConfig.intensity
    if (nebulaConfig.domainScale !== undefined)
      updates.domainScale = nebulaConfig.domainScale
    if (nebulaConfig.iterPrimary !== undefined)
      updates.iterPrimary = nebulaConfig.iterPrimary
    if (nebulaConfig.iterSecondary !== undefined)
      updates.iterSecondary = nebulaConfig.iterSecondary
    if (nebulaConfig.warpDecay !== undefined)
      updates.warpDecay = nebulaConfig.warpDecay
    try {
      set(updates)
    } catch {
      // Controls may not be mounted
    }
  }, [showControls, nebulaConfig, set])

  // Create shader material with uniforms from controls
  const material = useMemo(() => {
    const colorObj = new THREE.Color(controls.color)
    const primaryColorObj = new THREE.Color(controls.primaryColor)
    const secondaryColorObj = new THREE.Color(controls.secondaryColor)

    return new THREE.ShaderMaterial({
      uniforms: {
        resolution: {
          value: new THREE.Vector2(size.width, size.height),
        },
        intensity: { value: controls.intensity },
        color: {
          value: new THREE.Vector3(colorObj.r, colorObj.g, colorObj.b),
        },
        nebulaColorPrimary: {
          value: new THREE.Vector3(
            primaryColorObj.r,
            primaryColorObj.g,
            primaryColorObj.b
          ),
        },
        nebulaColorSecondary: {
          value: new THREE.Vector3(
            secondaryColorObj.r,
            secondaryColorObj.g,
            secondaryColorObj.b
          ),
        },
        iterPrimary: { value: controls.iterPrimary },
        iterSecondary: { value: controls.iterSecondary },
        domainScale: { value: controls.domainScale },
        warpOffset: {
          value: new THREE.Vector3(
            controls.warpOffsetX,
            controls.warpOffsetY,
            controls.warpOffsetZ
          ),
        },
        warpDecay: { value: controls.warpDecay },
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: false,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
  }, [size, controls])

  // Register animated uniforms with the uniform registry
  useEffect(() => {
    const mat = material
    if (!mat.uniforms) return

    registerUniform("nebulaDomainScale", mat.uniforms.domainScale, {
      initial: controls.domainScale,
      meta: { effect: "nebula", min: 0.1, max: 10, step: 0.1 },
    })

    return () => {
      removeUniform("nebulaDomainScale")
    }
  }, [material, controls.domainScale, registerUniform, removeUniform])

  // Fix sphere to camera position so it doesn't move when zooming/dollying
  useFrame(() => {
    if (!meshRef.current) return
    meshRef.current.position.copy(camera.position)
    meshRef.current.rotation.set(
      controls.rotationX,
      controls.rotationY,
      controls.rotationZ
    )
  })

  if (!controls.enabled) return null

  return (
    <mesh
      ref={meshRef}
      material={material}
      frustumCulled={false}
      layers={LAYERS.SKYBOX}
      renderOrder={-999}
    >
      <sphereGeometry args={[100, 64, 64]} />
    </mesh>
  )
}

import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"
import { useShallow } from "zustand/react/shallow"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import {
  nebulaFragmentShader,
  nebulaVertexShader,
} from "@/shaders/NebulaShader"
import { useGameStore } from "@/useGameStore"

const DEFAULT_NEBULA_CONFIG = {
  enabled: true,
  intensity: 0.7,
  color: "#000000",
  primaryColor: "#000000",
  secondaryColor: "#000000",
  domainScale: 1.2,
  iterPrimary: 15.8,
  iterSecondary: 5,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  warpOffsetX: -0.5,
  warpOffsetY: -0.4,
  warpOffsetZ: -1.487,
  warpDecay: 5.0,
}

const TRANSIENT_PROPERTIES = [
  "enabled",
  "intensity",
  "domainScale",
  "iterPrimary",
  "iterSecondary",
  "warpDecay",
] as const

export const Nebula = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera, size } = useThree()
  const { nebula: nebulaConfig } = useGameStore(
    useShallow((state) => ({
      nebula: state.starfieldConfig.nebula,
    }))
  )
  const paletteKey = useGameStore((state) => state.starfieldConfig.palette)
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])
  const showControls = useShowControls()

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
                      value: `#${palette.tint.getHexString()}`,
                      label: "Global Tint",
                    },
                    primaryColor: {
                      value: `#${palette.c1.getHexString()}`,
                      label: "Primary Color",
                    },
                    secondaryColor: {
                      value: `#${palette.c2.getHexString()}`,
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
                        nebulaConfig?.rotationX ??
                        DEFAULT_NEBULA_CONFIG.rotationX,
                      min: -Math.PI,
                      max: Math.PI,
                      step: 0.01,
                      label: "Rotation X",
                    },
                    rotationY: {
                      value:
                        nebulaConfig?.rotationY ??
                        DEFAULT_NEBULA_CONFIG.rotationY,
                      min: -Math.PI,
                      max: Math.PI,
                      step: 0.01,
                      label: "Rotation Y",
                    },
                    rotationZ: {
                      value:
                        nebulaConfig?.rotationZ ??
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

  const controls = useControlSync({
    source: nebulaConfig as Partial<typeof DEFAULT_NEBULA_CONFIG> | undefined,
    defaults: DEFAULT_NEBULA_CONFIG,
    palette,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_NEBULA_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_NEBULA_CONFIG>) => void,
  })

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

  // Only hide if explicitly disabled (not undefined during HMR settling)
  if (controls.enabled === false) return null

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

import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { getPalette } from "@/colors"
import {
  milkyWayFragmentShader,
  milkyWayVertexShader,
} from "@/shaders/MilkyWayShader"
import { LAYERS } from "@/Starfield"
import { useGameStore } from "@/useGameStore"

export const MilkyWay = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera, size } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { milkyWay: milkyWayConfig } = starfieldConfig

  // Get active palette
  const palette = getPalette(starfieldConfig.palette)

  // Leva controls for all milky way uniforms
  const controls = useControls({
    "Milky Way": folder(
      {
        enabled: {
          value: milkyWayConfig?.enabled ?? true,
          label: "Enable",
        },
        intensity: {
          value: milkyWayConfig?.intensity ?? 1.0,
          min: 0,
          max: 2,
          step: 0.05,
          label: "Intensity",
        },
        // Axis
        axisX: {
          value: milkyWayConfig?.axisX ?? 0.4,
          min: -1,
          max: 1,
          step: 0.1,
          label: "Axis X",
        },
        axisY: {
          value: milkyWayConfig?.axisY ?? 1.0,
          min: -1,
          max: 1,
          step: 0.1,
          label: "Axis Y",
        },
        axisZ: {
          value: milkyWayConfig?.axisZ ?? -0.2,
          min: -1,
          max: 1,
          step: 0.1,
          label: "Axis Z",
        },
        // Band
        bandColor: {
          value: milkyWayConfig?.bandColor
            ? `#${new THREE.Color(milkyWayConfig.bandColor).getHexString()}`
            : `#${palette.c2.getHexString()}`,
          label: "Band Color",
        },
        bandWidth: {
          value: milkyWayConfig?.bandWidth ?? 0.25,
          min: 0.05,
          max: 0.8,
          step: 0.01,
          label: "Band Width",
        },
        bandFalloff: {
          value: milkyWayConfig?.bandFalloff ?? 0.5,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "Band Falloff",
        },
        bandCoverage: {
          value: milkyWayConfig?.bandCoverage ?? 1.0,
          min: 0.0,
          max: 1.0,
          step: 0.01,
          label: "Band Coverage",
        },
        bandCoverageFalloff: {
          value: milkyWayConfig?.bandCoverageFalloff ?? 0.15,
          min: 0.01,
          max: 1.0,
          step: 0.01,
          label: "Band Coverage Falloff",
        },
        bandRotation: {
          value: milkyWayConfig?.bandRotation ?? 0.0,
          min: 0.0,
          max: 6.28,
          step: 0.1,
          label: "Band Rotation",
        },
        // Core
        coreColor: {
          value: milkyWayConfig?.coreColor
            ? `#${new THREE.Color(milkyWayConfig.coreColor).getHexString()}`
            : "#fcf2e6",
          label: "Core Color",
        },
        coreWidth: {
          value: milkyWayConfig?.coreWidth ?? 0.4,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "Core Width",
        },
        coreIntensity: {
          value: milkyWayConfig?.coreIntensity ?? 2.0,
          min: 0,
          max: 5,
          step: 0.1,
          label: "Core Intensity",
        },
        coreFalloff: {
          value: milkyWayConfig?.coreFalloff ?? 0.3,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "Core Falloff",
        },
        // Distortion
        distortionAmount: {
          value: milkyWayConfig?.distortionAmount ?? 0.05,
          min: 0,
          max: 0.2,
          step: 0.01,
          label: "Distortion Amount",
        },
        distortionScale: {
          value: milkyWayConfig?.distortionScale ?? 3.0,
          min: 0.5,
          max: 10.0,
          step: 0.5,
          label: "Distortion Scale",
        },
      },
      { collapsed: true }
    ),
  })

  const material = useMemo(() => {
    const bandColorObj = new THREE.Color(controls.bandColor)
    const coreColorObj = new THREE.Color(controls.coreColor)

    return new THREE.ShaderMaterial({
      uniforms: {
        resolution: {
          value: new THREE.Vector2(size.width, size.height),
        },
        intensity: { value: controls.intensity },
        galaxyAxis: {
          value: new THREE.Vector3(
            controls.axisX,
            controls.axisY,
            controls.axisZ
          ),
        },
        // Band
        bandColor: {
          value: new THREE.Vector3(
            bandColorObj.r,
            bandColorObj.g,
            bandColorObj.b
          ),
        },
        bandWidth: { value: controls.bandWidth },
        bandFalloff: { value: controls.bandFalloff },
        bandCoverage: { value: controls.bandCoverage },
        bandCoverageFalloff: { value: controls.bandCoverageFalloff },
        bandRotation: { value: controls.bandRotation },
        // Core
        coreColor: {
          value: new THREE.Vector3(
            coreColorObj.r,
            coreColorObj.g,
            coreColorObj.b
          ),
        },
        coreWidth: { value: controls.coreWidth },
        coreIntensity: { value: controls.coreIntensity },
        coreFalloff: { value: controls.coreFalloff },
        // Distortion
        distortionAmount: { value: controls.distortionAmount },
        distortionScale: { value: controls.distortionScale },
      },
      vertexShader: milkyWayVertexShader,
      fragmentShader: milkyWayFragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.BackSide,
    })
  }, [size, controls])

  useFrame(() => {
    if (!meshRef.current) return
    meshRef.current.position.copy(camera.position)
  })

  if (!controls.enabled) return null

  return (
    <mesh
      ref={meshRef}
      material={material}
      frustumCulled={false}
      renderOrder={-1}
      layers={LAYERS.SKYBOX}
    >
      <sphereGeometry args={[500, 64, 64]} />
    </mesh>
  )
}

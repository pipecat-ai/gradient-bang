import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import {
  nebulaFragmentShader,
  nebulaVertexShader,
} from "@/shaders/NebulaShader"
import { LAYERS } from "@/Starfield"
import { NEBULA_PALETTES } from "@/types"
import { useGameStore } from "@/useGameStore"

export const Nebula = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera, size } = useThree()
  const { nebula: nebulaConfig } = useGameStore(
    (state) => state.starfieldConfig
  )

  // Leva controls for all nebula uniforms
  const controls = useControls({
    "Nebula Settings": folder(
      {
        enabled: {
          value: nebulaConfig?.enabled ?? true,
          label: "Enable Nebula",
        },
        intensity: {
          value: nebulaConfig?.intensity ?? 0.8,
          min: 0,
          max: 1,
          step: 0.1,
          label: "Intensity",
        },
        color: {
          value: nebulaConfig?.color
            ? `#${new THREE.Color(nebulaConfig.color).getHexString()}`
            : "#e6f2ff",
          label: "Global Tint",
        },
        primaryColor: {
          value: nebulaConfig?.primaryColor
            ? `#${new THREE.Color(nebulaConfig.primaryColor).getHexString()}`
            : NEBULA_PALETTES[0].c1,
          label: "Primary Color",
        },
        secondaryColor: {
          value: nebulaConfig?.secondaryColor
            ? `#${new THREE.Color(nebulaConfig.secondaryColor).getHexString()}`
            : NEBULA_PALETTES[0].c2,
          label: "Secondary Color",
        },
        domainScale: {
          value: nebulaConfig?.domainScale ?? 1,
          min: 0.1,
          max: 3,
          step: 0.1,
          label: "Domain Scale",
        },
        iterPrimary: {
          value: nebulaConfig?.iterPrimary ?? 23,
          min: 1,
          max: 50,
          step: 0.1,
          label: "Primary Iterations",
        },
        iterSecondary: {
          value: nebulaConfig?.iterSecondary ?? 5,
          min: 0,
          max: 50,
          step: 1,
          label: "Secondary Iterations",
        },
      },
      { collapsed: true }
    ),
  })

  // Create shader material with uniforms from controls
  const material = useMemo(() => {
    // Convert hex colors to THREE.Color
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
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    })
  }, [size, controls])

  // Fix sphere to camera position so it doesn't move when zooming/dollying
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
      renderOrder={-999}
      layers={LAYERS.BACKGROUND}
    >
      <sphereGeometry args={[100, 64, 64]} />
    </mesh>
  )
}

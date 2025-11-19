import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useAsyncNoiseTexture } from "@/hooks/useAsyncNoiseTexture"
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
        noiseResolution: {
          value: nebulaConfig?.noiseResolution ?? 512,
          options: {
            "Low (128)": 128,
            "Medium (256)": 256,
            "High (512)": 512,
          },
          label: "Noise Quality",
        },
        intensity: {
          value: nebulaConfig?.intensity ?? 0.8,
          min: 0,
          max: 1,
          step: 0.1,
          label: "Intensity",
        },
        speed: {
          value: nebulaConfig?.speed ?? 0,
          min: 0,
          max: 0.01,
          step: 0.0001,
          label: "Animation Speed",
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
          value: nebulaConfig?.domainScale ?? 1.3,
          min: 0.1,
          max: 3,
          step: 0.1,
          label: "Domain Scale",
        },
        iterPrimary: {
          value: nebulaConfig?.iterPrimary ?? 23,
          min: 1,
          max: 50,
          step: 1,
          label: "Primary Iterations",
        },
        iterSecondary: {
          value: nebulaConfig?.iterSecondary ?? 5,
          min: 1,
          max: 50,
          step: 1,
          label: "Secondary Iterations",
        },
        parallaxAmount: {
          value: nebulaConfig?.parallaxAmount ?? 1.0,
          min: 0,
          max: 2,
          step: 0.1,
          label: "Parallax Amount",
        },
        noiseUse: {
          value: nebulaConfig?.noiseUse ?? 1.0,
          min: 0,
          max: 1,
          step: 1,
          label: "Noise Use",
        },
      },
      { collapsed: true }
    ),
  })

  // Load noise texture asynchronously
  const noiseTexture = useAsyncNoiseTexture(controls.noiseResolution)

  // Create shader material with uniforms from controls
  const material = useMemo(() => {
    // Convert hex colors to THREE.Color
    const colorObj = new THREE.Color(controls.color)
    const primaryColorObj = new THREE.Color(controls.primaryColor)
    const secondaryColorObj = new THREE.Color(controls.secondaryColor)

    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        resolution: {
          value: new THREE.Vector2(size.width, size.height),
        },
        cameraRotation: { value: new THREE.Vector3(0, 0, 0) },
        parallaxAmount: { value: controls.parallaxAmount },
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
        speed: { value: controls.speed },
        iterPrimary: { value: controls.iterPrimary },
        iterSecondary: { value: controls.iterSecondary },
        domainScale: { value: controls.domainScale },
        noiseTexture: { value: noiseTexture },
        noiseUse: { value: controls.noiseUse },
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  }, [noiseTexture, size, controls])

  // Update time and camera rotation uniforms
  useFrame((state) => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.ShaderMaterial

    // Only update time if speed > 0
    if (controls.speed > 0) {
      mat.uniforms.time.value = state.clock.elapsedTime
    }

    // Always update camera rotation for parallax when camera moves
    mat.uniforms.cameraRotation.value.set(
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z
    )
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
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}

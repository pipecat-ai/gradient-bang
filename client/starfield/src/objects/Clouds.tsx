import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useAsyncNoiseTexture } from "@/hooks/useAsyncNoiseTexture"
import {
  nebulaFragmentShader,
  nebulaVertexShader,
} from "@/shaders/NebulaShader"
import { useGameStore } from "@/useGameStore"

export interface NebulaPalette {
  name: string
  c1: { r: number; g: number; b: number }
  c2: { r: number; g: number; b: number }
  mid: { r: number; g: number; b: number }
}

export const NEBULA_PALETTES: readonly NebulaPalette[] = [
  {
    name: "tealOrange",
    c1: { r: 0.1, g: 0.65, b: 0.7 },
    c2: { r: 0.98, g: 0.58, b: 0.2 },
    mid: { r: 0.8, g: 0.75, b: 0.65 },
  },
  {
    name: "magentaGreen",
    c1: { r: 0.75, g: 0.15, b: 0.75 },
    c2: { r: 0.2, g: 0.85, b: 0.45 },
    mid: { r: 0.6, g: 0.55, b: 0.7 },
  },
  {
    name: "blueGold",
    c1: { r: 0.15, g: 0.35, b: 0.95 },
    c2: { r: 0.95, g: 0.78, b: 0.25 },
    mid: { r: 0.7, g: 0.72, b: 0.8 },
  },
  {
    name: "cyanRed",
    c1: { r: 0.1, g: 0.85, b: 0.9 },
    c2: { r: 0.9, g: 0.2, b: 0.25 },
    mid: { r: 0.75, g: 0.65, b: 0.7 },
  },
  {
    name: "violetAmber",
    c1: { r: 0.55, g: 0.25, b: 0.85 },
    c2: { r: 0.98, g: 0.7, b: 0.2 },
    mid: { r: 0.8, g: 0.7, b: 0.85 },
  },
  {
    name: "emeraldRose",
    c1: { r: 0.1, g: 0.75, b: 0.5 },
    c2: { r: 0.95, g: 0.45, b: 0.6 },
    mid: { r: 0.7, g: 0.75, b: 0.75 },
  },
  {
    name: "indigoPeach",
    c1: { r: 0.2, g: 0.25, b: 0.7 },
    c2: { r: 1.0, g: 0.7, b: 0.55 },
    mid: { r: 0.75, g: 0.7, b: 0.8 },
  },
  {
    name: "mintCoral",
    c1: { r: 0.5, g: 0.95, b: 0.8 },
    c2: { r: 1.0, g: 0.45, b: 0.45 },
    mid: { r: 0.85, g: 0.8, b: 0.8 },
  },
] as const

/**
 * Nebula background effect component
 * Renders a procedurally generated nebula using custom shaders
 * All parameters controlled via Leva for live tweaking
 */
export const Nebula = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const { gl, camera } = useThree()
  const { nebula: nebulaConfig } = useGameStore(
    (state) => state.starfieldConfig
  )

  const [uNebula] = useControls(() => ({
    "Nebula Settings": folder({
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
        value: nebulaConfig?.intensity ?? 0.6,
        min: 0,
        max: 5,
        step: 0.1,
        label: "Intensity",
      },
      speed: {
        value: nebulaConfig?.speed ?? 0,
        min: 0,
        max: 1,
        step: 0.001,
        label: "Animation Speed",
      },
      primaryColor: {
        value:
          nebulaConfig?.primaryColor ??
          `#${new THREE.Color(NEBULA_PALETTES[0].c1.r, NEBULA_PALETTES[0].c1.g, NEBULA_PALETTES[0].c1.b).getHexString()}`,
        label: "Primary Color",
      },
      midColor: {
        value:
          nebulaConfig?.midColor ??
          `#${new THREE.Color(NEBULA_PALETTES[0].mid.r, NEBULA_PALETTES[0].mid.g, NEBULA_PALETTES[0].mid.b).getHexString()}`,
        label: "Mid Color",
      },
      secondaryColor: {
        value:
          nebulaConfig?.secondaryColor ??
          `#${new THREE.Color(NEBULA_PALETTES[0].c2.r, NEBULA_PALETTES[0].c2.g, NEBULA_PALETTES[0].c2.b).getHexString()}`,
        label: "Secondary Color",
      },
      domainScale: {
        value: nebulaConfig?.domainScale ?? 1.0,
        min: 0.1,
        max: 3,
        step: 0.1,
        label: "Domain Scale",
      },
      iterPrimary: {
        value: nebulaConfig?.iterPrimary ?? 6,
        min: 1,
        max: 10,
        step: 1,
        label: "Primary Iterations",
      },
      iterSecondary: {
        value: nebulaConfig?.iterSecondary ?? 4,
        min: 1,
        max: 10,
        step: 1,
        label: "Secondary Iterations",
      },
      parallaxAmount: {
        value: nebulaConfig?.parallaxAmount ?? 0.5,
        min: 0,
        max: 2,
        step: 0.1,
        label: "Parallax Amount",
      },
    }),
  }))

  // Load noise texture asynchronously (will suspend on first load)
  const noiseTexture = useAsyncNoiseTexture(uNebula?.noiseResolution ?? 512)

  // Create shader material with all uniforms
  const material = useMemo(() => {
    const primaryColorObj = new THREE.Color(uNebula.primaryColor)
    const midColorObj = new THREE.Color(uNebula.midColor)
    const secondaryColorObj = new THREE.Color(uNebula.secondaryColor)

    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        shakePhase: { value: 0 },
        resolution: {
          value: new THREE.Vector2(gl.domElement.width, gl.domElement.height),
        },
        cameraRotation: { value: new THREE.Vector3(0, 0, 0) },
        parallaxAmount: { value: uNebula.parallaxAmount },
        intensity: { value: uNebula.intensity },
        nebulaColorPrimary: {
          value: new THREE.Vector3(
            primaryColorObj.r,
            primaryColorObj.g,
            primaryColorObj.b
          ),
        },
        nebulaColorMid: {
          value: new THREE.Vector3(midColorObj.r, midColorObj.g, midColorObj.b),
        },
        nebulaColorSecondary: {
          value: new THREE.Vector3(
            secondaryColorObj.r,
            secondaryColorObj.g,
            secondaryColorObj.b
          ),
        },
        speed: { value: uNebula.speed },
        iterPrimary: { value: uNebula.iterPrimary },
        iterSecondary: { value: uNebula.iterSecondary },
        domainScale: { value: uNebula.domainScale },
        shakeWarpIntensity: { value: 0 },
        shakeWarpRampTime: { value: 1 },
        nebulaShakeProgress: { value: 0 },
        noiseTexture: { value: noiseTexture },
        noiseUse: { value: 1.0 },
        shadowCenter: { value: new THREE.Vector2(0.5, 0.5) },
        shadowRadius: { value: 0 },
        shadowSoftness: { value: 0 },
        shadowStrength: { value: 0 },
        noiseReduction: { value: 0.05 },
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  }, [noiseTexture, gl, uNebula])

  // Update uniforms when controls change
  /* useEffect(() => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.ShaderMaterial

    mat.uniforms.intensity.value = intensity
    mat.uniforms.speed.value = speed
    mat.uniforms.domainScale.value = domainScale
    mat.uniforms.iterPrimary.value = iterPrimary
    mat.uniforms.iterSecondary.value = iterSecondary
    mat.uniforms.parallaxAmount.value = parallaxAmount

    const primaryColorObj = new THREE.Color(primaryColor)
    mat.uniforms.nebulaColorPrimary.value.set(
      primaryColorObj.r,
      primaryColorObj.g,
      primaryColorObj.b
    )

    const secondaryColorObj = new THREE.Color(secondaryColor)
    mat.uniforms.nebulaColorSecondary.value.set(
      secondaryColorObj.r,
      secondaryColorObj.g,
      secondaryColorObj.b
    )
  }, [
    intensity,
    speed,
    primaryColor,
    secondaryColor,
    domainScale,
    iterPrimary,
    iterSecondary,
    parallaxAmount,
  ])*/

  // Handle window resize
  /*useEffect(() => {
    const handleResize = () => {
      if (!meshRef.current) return
      const mat = meshRef.current.material as THREE.ShaderMaterial
      mat.uniforms.resolution.value.set(
        gl.domElement.width,
        gl.domElement.height
      )
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [gl])*/

  // Animate time uniform and update camera rotation for parallax
  useFrame((state) => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.ShaderMaterial

    // Only update time if speed > 0 AND we're in continuous rendering mode
    // This prevents animation in demand mode (when nothing is happening)
    if (uNebula.speed > 0) {
      // && isContinuous()) {
      mat.uniforms.time.value = state.clock.elapsedTime
    }

    // Always update camera rotation for parallax when camera moves
    mat.uniforms.cameraRotation.value.set(
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z
    )
  })

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      material.dispose()
      // Note: noiseTexture is cached and managed by useAsyncNoiseTexture
      // so we don't dispose it here
    }
  }, [material])

  if (!uNebula.enabled) return null

  return (
    <mesh
      ref={meshRef}
      material={material}
      frustumCulled={false}
      renderOrder={-999}
    >
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}

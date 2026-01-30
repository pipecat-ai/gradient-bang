import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import {
  nebulaFragmentShader,
  nebulaVertexShader,
} from "@/shaders/NebulaShader"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

export const Nebula = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera, size } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { nebula: nebulaConfig } = starfieldConfig
  const registerUniform = useUniformStore((state) => state.registerUniform)
  const removeUniform = useUniformStore((state) => state.removeUniform)

  // Get active palette
  const palette = getPalette(starfieldConfig.palette)

  // Leva controls for all nebula uniforms with palette cascade
  const [controls, set] = useControls(() => ({
    Nebula: folder(
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
            : `#${palette.tint.getHexString()}`,
          label: "Global Tint",
        },
        primaryColor: {
          value: nebulaConfig?.primaryColor
            ? `#${new THREE.Color(nebulaConfig.primaryColor).getHexString()}`
            : `#${palette.c1.getHexString()}`,
          label: "Primary Color",
        },
        secondaryColor: {
          value: nebulaConfig?.secondaryColor
            ? `#${new THREE.Color(nebulaConfig.secondaryColor).getHexString()}`
            : `#${palette.c2.getHexString()}`,
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
        rotationX: {
          value: nebulaConfig?.rotation?.[0] ?? 0,
          min: -Math.PI,
          max: Math.PI,
          step: 0.01,
          label: "Rotation X",
        },
        rotationY: {
          value: nebulaConfig?.rotation?.[1] ?? 0,
          min: -Math.PI,
          max: Math.PI,
          step: 0.01,
          label: "Rotation Y",
        },
        rotationZ: {
          value: nebulaConfig?.rotation?.[2] ?? 0,
          min: -Math.PI,
          max: Math.PI,
          step: 0.01,
          label: "Rotation Z",
        },
        warpOffsetX: {
          value: -0.5,
          min: -2,
          max: 2,
          step: 0.01,
          label: "Warp Offset X",
        },
        warpOffsetY: {
          value: -0.4,
          min: -2,
          max: 2,
          step: 0.01,
          label: "Warp Offset Y",
        },
        warpOffsetZ: {
          value: -1.487,
          min: -3,
          max: 3,
          step: 0.001,
          label: "Warp Offset Z",
        },
        warpDecay: {
          value: nebulaConfig?.warpDecay ?? 5.0,
          min: 0.1,
          max: 20,
          step: 0.1,
          label: "Warp Decay",
        },
      },
      { collapsed: true }
    ),
  }))

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (
      !nebulaConfig?.color &&
      !nebulaConfig?.primaryColor &&
      !nebulaConfig?.secondaryColor
    ) {
      set({
        color: `#${palette.tint.getHexString()}`,
        primaryColor: `#${palette.c1.getHexString()}`,
        secondaryColor: `#${palette.c2.getHexString()}`,
      })
    }
  }, [starfieldConfig.palette, palette, nebulaConfig, set])

  // Sync nebula config changes to Leva controls (only set defined values, let Leva keep defaults)
  useEffect(() => {
    if (!nebulaConfig) return
    const updates: Record<string, number> = {}
    if (nebulaConfig.intensity !== undefined) updates.intensity = nebulaConfig.intensity
    if (nebulaConfig.domainScale !== undefined) updates.domainScale = nebulaConfig.domainScale
    if (nebulaConfig.iterPrimary !== undefined) updates.iterPrimary = nebulaConfig.iterPrimary
    if (nebulaConfig.iterSecondary !== undefined) updates.iterSecondary = nebulaConfig.iterSecondary
    if (nebulaConfig.warpDecay !== undefined) updates.warpDecay = nebulaConfig.warpDecay
    set(updates)
  }, [nebulaConfig, set])

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

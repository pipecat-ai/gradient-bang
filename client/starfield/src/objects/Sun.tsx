import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import { sunFragmentShader, sunVertexShader } from "@/shaders/SunShader"
import { useGameStore } from "@/useGameStore"
import { createValueNoiseTexture } from "@/utils/noise"

const sunNoiseTexture = createValueNoiseTexture(256)

export const Sun = () => {
  const groupRef = useRef<THREE.Group>(null)
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  const { camera } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { sun: sunConfig } = starfieldConfig

  // Get active palette
  const palette = getPalette(starfieldConfig.palette)

  // Leva controls for all sun parameters with palette cascade
  const [controls, set] = useControls(() => ({
    Sun: folder(
      {
        enabled: {
          value: sunConfig?.enabled ?? true,
          label: "Enable Sun",
        },
        scale: {
          value: sunConfig?.scale ?? 100,
          min: 1,
          max: 300,
          step: 1,
          label: "Size",
        },
        intensity: {
          value: sunConfig?.intensity ?? 1.2,
          min: 0,
          max: 3,
          step: 0.1,
          label: "Intensity",
        },
        coreColor: {
          value: sunConfig?.color
            ? `#${new THREE.Color(sunConfig.color).getHexString()}`
            : `#${palette.c1.getHexString()}`,
          label: "Core Color",
        },
        coronaColor: {
          value: sunConfig?.coronaColor
            ? `#${new THREE.Color(sunConfig.coronaColor).getHexString()}`
            : `#${palette.c2.getHexString()}`,
          label: "Corona Color",
        },
        positionX: {
          value: sunConfig?.position?.x ?? -40,
          min: -300,
          max: 300,
          step: 1,
          label: "Position X",
        },
        positionY: {
          value: sunConfig?.position?.y ?? 30,
          min: -300,
          max: 300,
          step: 1,
          label: "Position Y",
        },
        positionZ: {
          value: sunConfig?.position?.z ?? -80,
          min: -300,
          max: 300,
          step: 1,
          label: "Position Z",
        },
      },
      { collapsed: true }
    ),
  }))

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (!sunConfig?.color && !sunConfig?.coronaColor) {
      set({
        coreColor: `#${palette.c1.getHexString()}`,
        coronaColor: `#${palette.c2.getHexString()}`,
      })
    }
  }, [starfieldConfig.palette, palette, sunConfig, set])

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

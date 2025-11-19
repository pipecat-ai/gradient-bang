import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { sunFragmentShader, sunVertexShader } from "@/shaders/SunShader"
import { LAYERS } from "@/Starfield"
import { useGameStore } from "@/useGameStore"
import { createValueNoiseTexture } from "@/utils/noiseTexture"

const sunNoiseTexture = createValueNoiseTexture(256)

export const Sun = () => {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  const { sun: sunConfig } = useGameStore((state) => state.starfieldConfig)

  // Leva controls for all sun parameters
  const controls = useControls({
    "Sun Settings": folder(
      {
        enabled: {
          value: sunConfig?.enabled ?? true,
          label: "Enable Sun",
        },
        scale: {
          value: sunConfig?.scale ?? 100,
          min: 80,
          max: 200,
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
            : "#ffe8a3",
          label: "Core Color",
        },
        coronaColor: {
          value: sunConfig?.coronaColor
            ? `#${new THREE.Color(sunConfig.coronaColor).getHexString()}`
            : "#ff6b35",
          label: "Corona Color",
        },
        positionX: {
          value: sunConfig?.position?.x ?? -40,
          min: -100,
          max: 100,
          step: 1,
          label: "Position X",
        },
        positionY: {
          value: sunConfig?.position?.y ?? 30,
          min: -100,
          max: 100,
          step: 1,
          label: "Position Y",
        },
        positionZ: {
          value: sunConfig?.position?.z ?? -80,
          min: -150,
          max: 50,
          step: 1,
          label: "Position Z",
        },
        pulseSpeed: {
          value: sunConfig?.pulseSpeed ?? 0.5,
          min: 0,
          max: 5,
          step: 0.1,
          label: "Pulse Speed",
        },
        pulseIntensity: {
          value: sunConfig?.pulseIntensity ?? 0.1,
          min: 0,
          max: 0.5,
          step: 0.01,
          label: "Pulse Intensity",
        },
      },
      { collapsed: true }
    ),
  })

  // Create shader material for the sun
  const sunMaterial = useMemo(() => {
    const coreColorObj = new THREE.Color(controls.coreColor)
    const coronaColorObj = new THREE.Color(controls.coronaColor)

    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: controls.intensity },
        uPulseSpeed: { value: controls.pulseSpeed },
        uPulseIntensity: { value: controls.pulseIntensity },
        uCoreColor: {
          value: new THREE.Vector3(
            coreColorObj.r,
            coreColorObj.g,
            coreColorObj.b
          ),
        },
        uCoronaColor: {
          value: new THREE.Vector3(
            coronaColorObj.r,
            coronaColorObj.g,
            coronaColorObj.b
          ),
        },
        uScale: { value: controls.scale },
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
  }, [controls])

  // Update shader uniforms on each frame
  useFrame((state) => {
    if (!groupRef.current || !sunMaterial) return

    // Update time for animation
    sunMaterial.uniforms.uTime.value = state.clock.elapsedTime

    // Update camera position for shader
    sunMaterial.uniforms.uCameraPosition.value.copy(camera.position)

    // Update position relative to camera
    groupRef.current.position.set(
      camera.position.x + controls.positionX,
      camera.position.y + controls.positionY,
      camera.position.z + controls.positionZ
    )

    // Update dynamic uniforms if controls change
    sunMaterial.uniforms.uIntensity.value = controls.intensity
    sunMaterial.uniforms.uPulseSpeed.value = controls.pulseSpeed
    sunMaterial.uniforms.uPulseIntensity.value = controls.pulseIntensity
    sunMaterial.uniforms.uScale.value = controls.scale

    const coreColorObj = new THREE.Color(controls.coreColor)
    const coronaColorObj = new THREE.Color(controls.coronaColor)
    sunMaterial.uniforms.uCoreColor.value.set(
      coreColorObj.r,
      coreColorObj.g,
      coreColorObj.b
    )
    sunMaterial.uniforms.uCoronaColor.value.set(
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
        scale={[
          controls.scale * 2.5,
          controls.scale * 2.5,
          controls.scale * 2.5,
        ]}
      >
        <sphereGeometry args={[1, 32, 32]} />
        <primitive object={sunMaterial} attach="material" />
      </mesh>

      {/* Mid glow layer */}
      <mesh
        renderOrder={-99}
        layers={LAYERS.FOREGROUND}
        scale={[
          controls.scale * 1.5,
          controls.scale * 1.5,
          controls.scale * 1.5,
        ]}
      >
        <sphereGeometry args={[1, 32, 32]} />
        <primitive object={sunMaterial} attach="material" />
      </mesh>

      {/* Core layer - brightest, smallest */}
      <mesh
        renderOrder={-98}
        layers={LAYERS.FOREGROUND}
        scale={[controls.scale, controls.scale, controls.scale]}
      >
        <sphereGeometry args={[1, 32, 32]} />
        <primitive object={sunMaterial} attach="material" />
      </mesh>
    </group>
  )
}

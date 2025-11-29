import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useAnimationRuntime } from "@/animations/runtime"
import { useTunnelAnimationSpring } from "@/animations/tunnel"
import { LAYERS } from "@/constants"
import {
  tunnelFragmentShader,
  tunnelVertexShader,
} from "@/shaders/TunnelShader"
import { useGameStore } from "@/useGameStore"

export const Tunnel = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const rotationAngleRef = useRef(0)
  const { camera, size } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { tunnel: tunnelConfig } = starfieldConfig
  const isSceneChanging = useGameStore((state) => state.isSceneChanging)

  // Animation spring for tunnel effect
  const runtime = useAnimationRuntime()
  const { tunnelOpacity, tunnelDepth, tunnelRotationSpeed } =
    useTunnelAnimationSpring(runtime)

  // Leva controls for all tunnel uniforms
  const [controls] = useControls(() => ({
    Tunnel: folder(
      {
        enabled: {
          value: tunnelConfig?.enabled ?? false,
          label: "Enable Tunnel (Manual)",
        },
        speed: {
          value: tunnelConfig?.speed ?? 0.5,
          min: 0,
          max: 10,
          step: 0.1,
          label: "Speed",
        },
        rotationSpeed: {
          value: tunnelConfig?.rotationSpeed ?? 0,
          min: 0,
          max: 2,
          step: 0.05,
          label: "Rotation Speed",
        },
        tunnelDepth: {
          value: tunnelConfig?.tunnelDepth ?? 0.15,
          min: 0.01,
          max: 0.5,
          step: 0.01,
          label: "Tunnel Depth",
        },
        color: {
          value: tunnelConfig?.color
            ? `#${new THREE.Color(tunnelConfig.color).getHexString()}`
            : "#2667e6",
          label: "Tunnel Color",
        },
        blendMode: {
          value: tunnelConfig?.blendMode ?? "additive",
          options: ["additive", "normal", "multiply", "screen"],
          label: "Blend Mode",
        },
        noiseAnimationSpeed: {
          value: tunnelConfig?.noiseAnimationSpeed ?? 0,
          min: 0,
          max: 1,
          step: 0.01,
          label: "Noise Animation Speed",
        },
        opacity: {
          value: tunnelConfig?.opacity ?? 1.0,
          min: 0,
          max: 1,
          step: 0.05,
          label: "Opacity",
        },
        contrast: {
          value: tunnelConfig?.contrast ?? 1.0,
          min: 0.5,
          max: 3.0,
          step: 0.1,
          label: "Contrast/Harshness",
        },
        enableWhiteout: {
          value: tunnelConfig?.enableWhiteout ?? false,
          label: "Enable Whiteout",
        },
        whiteoutPeriod: {
          value: tunnelConfig?.whiteoutPeriod ?? 4.0,
          min: 1,
          max: 10,
          step: 0.5,
          label: "Whiteout Period (s)",
        },
      },
      { collapsed: true }
    ),
  }))

  // Map blend mode string to THREE.js constant
  const getBlendMode = (mode: string) => {
    switch (mode) {
      case "normal":
        return THREE.NormalBlending
      case "additive":
        return THREE.AdditiveBlending
      case "multiply":
        return THREE.MultiplyBlending
      case "screen":
        return THREE.CustomBlending
      default:
        return THREE.AdditiveBlending
    }
  }

  // Create shader material with uniforms from controls
  const material = useMemo(() => {
    const colorObj = new THREE.Color(controls.color)

    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        resolution: {
          value: new THREE.Vector2(size.width, size.height),
        },
        speed: { value: controls.speed },
        rotationSpeed: { value: controls.rotationSpeed },
        rotationAngle: { value: 0 },
        tunnelDepth: { value: controls.tunnelDepth },
        tunnelColor: {
          value: new THREE.Vector3(colorObj.r, colorObj.g, colorObj.b),
        },
        enableWhiteout: { value: controls.enableWhiteout },
        whiteoutPeriod: { value: controls.whiteoutPeriod },
        noiseAnimationSpeed: { value: controls.noiseAnimationSpeed },
        opacity: { value: controls.opacity },
        contrast: { value: controls.contrast },
      },
      vertexShader: tunnelVertexShader,
      fragmentShader: tunnelFragmentShader,
      side: THREE.BackSide,
      blending: getBlendMode(controls.blendMode),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
  }, [size, controls])

  // Update time uniform and sync material uniforms
  useFrame((state, delta) => {
    if (!meshRef.current) return

    const mat = meshRef.current.material as THREE.ShaderMaterial
    if (mat.uniforms) {
      mat.uniforms.uTime.value = state.clock.elapsedTime
      mat.uniforms.speed.value = controls.speed

      // Accumulate rotation angle based on current rotation speed and delta time
      let currentRotationSpeed: number
      if (controls.enabled) {
        // Manual mode: use control values
        mat.uniforms.tunnelDepth.value = controls.tunnelDepth
        mat.uniforms.opacity.value = controls.opacity
        currentRotationSpeed = controls.rotationSpeed
      } else {
        // Animation mode: always use animated values
        mat.uniforms.tunnelDepth.value = tunnelDepth.get()
        mat.uniforms.opacity.value = tunnelOpacity.get()
        currentRotationSpeed = tunnelRotationSpeed.get()
      }

      // Accumulate rotation angle over time (instead of multiplying by uTime)
      rotationAngleRef.current += currentRotationSpeed * delta
      mat.uniforms.rotationAngle.value = rotationAngleRef.current

      mat.uniforms.enableWhiteout.value = controls.enableWhiteout
      mat.uniforms.whiteoutPeriod.value = controls.whiteoutPeriod
      mat.uniforms.noiseAnimationSpeed.value = controls.noiseAnimationSpeed
      mat.uniforms.contrast.value = controls.contrast

      const colorObj = new THREE.Color(controls.color)
      mat.uniforms.tunnelColor.value.set(colorObj.r, colorObj.g, colorObj.b)
    }

    // Update blend mode if changed
    mat.blending = getBlendMode(controls.blendMode)

    // Fix sphere to camera position
    meshRef.current.position.copy(camera.position)
  })

  // Show tunnel if manually enabled OR if animation is active (opacity > 0)
  const currentOpacity = tunnelOpacity.get()
  const shouldRender = controls.enabled || currentOpacity > 0 || isSceneChanging

  if (!shouldRender) return null

  return (
    <mesh
      ref={meshRef}
      material={material}
      frustumCulled={false}
      layers={LAYERS.SKYBOX}
      renderOrder={-998}
    >
      <sphereGeometry args={[100, 64, 64]} />
    </mesh>
  )
}

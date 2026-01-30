import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { LAYERS } from "@/constants"
import {
  tunnelFragmentShader,
  tunnelVertexShader,
} from "@/shaders/TunnelShader"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

export const Tunnel = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const rotationAngleRef = useRef(0)
  const { camera, invalidate } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { tunnel: tunnelConfig } = starfieldConfig
  const registerUniform = useUniformStore((state) => state.registerUniform)
  const removeUniform = useUniformStore((state) => state.removeUniform)

  const [controls] = useControls(() => ({
    Tunnel: folder(
      {
        enabled: {
          value: tunnelConfig?.enabled ?? false,
          label: "Always Show (Manual)",
        },
        showDuringWarp: {
          value: tunnelConfig?.showDuringWarp ?? true,
          label: "Show During Warp",
        },
        speed: {
          value: tunnelConfig?.speed ?? 1,
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
          value: tunnelConfig?.tunnelDepth ?? 0.4,
          min: 0.01,
          max: 0.5,
          step: 0.01,
          label: "Tunnel Depth",
        },
        color: {
          value: tunnelConfig?.color
            ? `#${new THREE.Color(tunnelConfig.color).getHexString()}`
            : "#FFFFFF",
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
          value: tunnelConfig?.opacity ?? 0,
          min: 0,
          max: 1,
          step: 0.05,
          label: "Opacity",
        },
        contrast: {
          value: tunnelConfig?.contrast ?? 3,
          min: 0.0,
          max: 3.0,
          step: 0.1,
          label: "Contrast/Harshness",
        },
        centerHole: {
          value: tunnelConfig?.centerHole ?? 10.0,
          min: 0.0,
          max: 20.0,
          step: 0.1,
          label: "Center Hole",
        },
        centerSoftness: {
          value: tunnelConfig?.centerSoftness ?? 0.5,
          min: 0.0,
          max: 1.0,
          step: 0.05,
          label: "Center Softness",
        },
        pixelation: {
          value: tunnelConfig?.pixelation ?? 4,
          min: 0,
          max: 50,
          step: 1,
          label: "Pixelation",
        },
        followCamera: {
          value: true,
          label: "Follow Camera",
        },
      },
      { collapsed: true }
    ),
  }))

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

  const material = useMemo(() => {
    const colorObj = new THREE.Color(controls.color)

    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        speed: { value: controls.speed },
        rotationSpeed: { value: controls.rotationSpeed },
        rotationAngle: { value: 0 },
        tunnelDepth: { value: controls.tunnelDepth },
        tunnelColor: {
          value: new THREE.Vector3(colorObj.r, colorObj.g, colorObj.b),
        },
        noiseAnimationSpeed: { value: controls.noiseAnimationSpeed },
        opacity: { value: controls.opacity },
        contrast: { value: controls.contrast },
        centerHole: { value: controls.centerHole },
        centerSoftness: { value: controls.centerSoftness },
        pixelation: { value: controls.pixelation },
        followCamera: { value: controls.followCamera },
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
  }, [controls])

  // Register animated uniforms with the uniform registry
  useEffect(() => {
    const mat = material
    if (!mat.uniforms) return

    // Register the uniforms that can be animated during warp
    registerUniform("tunnelOpacity", mat.uniforms.opacity, {
      initial: controls.opacity,
      meta: { effect: "tunnel" },
    })
    registerUniform("tunnelContrast", mat.uniforms.contrast, {
      initial: controls.contrast,
      meta: { effect: "tunnel" },
    })
    registerUniform("tunnelCenterHole", mat.uniforms.centerHole, {
      initial: controls.centerHole,
      meta: { effect: "tunnel" },
    })
    registerUniform("tunnelCenterSoftness", mat.uniforms.centerSoftness, {
      initial: controls.centerSoftness,
      meta: { effect: "tunnel" },
    })
    registerUniform("tunnelRotationSpeed", mat.uniforms.rotationSpeed, {
      initial: controls.rotationSpeed,
      meta: { effect: "tunnel" },
    })

    return () => {
      removeUniform("tunnelOpacity")
      removeUniform("tunnelContrast")
      removeUniform("tunnelCenterHole")
      removeUniform("tunnelCenterSoftness")
      removeUniform("tunnelRotationSpeed")
    }
  }, [
    material,
    controls.opacity,
    controls.contrast,
    controls.centerHole,
    controls.centerSoftness,
    controls.rotationSpeed,
    registerUniform,
    removeUniform,
  ])

  useFrame((state, delta) => {
    if (!meshRef.current) return

    const mat = meshRef.current.material as THREE.ShaderMaterial
    if (!mat.uniforms) return

    // Update time
    mat.uniforms.uTime.value = state.clock.elapsedTime

    // Update speed and depth from controls
    mat.uniforms.speed.value = controls.speed
    mat.uniforms.tunnelDepth.value = controls.tunnelDepth

    // Update rotation angle based on current rotationSpeed uniform value
    // (rotationSpeed may be animated externally via the uniform registry)
    rotationAngleRef.current += mat.uniforms.rotationSpeed.value * delta
    mat.uniforms.rotationAngle.value = rotationAngleRef.current

    // Update other control values
    mat.uniforms.noiseAnimationSpeed.value = controls.noiseAnimationSpeed
    mat.uniforms.followCamera.value = controls.followCamera
    mat.uniforms.pixelation.value = controls.pixelation

    const colorObj = new THREE.Color(controls.color)
    mat.uniforms.tunnelColor.value.set(colorObj.r, colorObj.g, colorObj.b)

    mat.blending = getBlendMode(controls.blendMode)
    meshRef.current.position.copy(camera.position)

    // Keep rendering while tunnel is visible (opacity > 0)
    if (mat.uniforms.opacity.value > 0) {
      invalidate()
    }
  })

  // Always mount and render the mesh to pre-compile the shader
  // Visibility is handled via opacity in useFrame (0 when not active)
  // This prevents frame drops from shader compilation when warp starts
  return (
    <mesh
      ref={meshRef}
      material={material}
      frustumCulled={false}
      layers={LAYERS.OVERLAY}
      renderOrder={999}
    >
      <sphereGeometry args={[100, 16, 16]} />
    </mesh>
  )
}

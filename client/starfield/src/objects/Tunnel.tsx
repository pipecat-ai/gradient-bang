import { useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { LAYERS } from "@/constants"
import {
  tunnelFragmentShader,
  tunnelVertexShader,
} from "@/shaders/TunnelShader"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"

export const Tunnel = () => {
  const meshRef = useRef<THREE.Mesh>(null)
  const rotationAngleRef = useRef(0)
  const progressRef = useRef(0) // 0-1 animation progress
  const [isVisible, setIsVisible] = useState(false)
  const { camera, invalidate } = useThree()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const {
    tunnel: tunnelConfig,
    hyperspaceEnterTime = 1000,
    hyperspaceExitTime = 1000,
  } = starfieldConfig

  const isWarping = useAnimationStore((state) => state.isWarping)

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
          value: tunnelConfig?.rotationSpeed ?? 0.1,
          min: 0,
          max: 2,
          step: 0.05,
          label: "Rotation Speed",
        },
        tunnelDepth: {
          value: tunnelConfig?.tunnelDepth ?? 0.1,
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
          value: tunnelConfig?.opacity ?? 1,
          min: 0,
          max: 1,
          step: 0.05,
          label: "Opacity",
        },
        contrast: {
          value: tunnelConfig?.contrast ?? 0.4,
          min: 0.0,
          max: 3.0,
          step: 0.1,
          label: "Contrast/Harshness",
        },
        centerHole: {
          value: tunnelConfig?.centerHole ?? 12.0,
          min: 0.0,
          max: 20.0,
          step: 0.1,
          label: "Center Hole",
        },
        centerSoftness: {
          value: tunnelConfig?.centerSoftness ?? 1,
          min: 0.0,
          max: 1.0,
          step: 0.05,
          label: "Center Softness",
        },
        pixelation: {
          value: tunnelConfig?.pixelation ?? 25,
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

  useFrame((state, delta) => {
    if (!meshRef.current) return

    // Update progress: fade in when warping, fade out when not
    const enterDuration = hyperspaceEnterTime / 1000
    const exitDuration = (hyperspaceExitTime * 2) / 1000

    if (isWarping) {
      progressRef.current = Math.min(
        1,
        progressRef.current + delta / enterDuration
      )
    } else if (progressRef.current > 0) {
      progressRef.current = Math.max(
        0,
        progressRef.current - delta / exitDuration
      )
    }

    const progress = progressRef.current
    const isActive = progress > 0

    // Update visibility state (only when it changes to avoid re-renders)
    if (isActive !== isVisible) {
      setIsVisible(isActive)
    }

    const mat = meshRef.current.material as THREE.ShaderMaterial

    // Always update opacity to ensure shader compiles and stays warm
    // When not active, opacity will be 0 so it's effectively invisible
    if (!controls.enabled && (!controls.showDuringWarp || !isActive)) {
      if (mat.uniforms) {
        mat.uniforms.opacity.value = 0
      }
      return
    }
    if (mat.uniforms) {
      mat.uniforms.uTime.value = state.clock.elapsedTime

      mat.uniforms.speed.value = controls.speed

      // tunnelDepth stays constant (animating it causes noise flicker)
      mat.uniforms.tunnelDepth.value = controls.tunnelDepth

      if (controls.enabled) {
        // Manual mode - use control values directly
        mat.uniforms.opacity.value = controls.opacity
        mat.uniforms.contrast.value = controls.contrast
        mat.uniforms.centerHole.value = controls.centerHole
        mat.uniforms.centerSoftness.value = controls.centerSoftness
      } else {
        // Animate values with progress
        mat.uniforms.opacity.value = controls.opacity * progress
        mat.uniforms.contrast.value = THREE.MathUtils.lerp(
          0.1,
          controls.contrast,
          progress
        )
        mat.uniforms.centerHole.value = THREE.MathUtils.lerp(
          controls.centerHole,
          6,
          progress
        )
        mat.uniforms.centerSoftness.value = THREE.MathUtils.lerp(
          controls.centerSoftness,
          0.5,
          progress
        )
      }

      const rotationSpeed = controls.enabled
        ? controls.rotationSpeed
        : controls.rotationSpeed * progress
      rotationAngleRef.current += rotationSpeed * delta
      mat.uniforms.rotationAngle.value = rotationAngleRef.current

      mat.uniforms.noiseAnimationSpeed.value = controls.noiseAnimationSpeed
      mat.uniforms.followCamera.value = controls.followCamera
      mat.uniforms.pixelation.value = controls.pixelation

      const colorObj = new THREE.Color(controls.color)
      mat.uniforms.tunnelColor.value.set(colorObj.r, colorObj.g, colorObj.b)
    }

    mat.blending = getBlendMode(controls.blendMode)
    meshRef.current.position.copy(camera.position)

    // Keep rendering while active
    if (isActive) {
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

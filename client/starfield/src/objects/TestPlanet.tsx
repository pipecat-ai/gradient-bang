import { forwardRef, useRef, type JSX } from "react"
import { animated, type AnimatedProps } from "@react-spring/three"
import { shaderMaterial } from "@react-three/drei"
import { extend, invalidate, useFrame } from "@react-three/fiber"
import * as THREE from "three"

import { useWarpAnimation } from "@/hooks/animations"

// Define the uniform types
type PlanetMaterialUniforms = {
  uTime?: number
  uWarpProgress?: number
  uGlowIntensity?: number
  uDistortion?: number
  uBaseColor?: THREE.Color
  uGlowColor?: THREE.Color
}

// Create the shader material with proper typing
const PlanetMaterialImpl = shaderMaterial(
  {
    uTime: 0,
    uWarpProgress: 0,
    uGlowIntensity: 1,
    uDistortion: 0,
    uBaseColor: new THREE.Color(0x4466ff),
    uGlowColor: new THREE.Color(0x00ffff),
  },
  // Vertex shader
  `
    uniform float uTime;
    uniform float uWarpProgress;
    uniform float uDistortion;
    varying vec2 vUv;
    varying vec3 vNormal;
    
    void main() {
      vUv = uv;
      vNormal = normal;
      
      vec3 pos = position;
      
      float warpEffect = sin(position.x * 3.0 + uTime * 2.0) * uWarpProgress * uDistortion;
      pos.z += warpEffect * 0.3;
      pos.y += sin(position.y * 2.0 + uTime) * uWarpProgress * uDistortion * 0.2;
      
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `,
  // Fragment shader
  `
    uniform float uWarpProgress;
    uniform float uGlowIntensity;
    uniform vec3 uBaseColor;
    uniform vec3 uGlowColor;
    varying vec2 vUv;
    varying vec3 vNormal;
    
    void main() {
      vec3 color = uBaseColor;
      
      float fresnel = pow(1.0 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
      color += uGlowColor * fresnel * uGlowIntensity * uWarpProgress;
      
      float energyLines = sin(vUv.y * 30.0 - uWarpProgress * 10.0) * 0.5 + 0.5;
      color += uGlowColor * energyLines * uWarpProgress * 0.3;
      
      gl_FragColor = vec4(color, 1.0);
    }
  `
)

// Extend it
extend({ PlanetMaterial: PlanetMaterialImpl })

type PlanetMaterialProps = AnimatedProps<
  PlanetMaterialUniforms & JSX.IntrinsicElements["shaderMaterial"]
>

const PlanetMaterial = forwardRef<THREE.ShaderMaterial, PlanetMaterialProps>(
  (props, ref) => <planetMaterial ref={ref} {...props} />
)

const AnimatedPlanetMaterial = animated(PlanetMaterial)

declare module "@react-three/fiber" {
  interface ThreeElements {
    planetMaterial: PlanetMaterialProps
  }
}

export function TestPlanet() {
  const meshRef = useRef<THREE.Mesh>(null)
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const animation = useWarpAnimation()

  useFrame((state, delta) => {
    if (animation.isWarping || animation.isAnimating) {
      invalidate()
    }
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime
    }
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * animation.rotationSpeed.get()
      meshRef.current.rotation.x += delta * 0.1
    }
  })

  return (
    <animated.mesh ref={meshRef} scale={animation.scale}>
      <sphereGeometry args={[2, 64, 64]} />
      <AnimatedPlanetMaterial
        ref={materialRef}
        uWarpProgress={animation.warpProgress}
        uGlowIntensity={animation.glowIntensity}
        uDistortion={animation.distortion}
      />
    </animated.mesh>
  )
}

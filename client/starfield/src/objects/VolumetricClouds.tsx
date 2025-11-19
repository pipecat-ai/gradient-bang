import { useCallback, useEffect, useMemo, useRef } from "react"
import { Points } from "@react-three/drei"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useGameStore } from "@/useGameStore"
import { seededRandom } from "@/utils/math"

// Helper function to create soft radial gradient texture for particles
function createRadialGradientTexture() {
  const size = 64
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")!

  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  )
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)")
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.4)")
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)")

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)

  const texture = new THREE.CanvasTexture(canvas)
  return texture
}

export const VolumetricClouds = () => {
  const { volumetricClouds: cloudsConfig } = useGameStore(
    (state) => state.starfieldConfig
  )
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const materialRef = useRef<THREE.PointsMaterial>(null)

  const [
    { count, radius, size, opacity, color, blendMode, minDistance, fadeRange },
  ] = useControls(() => ({
    "Volumetric Clouds": folder(
      {
        enabled: {
          value: cloudsConfig?.enabled ?? true,
          onChange: (value: boolean) => {
            setStarfieldConfig({ volumetricClouds: { enabled: value } })
          },
        },
        count: {
          value: cloudsConfig?.count ?? 500,
          min: 50,
          max: 2000,
          step: 50,
          label: "Count",
        },
        radius: {
          value: cloudsConfig?.radius ?? 80,
          min: 20,
          max: 500,
          step: 5,
          label: "Radius",
        },
        size: {
          value: cloudsConfig?.size ?? 15,
          min: 1,
          max: 50,
          step: 0.5,
          label: "Size",
        },
        opacity: {
          value: cloudsConfig?.opacity ?? 0.2,
          min: 0,
          max: 1,
          step: 0.01,
          label: "Opacity",
        },
        color: {
          value: cloudsConfig?.color ?? "#88aaff",
          label: "Color",
        },
        blendMode: {
          value: cloudsConfig?.blendMode ?? "additive",
          options: {
            Additive: "additive",
            Normal: "normal",
          },
          label: "Blend Mode",
        },
        minDistance: {
          value: cloudsConfig?.minDistance ?? 2.0,
          min: 0,
          max: 20,
          step: 0.5,
          label: "Min Distance",
        },
        fadeRange: {
          value: cloudsConfig?.fadeRange ?? 5.0,
          min: 0.1,
          max: 20,
          step: 0.1,
          label: "Fade Range",
        },
      },
      {
        collapsed: true,
      }
    ),
  }))

  useEffect(() => {
    if (materialRef.current && materialRef.current.userData.shader) {
      const shader = materialRef.current.userData.shader
      shader.uniforms.minDistance.value = minDistance
      shader.uniforms.fadeRange.value = fadeRange
    }
  }, [minDistance, fadeRange])

  // Generate random positions within a sphere with cloud-like clustering
  const positions = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const random = seededRandom(count * radius * 137)

    for (let i = 0; i < count; i++) {
      // Generate clusters by using non-uniform distribution
      const clusterBias = Math.pow(random(), 0.7) // Bias toward center
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      const r = clusterBias * radius

      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta)
      const z = r * Math.cos(phi)

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }

    return positions
  }, [count, radius])

  // Create soft gradient texture for particles
  const particleTexture = useMemo(() => createRadialGradientTexture(), [])

  // Custom shader material for distance-based fade
  const handleBeforeCompile = useCallback(
    (shader: THREE.ShaderMaterial) => {
      // Store shader reference for updating uniforms later
      if (materialRef.current) {
        materialRef.current.userData.shader = shader
      }

      // Add custom uniforms
      shader.uniforms.minDistance = { value: minDistance }
      shader.uniforms.fadeRange = { value: fadeRange }

      // Add uniforms and varying declaration to vertex shader
      shader.vertexShader = `
      uniform float minDistance;
      uniform float fadeRange;
      varying float vDistanceFade;
      ${shader.vertexShader}
    `

      // Inject after the position is transformed
      shader.vertexShader = shader.vertexShader.replace(
        "gl_PointSize = size;",
        `
      gl_PointSize = size;
      
      // Calculate distance from camera to this particle using built-in cameraPosition
      vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      float dist = distance(cameraPosition, worldPos);
      vDistanceFade = smoothstep(minDistance, minDistance + fadeRange, dist);
      `
      )

      // Add varying declaration to fragment shader
      shader.fragmentShader = `
      varying float vDistanceFade;
      ${shader.fragmentShader}
    `

      // Apply the fade to the final alpha in fragment shader
      shader.fragmentShader = shader.fragmentShader.replace(
        "gl_FragColor = vec4( outgoingLight, diffuseColor.a );",
        "gl_FragColor = vec4( outgoingLight, diffuseColor.a * vDistanceFade );"
      )

      // Fallback: if replacement didn't work, try alternative
      if (!shader.fragmentShader.includes("* vDistanceFade")) {
        shader.fragmentShader = shader.fragmentShader.replace(
          /}(\s*)$/,
          `  gl_FragColor.a *= vDistanceFade;\n}$1`
        )
      }
    },
    [minDistance, fadeRange]
  )

  const blending = useMemo(() => {
    return blendMode === "additive"
      ? THREE.AdditiveBlending
      : THREE.NormalBlending
  }, [blendMode])

  if (!cloudsConfig?.enabled) return null

  return (
    <Points positions={positions} stride={3} frustumCulled={false}>
      <pointsMaterial
        ref={materialRef}
        size={size}
        color={color}
        transparent
        opacity={opacity}
        sizeAttenuation
        depthWrite={false}
        blending={blending}
        map={particleTexture}
        fog={true}
        onBeforeCompile={handleBeforeCompile}
      />
    </Points>
  )
}

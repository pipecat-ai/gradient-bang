import { useCallback, useEffect, useMemo, useRef } from "react"
import { Points } from "@react-three/drei"
import { folder, useControls } from "leva"
import * as THREE from "three"

import { useGameStore } from "@/useGameStore"
import { seededRandom } from "@/utils/math"

export const Dust = () => {
  const { dust: dustConfig } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const materialRef = useRef<THREE.PointsMaterial>(null)

  const [{ count, radius, size, opacity, minDistance, fadeRange }] =
    useControls(() => ({
      Dust: folder(
        {
          enabled: {
            value: dustConfig?.enabled ?? true,
            onChange: (value: boolean) => {
              setStarfieldConfig({ dust: { enabled: value } })
            },
          },
          count: {
            value: dustConfig?.count ?? 1000,
            min: 100,
            max: 5000,
            step: 100,
            label: "Count",
          },
          radius: {
            value: dustConfig?.radius ?? 100,
            min: 10,
            max: 200,
            step: 5,
            label: "Radius",
          },
          size: {
            value: dustConfig?.size ?? 0.1,
            min: 0.01,
            max: 5,
            step: 0.01,
            label: "Size",
          },
          opacity: {
            value: dustConfig?.opacity ?? 0.4,
            min: 0,
            max: 1,
            step: 0.05,
            label: "Opacity",
          },
          minDistance: {
            value: dustConfig?.minDistance ?? 2.0,
            min: 0,
            max: 20,
            step: 0.5,
            label: "Min Distance",
          },
          fadeRange: {
            value: dustConfig?.fadeRange ?? 5.0,
            min: 0.1,
            max: 10,
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

  // Generate random positions within a sphere
  const positions = useMemo(() => {
    const positions = new Float32Array(count * 3)
    // Create seeded RNG - seed changes with count and radius to get different patterns
    const random = seededRandom(count * radius)

    for (let i = 0; i < count; i++) {
      // Generate random point in sphere using spherical coordinates
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      const r = Math.cbrt(random()) * radius

      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta)
      const z = r * Math.cos(phi)

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }

    return positions
  }, [count, radius])

  // Custom shader material
  const handleBeforeCompile = useCallback(
    (shader: THREE.ShaderMaterial) => {
      // Store shader reference for updating uniforms later
      if (materialRef.current) {
        materialRef.current.userData.shader = shader
      }

      // Add only our custom uniforms (cameraPosition is built-in)
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

  if (!dustConfig?.enabled) return null

  return (
    <Points positions={positions} stride={3} frustumCulled={false}>
      <pointsMaterial
        ref={materialRef}
        size={size}
        color="#ffffff"
        transparent
        opacity={opacity}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        fog={true}
        onBeforeCompile={handleBeforeCompile}
      />
    </Points>
  )
}

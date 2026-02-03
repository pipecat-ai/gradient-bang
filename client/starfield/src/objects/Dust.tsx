import { useCallback, useEffect, useMemo, useRef } from "react"
import { Points } from "@react-three/drei"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { PANEL_ORDERING } from "@/constants"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"
import { seededRandom } from "@/utils/math"

// Default dust config values
const DEFAULT_DUST_CONFIG = {
  enabled: true,
  count: 1000,
  radius: 100,
  size: 0.2,
  opacity: 0.25,
  minDistance: 2.0,
  fadeRange: 5.0,
}

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = ["enabled"] as const

export const Dust = () => {
  const showControls = useShowControls()
  const { dust: dustConfig } = useGameStore((state) => state.starfieldConfig)
  const materialRef = useRef<THREE.PointsMaterial>(null)

  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                Dust: folder(
                  {
                    enabled: {
                      value: dustConfig?.enabled ?? DEFAULT_DUST_CONFIG.enabled,
                      label: "Enable Dust",
                    },
                    count: {
                      value: dustConfig?.count ?? DEFAULT_DUST_CONFIG.count,
                      min: 100,
                      max: 5000,
                      step: 100,
                      label: "Count",
                    },
                    radius: {
                      value: dustConfig?.radius ?? DEFAULT_DUST_CONFIG.radius,
                      min: 10,
                      max: 200,
                      step: 5,
                      label: "Radius",
                    },
                    size: {
                      value: dustConfig?.size ?? DEFAULT_DUST_CONFIG.size,
                      min: 0.01,
                      max: 5,
                      step: 0.01,
                      label: "Size",
                    },
                    opacity: {
                      value: dustConfig?.opacity ?? DEFAULT_DUST_CONFIG.opacity,
                      min: 0,
                      max: 1,
                      step: 0.05,
                      label: "Opacity",
                    },
                    minDistance: {
                      value:
                        dustConfig?.minDistance ??
                        DEFAULT_DUST_CONFIG.minDistance,
                      min: 0,
                      max: 20,
                      step: 0.5,
                      label: "Min Distance",
                    },
                    fadeRange: {
                      value:
                        dustConfig?.fadeRange ?? DEFAULT_DUST_CONFIG.fadeRange,
                      min: 0.1,
                      max: 10,
                      step: 0.1,
                      label: "Fade Range",
                    },
                  },
                  { collapsed: true }
                ),
              },
              { collapsed: true, order: PANEL_ORDERING.RENDERING }
            ),
          }
        : {}) as Schema
  )

  // Get stable config - hook handles all stabilization internally
  const controls = useControlSync({
    source: dustConfig as Partial<typeof DEFAULT_DUST_CONFIG> | undefined,
    defaults: DEFAULT_DUST_CONFIG,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_DUST_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_DUST_CONFIG>) => void,
  })

  useEffect(() => {
    if (materialRef.current && materialRef.current.userData.shader) {
      const shader = materialRef.current.userData.shader
      shader.uniforms.minDistance.value = controls.minDistance
      shader.uniforms.fadeRange.value = controls.fadeRange
    }
  }, [controls.minDistance, controls.fadeRange])

  // Generate random positions within a sphere
  const positions = useMemo(() => {
    const positions = new Float32Array(controls.count * 3)
    // Create seeded RNG - seed changes with count and radius to get different patterns
    const random = seededRandom(controls.count * controls.radius)

    for (let i = 0; i < controls.count; i++) {
      // Generate random point in sphere using spherical coordinates
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      const r = Math.cbrt(random()) * controls.radius

      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta)
      const z = r * Math.cos(phi)

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }

    return positions
  }, [controls.count, controls.radius])

  // Custom shader material
  const handleBeforeCompile = useCallback(
    (shader: THREE.ShaderMaterial) => {
      // Store shader reference for updating uniforms later
      if (materialRef.current) {
        materialRef.current.userData.shader = shader
      }

      // Add only our custom uniforms (cameraPosition is built-in)
      shader.uniforms.minDistance = { value: controls.minDistance }
      shader.uniforms.fadeRange = { value: controls.fadeRange }

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
    [controls.minDistance, controls.fadeRange]
  )

  // Only hide if explicitly disabled (not undefined during HMR settling)
  if (controls.enabled === false) return null

  return (
    <Points positions={positions} stride={3} frustumCulled={false}>
      <pointsMaterial
        ref={materialRef}
        size={controls.size}
        color="#ffffff"
        transparent
        opacity={controls.opacity}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        fog={true}
        onBeforeCompile={handleBeforeCompile}
      />
    </Points>
  )
}

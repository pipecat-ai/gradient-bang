import { useCallback, useEffect, useMemo, useRef } from "react"
import { Points } from "@react-three/drei"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { PANEL_ORDERING } from "@/constants"
import { useShowControls } from "@/hooks/useStarfieldControls"
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

// Default volumetric clouds config values
const DEFAULT_CLOUDS_CONFIG = {
  enabled: true,
  count: 500,
  radius: 300,
  size: 400,
  opacity: 0.03,
  blendMode: "normal" as const,
  minDistance: 10.0,
  fadeRange: 3.0,
}

export const VolumetricClouds = () => {
  const showControls = useShowControls()
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const { volumetricClouds: cloudsConfig } = starfieldConfig
  const materialRef = useRef<THREE.PointsMaterial>(null)

  // Get active palette (memoized to prevent unnecessary recalculations)
  const palette = useMemo(
    () => getPalette(starfieldConfig.palette),
    [starfieldConfig.palette]
  )

  // Default color from palette (memoized to stabilize references)
  const defaultColor = useMemo(
    () => cloudsConfig?.color ?? `#${palette.tint.getHexString()}`,
    [cloudsConfig, palette]
  )

  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                "Volumetric Clouds": folder(
                  {
                    enabled: {
                      value:
                        cloudsConfig?.enabled ?? DEFAULT_CLOUDS_CONFIG.enabled,
                      label: "Enable Clouds",
                    },
                    count: {
                      value: cloudsConfig?.count ?? DEFAULT_CLOUDS_CONFIG.count,
                      min: 50,
                      max: 2000,
                      step: 50,
                      label: "Count",
                    },
                    radius: {
                      value:
                        cloudsConfig?.radius ?? DEFAULT_CLOUDS_CONFIG.radius,
                      min: 20,
                      max: 500,
                      step: 5,
                      label: "Radius",
                    },
                    size: {
                      value: cloudsConfig?.size ?? DEFAULT_CLOUDS_CONFIG.size,
                      min: 1,
                      max: 200,
                      step: 0.5,
                      label: "Size",
                    },
                    opacity: {
                      value:
                        cloudsConfig?.opacity ?? DEFAULT_CLOUDS_CONFIG.opacity,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      label: "Opacity",
                    },
                    color: {
                      value: defaultColor,
                      label: "Color",
                    },
                    blendMode: {
                      value:
                        cloudsConfig?.blendMode ??
                        DEFAULT_CLOUDS_CONFIG.blendMode,
                      options: {
                        Additive: "additive",
                        Normal: "normal",
                      },
                      label: "Blend Mode",
                    },
                    minDistance: {
                      value:
                        cloudsConfig?.minDistance ??
                        DEFAULT_CLOUDS_CONFIG.minDistance,
                      min: 0,
                      max: 20,
                      step: 0.5,
                      label: "Min Distance",
                    },
                    fadeRange: {
                      value:
                        cloudsConfig?.fadeRange ??
                        DEFAULT_CLOUDS_CONFIG.fadeRange,
                      min: 0.1,
                      max: 20,
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

  // Get values from Leva when showing controls, otherwise from config/defaults
  const controls = useMemo(
    () =>
      showControls
        ? (levaValues as typeof DEFAULT_CLOUDS_CONFIG & { color: string })
        : {
            enabled: cloudsConfig?.enabled ?? DEFAULT_CLOUDS_CONFIG.enabled,
            count: cloudsConfig?.count ?? DEFAULT_CLOUDS_CONFIG.count,
            radius: cloudsConfig?.radius ?? DEFAULT_CLOUDS_CONFIG.radius,
            size: cloudsConfig?.size ?? DEFAULT_CLOUDS_CONFIG.size,
            opacity: cloudsConfig?.opacity ?? DEFAULT_CLOUDS_CONFIG.opacity,
            color: defaultColor,
            blendMode:
              cloudsConfig?.blendMode ?? DEFAULT_CLOUDS_CONFIG.blendMode,
            minDistance:
              cloudsConfig?.minDistance ?? DEFAULT_CLOUDS_CONFIG.minDistance,
            fadeRange:
              cloudsConfig?.fadeRange ?? DEFAULT_CLOUDS_CONFIG.fadeRange,
          },
    [showControls, levaValues, cloudsConfig, defaultColor]
  )

  useEffect(() => {
    if (materialRef.current && materialRef.current.userData.shader) {
      const shader = materialRef.current.userData.shader
      shader.uniforms.minDistance.value = controls.minDistance
      shader.uniforms.fadeRange.value = controls.fadeRange
    }
  }, [controls.minDistance, controls.fadeRange])

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (!showControls) return
    if (!cloudsConfig?.color) {
      try {
        set({ color: `#${palette.tint.getHexString()}` })
      } catch {
        // Controls may not be mounted
      }
    }
  }, [showControls, starfieldConfig.palette, palette, cloudsConfig, set])

  // Generate random positions within a sphere with cloud-like clustering
  const positions = useMemo(() => {
    const positions = new Float32Array(controls.count * 3)
    const random = seededRandom(controls.count * controls.radius * 137)

    for (let i = 0; i < controls.count; i++) {
      // Generate clusters by using non-uniform distribution
      const clusterBias = Math.pow(random(), 0.7) // Bias toward center
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      const r = clusterBias * controls.radius

      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta)
      const z = r * Math.cos(phi)

      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }

    return positions
  }, [controls.count, controls.radius])

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

  const blending = useMemo(() => {
    return controls.blendMode === "additive"
      ? THREE.AdditiveBlending
      : THREE.NormalBlending
  }, [controls.blendMode])

  if (!controls.enabled) return null

  return (
    <Points positions={positions} stride={3} frustumCulled={false}>
      <pointsMaterial
        ref={materialRef}
        size={controls.size}
        color={controls.color}
        transparent
        opacity={controls.opacity}
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

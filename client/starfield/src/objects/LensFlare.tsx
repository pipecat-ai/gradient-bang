import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS, PANEL_ORDERING } from "@/constants"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import {
  lensFlareFragmentShader,
  lensFlareVertexShader,
} from "@/shaders/LensFlareShader"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

// Quality levels: 0 = low (halos only), 1 = medium (+ghosts, streaks), 2 = high (all effects)
const QUALITY_OPTIONS = { Low: 0, Medium: 1, High: 2 }

// Default lens flare config values
const DEFAULT_LENSFLARE_CONFIG = {
  enabled: true,
  intensity: 1,
  ghostIntensity: 1.0,
  haloIntensity: 1,
  streakIntensity: 0.5,
  quality: 2, // 0 = low, 1 = medium, 2 = high
  secondaryColor: "#000000", // Color -> palette.c2
  // Light source position (relative to camera, in normalized coords) - used when galaxy tracking disabled
  lightX: 0.3,
  lightY: 0.2,
  trackGalaxy: true, // Whether to track the Galaxy object position (from galaxy config)
}

// Default galaxy config values (for calculating direction when trackGalaxy is true)
const DEFAULT_GALAXY_OFFSET = { offsetX: 0.2, offsetY: 0 }

/**
 * Calculate the galaxy direction vector from offset values.
 * This matches the calculation in Galaxy.tsx.
 */
function calculateGalaxyDirection(
  offsetX: number,
  offsetY: number
): THREE.Vector3 {
  // offsetX: -1 to +1 maps to horizontal rotation (-180° to +180°)
  // offsetY: -1 to +1 maps to vertical angle (-90° to +90°)
  const hAngle = -offsetX * Math.PI
  const vAngle = offsetY * Math.PI * 0.5

  const cosH = Math.cos(hAngle)
  const sinH = Math.sin(hAngle)
  const cosV = Math.cos(vAngle)
  const sinV = Math.sin(vAngle)

  // Start with forward (0,0,1), rotate around Y (horizontal), then around X (vertical)
  const cx = sinH * cosV
  const cy = sinV
  const cz = cosH * cosV

  // Account for mesh rotation of PI around Y (same as Galaxy.tsx)
  return new THREE.Vector3(-cx, cy, -cz).normalize()
}

// FOV fade configuration
const FOV_FADE_THRESHOLD = 5 // Start fading when FOV is this much over base (lower = more gradual)
const FOV_FADE_MAX = 150 // Fully faded at this FOV (animation goes to ~165, so fade over 55-150)

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = [
  "enabled",
  "intensity",
  "ghostIntensity",
  "haloIntensity",
  "streakIntensity",
  "quality",
  "lightX",
  "lightY",
  "trackGalaxy",
] as const

export const LensFlare = () => {
  const showControls = useShowControls()
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  const { camera, size } = useThree()
  const registerUniform = useUniformStore((state) => state.registerUniform)
  const removeUniform = useUniformStore((state) => state.removeUniform)
  const {
    lensFlare: lensFlareConfig,
    galaxy: galaxyConfig,
    palette: paletteKey,
  } = useGameStore((state) => state.starfieldConfig)

  // Get active palette
  const palette = useMemo(() => getPalette(paletteKey), [paletteKey])

  // Leva controls
  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            Objects: folder(
              {
                "Lens Flare": folder(
                  {
                    enabled: {
                      value:
                        lensFlareConfig?.enabled ??
                        DEFAULT_LENSFLARE_CONFIG.enabled,
                      label: "Enable Lens Flare",
                    },
                    quality: {
                      value:
                        lensFlareConfig?.quality ??
                        DEFAULT_LENSFLARE_CONFIG.quality,
                      options: QUALITY_OPTIONS,
                      label: "Quality",
                    },
                    intensity: {
                      value:
                        lensFlareConfig?.intensity ??
                        DEFAULT_LENSFLARE_CONFIG.intensity,
                      min: 0,
                      max: 10,
                      step: 0.1,
                      label: "Intensity",
                    },
                    ghostIntensity: {
                      value:
                        lensFlareConfig?.ghostIntensity ??
                        DEFAULT_LENSFLARE_CONFIG.ghostIntensity,
                      min: 0,
                      max: 10,
                      step: 0.1,
                      label: "Ghost Intensity",
                    },
                    haloIntensity: {
                      value:
                        lensFlareConfig?.haloIntensity ??
                        DEFAULT_LENSFLARE_CONFIG.haloIntensity,
                      min: 0,
                      max: 10,
                      step: 0.1,
                      label: "Halo Intensity",
                    },
                    streakIntensity: {
                      value:
                        lensFlareConfig?.streakIntensity ??
                        DEFAULT_LENSFLARE_CONFIG.streakIntensity,
                      min: 0,
                      max: 10,
                      step: 0.1,
                      label: "Streak Intensity",
                    },
                    trackGalaxy: {
                      value:
                        lensFlareConfig?.trackGalaxy ??
                        DEFAULT_LENSFLARE_CONFIG.trackGalaxy,
                      label: "Track Galaxy Position",
                    },
                    lightX: {
                      value:
                        lensFlareConfig?.lightX ??
                        DEFAULT_LENSFLARE_CONFIG.lightX,
                      min: -1,
                      max: 1,
                      step: 0.01,
                      label: "Light X",
                    },
                    lightY: {
                      value:
                        lensFlareConfig?.lightY ??
                        DEFAULT_LENSFLARE_CONFIG.lightY,
                      min: -1,
                      max: 1,
                      step: 0.01,
                      label: "Light Y",
                    },
                    secondaryColor: {
                      value: `#${palette.c2.getHexString()}`,
                      label: "Color",
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

  // Get stable config
  const controls = useControlSync({
    source: lensFlareConfig as
      | Partial<typeof DEFAULT_LENSFLARE_CONFIG>
      | undefined,
    defaults: DEFAULT_LENSFLARE_CONFIG,
    palette,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_LENSFLARE_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_LENSFLARE_CONFIG>) => void,
  })

  // Create shader material
  const lensFlareMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uResolution: { value: new THREE.Vector2(size.width, size.height) },
        uLightPosition: { value: new THREE.Vector2(0.3, 0.2) },
        uIntensity: { value: 2.0 },
        uOpacity: { value: 1.0 }, // FOV-based opacity (separate from intensity for animation)
        uColor: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
        uGhostIntensity: { value: 2.0 },
        uHaloIntensity: { value: 2.0 },
        uStreakIntensity: { value: 2.0 },
        uQuality: { value: 2 },
      },
      vertexShader: lensFlareVertexShader,
      fragmentShader: lensFlareFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  }, [size.width, size.height])

  // Store material ref
  useEffect(() => {
    materialRef.current = lensFlareMaterial
  }, [lensFlareMaterial])

  // Register animated uniforms with the uniform registry
  useEffect(() => {
    const mat = lensFlareMaterial
    if (!mat.uniforms) return

    // Register intensity uniform for external animation
    registerUniform("lensFlareIntensity", mat.uniforms.uIntensity, {
      initial: controls.intensity,
      meta: { effect: "lensFlare" },
    })

    return () => {
      removeUniform("lensFlareIntensity")
    }
  }, [lensFlareMaterial, controls.intensity, registerUniform, removeUniform])

  // Cleanup
  useEffect(() => {
    return () => {
      lensFlareMaterial.dispose()
    }
  }, [lensFlareMaterial])

  // Track the last intensity we set from controls (to detect external changes)
  const lastControlIntensityRef = useRef(controls.intensity)

  // Pre-calculate galaxy direction (stable - only changes when config changes)
  const galaxyDir = useMemo(() => {
    if (!controls.trackGalaxy || !galaxyConfig?.enabled) return null
    const offsetX = galaxyConfig?.offsetX ?? DEFAULT_GALAXY_OFFSET.offsetX
    const offsetY = galaxyConfig?.offsetY ?? DEFAULT_GALAXY_OFFSET.offsetY
    return calculateGalaxyDirection(offsetX, offsetY)
  }, [
    controls.trackGalaxy,
    galaxyConfig?.enabled,
    galaxyConfig?.offsetX,
    galaxyConfig?.offsetY,
  ])

  // Update uniforms each frame
  useFrame(() => {
    const material = materialRef.current
    if (!material) return

    // Update resolution
    material.uniforms.uResolution.value.set(size.width, size.height)

    // Calculate light position
    let lightX = controls.lightX
    let lightY = controls.lightY
    let opacity = 1.0 // Opacity for FOV fade and galaxy-behind fade (always applied)

    // Calculate FOV-based opacity fade
    // This fades the lens flare out when FOV increases significantly (e.g., during hyperspace)
    const fovUniform = useUniformStore
      .getState()
      .getUniform<number>("cameraFov")
    if (fovUniform?.uniform?.value !== undefined) {
      const baseFov =
        (fovUniform.initial as number | undefined) ??
        (fovUniform.uniform.value as number)
      const currentFov = fovUniform.uniform.value as number
      const fadeStartFov = baseFov + FOV_FADE_THRESHOLD // Start fading 20 degrees over base
      const fadeEndFov = FOV_FADE_MAX // Fully faded at 100 FOV

      if (currentFov <= fadeStartFov) {
        // Full opacity within threshold
      } else if (currentFov >= fadeEndFov) {
        opacity *= 0.0 // Fully faded at max
      } else {
        // Linear fade from threshold to max
        const fadeRange = fadeEndFov - fadeStartFov
        const t = (currentFov - fadeStartFov) / Math.max(fadeRange, 0.001)
        opacity *= 1.0 - t
      }
    }

    // If tracking galaxy, calculate position from the galaxy config direction
    if (galaxyDir) {
      // Create a point far in the galaxy direction from camera
      const galaxyPoint = camera.position
        .clone()
        .add(galaxyDir.clone().multiplyScalar(1000))

      // Project to normalized device coordinates
      const projected = galaxyPoint.project(camera)

      // Convert to our UV space (-0.5 to 0.5)
      lightX = projected.x * 0.5
      lightY = projected.y * 0.5

      // Check if galaxy center is behind camera
      const cameraDir = new THREE.Vector3()
      camera.getWorldDirection(cameraDir)
      const dot = cameraDir.dot(galaxyDir)

      // Fade out when galaxy is behind camera (applied via opacity so it works during animations)
      // Lower multiplier = more gradual transition (1.0 = 90° fade, 2.0 = 60° fade)
      const behindFade = Math.max(0, dot * 1.2)
      opacity *= Math.min(1.0, behindFade)
    }

    // Check if intensity was changed externally (by animation)
    // Only update from controls if the uniform still matches what we last set
    const currentUniformIntensity = material.uniforms.uIntensity.value
    const expectedIntensity = lastControlIntensityRef.current
    const wasAnimatedExternally =
      Math.abs(currentUniformIntensity - expectedIntensity) > 0.001

    if (!wasAnimatedExternally) {
      // Update intensity from controls (no modifiers - those are in opacity now)
      const newIntensity = controls.intensity
      material.uniforms.uIntensity.value = newIntensity
      lastControlIntensityRef.current = newIntensity
    }
    // If animated externally, leave the intensity uniform as-is (animation controls it)

    // Always update opacity (handles FOV fade + galaxy-behind fade, independent of animation)
    material.uniforms.uOpacity.value = opacity
    material.uniforms.uLightPosition.value.set(lightX, lightY)
    material.uniforms.uGhostIntensity.value = controls.ghostIntensity
    material.uniforms.uHaloIntensity.value = controls.haloIntensity
    material.uniforms.uStreakIntensity.value = controls.streakIntensity
    material.uniforms.uQuality.value = controls.quality

    // Update color from controls (use secondary color)
    const colorObj = new THREE.Color(controls.secondaryColor)
    material.uniforms.uColor.value.set(colorObj.r, colorObj.g, colorObj.b)
  })

  // Only hide if explicitly disabled (not undefined during HMR settling)
  if (controls.enabled === false) return null

  return (
    <mesh
      renderOrder={100}
      layers={LAYERS.FOREGROUND}
      material={lensFlareMaterial}
      frustumCulled={false}
    >
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}

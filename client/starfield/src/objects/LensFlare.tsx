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
  intensity: 1.0,
  ghostIntensity: 2.0,
  haloIntensity: 3.0,
  streakIntensity: 1.0,
  quality: 2, // 0 = low, 1 = medium, 2 = high
  secondaryColor: "#000000", // Color -> palette.c2
  // Light source position (relative to camera, in normalized coords)
  lightX: 0.3,
  lightY: 0.2,
  trackGalaxy: true, // Whether to track the Galaxy object position
}

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
  const { lensFlare: lensFlareConfig, palette: paletteKey } = useGameStore(
    (state) => state.starfieldConfig
  )

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

  // Update uniforms each frame
  useFrame(() => {
    const material = materialRef.current
    if (!material) return

    // Update resolution
    material.uniforms.uResolution.value.set(size.width, size.height)

    // Calculate light position
    let lightX = controls.lightX
    let lightY = controls.lightY
    let intensityMod = 1.0

    // Get current galaxy direction from store (updated by Galaxy component)
    const galaxyDirection = useGameStore.getState().galaxyDirection

    // If tracking galaxy, use the direction from the Galaxy component
    if (controls.trackGalaxy && galaxyDirection) {
      const galaxyDir = new THREE.Vector3(
        galaxyDirection.x,
        galaxyDirection.y,
        galaxyDirection.z
      ).normalize()

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

      // Fade out when galaxy is behind camera (but keep visible when off to the side)
      const behindFade = Math.max(0, dot * 2.0) // More gradual fade
      intensityMod = Math.min(1.0, behindFade)
    }

    // Check if intensity was changed externally (by animation)
    // Only update from controls if the uniform still matches what we last set
    const currentUniformIntensity = material.uniforms.uIntensity.value
    const expectedIntensity = lastControlIntensityRef.current
    const wasAnimatedExternally =
      Math.abs(currentUniformIntensity - expectedIntensity) > 0.001

    if (!wasAnimatedExternally) {
      // Update intensity from controls with camera fade modifier
      const newIntensity = controls.intensity * intensityMod
      material.uniforms.uIntensity.value = newIntensity
      lastControlIntensityRef.current = newIntensity
    }
    // If animated externally, leave the uniform value as-is (animation controls it)

    material.uniforms.uLightPosition.value.set(lightX, lightY)
    material.uniforms.uGhostIntensity.value = controls.ghostIntensity
    material.uniforms.uHaloIntensity.value = controls.haloIntensity
    material.uniforms.uStreakIntensity.value = controls.streakIntensity
    material.uniforms.uQuality.value = controls.quality

    // Update color from controls (use secondary color)
    const colorObj = new THREE.Color(controls.secondaryColor)
    material.uniforms.uColor.value.set(colorObj.r, colorObj.g, colorObj.b)
  })

  if (!controls.enabled) return null

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

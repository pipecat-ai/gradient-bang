import { useEffect, useMemo, useRef } from "react"
import { invalidate, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import { BlendFunction } from "postprocessing"

import { getPalette } from "@/colors"
import { useProfiledFrame } from "@/hooks/useProfiledFrame"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

import { PostProcessingManager, type PPConfig } from "./PostProcessingManager"

// Flattened default config for all post-processing controls
const DEFAULT_PP_CONFIG: PPConfig = {
  // Sharpening
  sharpening_enabled: true,
  sharpening_intensity: 2.0,
  sharpening_radius: 3.0,
  sharpening_threshold: 0,
  // Dithering
  dithering_enabled: true,
  dithering_gridSize: 1.33,
  dithering_pixelSizeRatio: 1,
  dithering_blendMode: BlendFunction.SET,
  dithering_grayscaleOnly: false,
  dithering_dpr: 1.0,
  // Grading
  grading_enabled: true,
  grading_brightness: 0.05,
  grading_contrast: 0.1,
  grading_saturation: 0.3,
  grading_tintEnabled: false,
  grading_tintIntensity: 0.5,
  grading_tintContrast: 1.0,
  grading_tintColorPrimary: "#ffffff",
  grading_tintColorSecondary: "#ffffff",
  // Exposure
  exposure_enabled: true,
  // Shockwave
  shockwave_enabled: true,
  shockwave_speed: 1,
  shockwave_maxRadius: 0.6,
  shockwave_waveSize: 0.15,
  shockwave_amplitude: 0.1,
  shockwave_distance: 4,
}

// Keys to sync to Leva when store changes
const TRANSIENT_PROPERTIES = [
  "sharpening_enabled",
  "sharpening_intensity",
  "sharpening_radius",
  "sharpening_threshold",
  "dithering_enabled",
  "dithering_gridSize",
  "dithering_pixelSizeRatio",
  "dithering_blendMode",
  "dithering_grayscaleOnly",
  "grading_enabled",
  "grading_brightness",
  "grading_contrast",
  "grading_saturation",
  "grading_tintEnabled",
  "grading_tintIntensity",
  "grading_tintContrast",
  "grading_tintColorPrimary",
  "grading_tintColorSecondary",
  "exposure_enabled",
  "shockwave_enabled",
  "shockwave_speed",
  "shockwave_maxRadius",
  "shockwave_waveSize",
  "shockwave_amplitude",
  "shockwave_distance",
] as const

/**
 * PostProcessingController - Thin React wrapper for PostProcessingManager
 *
 * This component:
 * - Sets up Leva controls for art direction
 * - Creates the PostProcessingManager singleton on mount
 * - Syncs control changes to the manager (no rebuilds, just uniform updates)
 * - Handles resize and render loop
 */
export const PostProcessingController = () => {
  const showControls = useShowControls()
  const managerRef = useRef<PostProcessingManager | null>(null)

  // Three.js state
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const currentDpr = useThree((state) => state.viewport.dpr)

  // Uniform store
  const registerUniform = useUniformStore((state) => state.registerUniform)
  const removeUniform = useUniformStore((state) => state.removeUniform)

  // Game store config
  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const {
    dithering: storedDithering,
    sharpening: storedSharpening,
    shockwave: storedShockwave,
    grading: storedGrading,
  } = starfieldConfig

  // Get active palette (memoized to stabilize reference)
  const palette = useMemo(
    () => getPalette(starfieldConfig.palette),
    [starfieldConfig.palette]
  )

  // Default colors from palette (memoized to stabilize references)
  const defaultTintPrimary = useMemo(
    () => storedGrading?.tintColorPrimary ?? `#${palette.c1.getHexString()}`,
    [storedGrading?.tintColorPrimary, palette]
  )
  const defaultTintSecondary = useMemo(
    () => storedGrading?.tintColorSecondary ?? `#${palette.c2.getHexString()}`,
    [storedGrading?.tintColorSecondary, palette]
  )

  // Map store configs to flattened structure for useControlSync
  const mappedSource = useMemo(() => {
    return {
      // Sharpening
      sharpening_enabled: storedSharpening?.enabled,
      sharpening_intensity: storedSharpening?.intensity,
      sharpening_radius: storedSharpening?.radius,
      sharpening_threshold: storedSharpening?.threshold,
      // Dithering (blendMode not stored, uses default)
      dithering_enabled: storedDithering?.enabled,
      dithering_gridSize: storedDithering?.gridSize,
      dithering_pixelSizeRatio: storedDithering?.pixelSizeRatio,
      dithering_grayscaleOnly: storedDithering?.grayscaleOnly,
      // Grading (with palette fallbacks for contrast/saturation)
      grading_enabled: storedGrading?.enabled,
      grading_brightness: storedGrading?.brightness,
      grading_contrast: storedGrading?.contrast ?? palette.contrast,
      grading_saturation: storedGrading?.saturation ?? palette.saturation,
      grading_tintEnabled: storedGrading?.tintEnabled,
      grading_tintIntensity: storedGrading?.tintIntensity,
      grading_tintContrast: storedGrading?.tintContrast,
      grading_tintColorPrimary: defaultTintPrimary,
      grading_tintColorSecondary: defaultTintSecondary,
      // Exposure (no store config currently)
      exposure_enabled: undefined,
      // Shockwave
      shockwave_enabled: storedShockwave?.enabled,
      shockwave_speed: storedShockwave?.speed,
      shockwave_maxRadius: storedShockwave?.maxRadius,
      shockwave_waveSize: storedShockwave?.waveSize,
      shockwave_amplitude: storedShockwave?.amplitude,
      shockwave_distance: storedShockwave?.distance,
    } as Partial<PPConfig>
  }, [
    storedSharpening,
    storedDithering,
    storedGrading,
    storedShockwave,
    palette,
    defaultTintPrimary,
    defaultTintSecondary,
  ])

  // Leva controls - conditional based on debug mode
  const [levaValues, set] = useControls(
    () =>
      (showControls
        ? {
            "Post Processing": folder(
              {
                Sharpening: folder(
                  {
                    sharpening_enabled: {
                      value:
                        storedSharpening?.enabled ??
                        DEFAULT_PP_CONFIG.sharpening_enabled,
                      label: "Enable Sharpening",
                    },
                    sharpening_intensity: {
                      value:
                        storedSharpening?.intensity ??
                        DEFAULT_PP_CONFIG.sharpening_intensity,
                      label: "Intensity",
                      min: 0,
                      max: 20,
                      step: 0.1,
                    },
                    sharpening_radius: {
                      value:
                        storedSharpening?.radius ??
                        DEFAULT_PP_CONFIG.sharpening_radius,
                      label: "Radius",
                      min: 0,
                      max: 10,
                      step: 0.1,
                    },
                    sharpening_threshold: {
                      value:
                        storedSharpening?.threshold ??
                        DEFAULT_PP_CONFIG.sharpening_threshold,
                      label: "Threshold",
                      min: 0,
                      max: 1,
                      step: 0.01,
                    },
                  },
                  { collapsed: true }
                ),
                Dithering: folder(
                  {
                    dithering_enabled: {
                      value:
                        storedDithering?.enabled ??
                        DEFAULT_PP_CONFIG.dithering_enabled,
                      label: "Enable Dithering",
                    },
                    dithering_gridSize: {
                      value:
                        storedDithering?.gridSize ??
                        DEFAULT_PP_CONFIG.dithering_gridSize,
                      min: 0.5,
                      max: 20,
                      step: 0.25,
                      label: "Effect Resolution",
                    },
                    dithering_pixelSizeRatio: {
                      value:
                        storedDithering?.pixelSizeRatio ??
                        DEFAULT_PP_CONFIG.dithering_pixelSizeRatio,
                      min: 0,
                      max: 10,
                      step: 1,
                      label: "Pixelation Strength",
                    },
                    dithering_blendMode: {
                      value: DEFAULT_PP_CONFIG.dithering_blendMode,
                      options: {
                        SET: BlendFunction.SET,
                        Normal: BlendFunction.NORMAL,
                        Add: BlendFunction.ADD,
                        Screen: BlendFunction.SCREEN,
                        Overlay: BlendFunction.OVERLAY,
                        Multiply: BlendFunction.MULTIPLY,
                      },
                      label: "Blend Function",
                    },
                    dithering_grayscaleOnly: {
                      value:
                        storedDithering?.grayscaleOnly ??
                        DEFAULT_PP_CONFIG.dithering_grayscaleOnly,
                      label: "Grayscale Only",
                    },
                  },
                  { collapsed: true }
                ),
                Grading: folder(
                  {
                    grading_enabled: {
                      value:
                        storedGrading?.enabled ??
                        DEFAULT_PP_CONFIG.grading_enabled,
                      label: "Enable Grading",
                    },
                    grading_brightness: {
                      value:
                        storedGrading?.brightness ??
                        DEFAULT_PP_CONFIG.grading_brightness,
                      min: 0,
                      max: 2,
                      step: 0.1,
                      label: "Brightness",
                    },
                    grading_contrast: {
                      value:
                        storedGrading?.contrast ??
                        palette.contrast ??
                        DEFAULT_PP_CONFIG.grading_contrast,
                      min: 0,
                      max: 2,
                      step: 0.01,
                      label: "Contrast",
                    },
                    grading_saturation: {
                      value:
                        storedGrading?.saturation ??
                        palette.saturation ??
                        DEFAULT_PP_CONFIG.grading_saturation,
                      min: -2,
                      max: 2,
                      step: 0.1,
                      label: "Saturation",
                    },
                    grading_tintEnabled: {
                      value:
                        storedGrading?.tintEnabled ??
                        DEFAULT_PP_CONFIG.grading_tintEnabled,
                      label: "Enable Tint",
                    },
                    grading_tintIntensity: {
                      value:
                        storedGrading?.tintIntensity ??
                        DEFAULT_PP_CONFIG.grading_tintIntensity,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      label: "Tint Intensity",
                    },
                    grading_tintContrast: {
                      value:
                        storedGrading?.tintContrast ??
                        DEFAULT_PP_CONFIG.grading_tintContrast,
                      min: 0,
                      max: 3,
                      step: 0.1,
                      label: "Tint Contrast",
                    },
                    grading_tintColorPrimary: {
                      value: defaultTintPrimary,
                      label: "Tint Primary Color",
                    },
                    grading_tintColorSecondary: {
                      value: defaultTintSecondary,
                      label: "Tint Secondary Color",
                    },
                  },
                  { collapsed: true }
                ),
                Exposure: folder(
                  {
                    exposure_enabled: {
                      value: DEFAULT_PP_CONFIG.exposure_enabled,
                      label: "Enable Exposure",
                    },
                  },
                  { collapsed: true }
                ),
                Shockwave: folder(
                  {
                    shockwave_enabled: {
                      value:
                        storedShockwave?.enabled ??
                        DEFAULT_PP_CONFIG.shockwave_enabled,
                      label: "Enable Shockwave",
                    },
                    shockwave_speed: {
                      value:
                        storedShockwave?.speed ??
                        DEFAULT_PP_CONFIG.shockwave_speed,
                      min: 0.1,
                      max: 5,
                      step: 0.1,
                      label: "Speed",
                    },
                    shockwave_maxRadius: {
                      value:
                        storedShockwave?.maxRadius ??
                        DEFAULT_PP_CONFIG.shockwave_maxRadius,
                      min: 0.1,
                      max: 2,
                      step: 0.05,
                      label: "Max Radius",
                    },
                    shockwave_waveSize: {
                      value:
                        storedShockwave?.waveSize ??
                        DEFAULT_PP_CONFIG.shockwave_waveSize,
                      min: 0.01,
                      max: 0.5,
                      step: 0.01,
                      label: "Wave Size",
                    },
                    shockwave_amplitude: {
                      value:
                        storedShockwave?.amplitude ??
                        DEFAULT_PP_CONFIG.shockwave_amplitude,
                      min: 0,
                      max: 0.5,
                      step: 0.01,
                      label: "Amplitude",
                    },
                    shockwave_distance: {
                      value:
                        storedShockwave?.distance ??
                        DEFAULT_PP_CONFIG.shockwave_distance,
                      min: 1,
                      max: 20,
                      step: 0.5,
                      label: "Distance",
                    },
                  },
                  { collapsed: true }
                ),
              },
              { collapsed: true, order: -1 }
            ),
          }
        : {}) as Schema
  )

  // Get stable config from useControlSync
  const syncedControls = useControlSync({
    source: mappedSource,
    defaults: DEFAULT_PP_CONFIG,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<PPConfig>,
    set: set as (values: Partial<PPConfig>) => void,
  })

  // Inject DPR (not a Leva control, but needed by the dithering shader)
  const controls = useMemo(
    () => ({ ...syncedControls, dithering_dpr: currentDpr }),
    [syncedControls, currentDpr]
  )

  // Store controls ref to access in useFrame without triggering re-renders
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  // Create manager on mount
  useEffect(() => {
    managerRef.current = new PostProcessingManager(
      gl,
      scene,
      camera,
      registerUniform,
      removeUniform,
      controls,
      size
    )

    return () => {
      // Get registered keys before disposing
      const uniformKeys = managerRef.current?.getRegisteredUniformKeys() ?? []

      // Dispose the manager
      managerRef.current?.dispose()
      managerRef.current = null

      // Unregister all uniforms
      uniformKeys.forEach((key) => removeUniform(key))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Empty deps - only mount/unmount

  // Sync parameters when controls change (no rebuild, just uniform updates)
  useEffect(() => {
    managerRef.current?.syncParameters(controls)
    invalidate()
  }, [controls])

  // Handle resize
  useEffect(() => {
    managerRef.current?.setSize(size.width, size.height)
  }, [size.width, size.height])

  // Enable profiling on the manager when in debug mode
  useEffect(() => {
    if (managerRef.current) {
      const debug = useGameStore.getState().debug
      managerRef.current.profilingEnabled = debug
      if (debug) {
        managerRef.current.initGPUTimer()
      }
    }
  }, [])

  // Render loop
  useProfiledFrame(
    "PostProcessing",
    ({ camera: currentCamera }) => {
      const manager = managerRef.current
      if (!manager) return

      // Skip the OVERLAY render pass when tunnel is invisible (saves ~10ms GPU)
      const tunnelOpacity = useUniformStore
        .getState()
        .getUniform<number>("tunnelOpacity")
      manager.overlayPassNeeded = (tunnelOpacity?.uniform?.value ?? 0) > 0

      manager.render(currentCamera, controlsRef.current.shockwave_distance)
    },
    1
  )

  return null
}

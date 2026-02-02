import { useEffect, useMemo, useRef, useState } from "react"
import { invalidate, useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import type { Schema } from "leva/dist/declarations/src/types"
import {
  BlendFunction,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  ShockWaveEffect,
} from "postprocessing"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import { DitheringEffect } from "@/fx/DitherEffect"
import { ExposureEffect } from "@/fx/ExposureEffect"
import { LayerDimEffect } from "@/fx/LayerDimEffect"
import { SharpenEffect } from "@/fx/SharpenEffect"
import { TintEffect } from "@/fx/TintEffect"
import { useControlSync, useShowControls } from "@/hooks/useStarfieldControls"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

// Flattened default config for all post-processing controls
const DEFAULT_PP_CONFIG = {
  // Sharpening
  sharpening_enabled: true,
  sharpening_intensity: 2.0,
  sharpening_radius: 6.0,
  sharpening_threshold: 0,
  // Dithering
  dithering_enabled: true,
  dithering_gridSize: 2,
  dithering_pixelSizeRatio: 1,
  dithering_blendMode: BlendFunction.SET as BlendFunction,
  dithering_grayscaleOnly: false,
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

// Keep exposure config for initial values
const DEFAULT_EXPOSURE_CONFIG = {
  enabled: true,
  amount: 1,
  startAmount: 0,
}
/**
 * PostProcessingController - manages post-processing effects with uniform registry
 *
 * This controller registers animatable uniforms with the game store's uniform registry,
 * allowing external animation files to drive the values without tight coupling.
 */
export const PostProcessingController = () => {
  const showControls = useShowControls()

  // Composer instance
  const composerRef = useRef<EffectComposer | null>(null)

  // Effect instances - updated in useFrame for animation, rebuilt on config changes
  const layerDimEffectRef = useRef<LayerDimEffect | null>(null)
  const tintEffectRef = useRef<TintEffect | null>(null)
  const ditheringEffectRef = useRef<DitheringEffect | null>(null)
  const sharpenEffectRef = useRef<SharpenEffect | null>(null)
  const exposureEffectRef = useRef<ExposureEffect | null>(null)
  const shockWaveEffectRef = useRef<ShockWaveEffect | null>(null)
  const shockwaveEpicenterRef = useRef(new THREE.Vector3())
  const shockwaveDirectionRef = useRef(new THREE.Vector3())
  const lastShockwaveSequenceRef = useRef(0)
  const shockwavePendingExplodeRef = useRef(false)
  const exposureInitializedRef = useRef(DEFAULT_EXPOSURE_CONFIG.startAmount)

  // Render target for GAMEOBJECTS mask (used to exclude from dim effect)
  const gameObjectsMaskRef = useRef<THREE.WebGLRenderTarget | null>(null)

  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const {
    dithering: storedDithering,
    sharpening: storedSharpening,
    shockwave: storedShockwave,
    grading: storedGrading,
  } = starfieldConfig
  const registerUniform = useUniformStore((state) => state.registerUniform)
  const removeUniform = useUniformStore((state) => state.removeUniform)

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

  const size = useThree((state) => state.size)
  const viewport = useThree((state) => state.viewport)

  // Map store configs to flattened structure for useControlSync
  // Note: DPR-based gridSize default is computed here to avoid separate sync effect
  const mappedSource = useMemo(() => {
    // Default gridSize based on DPR (if not set in store)
    const dprBasedGridSize = viewport.dpr >= 2 ? 2 : 1

    return {
      // Sharpening
      sharpening_enabled: storedSharpening?.enabled,
      sharpening_intensity: storedSharpening?.intensity,
      sharpening_radius: storedSharpening?.radius,
      sharpening_threshold: storedSharpening?.threshold,
      // Dithering (blendMode not stored, uses default)
      dithering_enabled: storedDithering?.enabled,
      dithering_gridSize: storedDithering?.gridSize ?? dprBasedGridSize,
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
    } as Partial<typeof DEFAULT_PP_CONFIG>
  }, [
    storedSharpening,
    storedDithering,
    storedGrading,
    storedShockwave,
    palette,
    defaultTintPrimary,
    defaultTintSecondary,
    viewport.dpr,
  ])
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const [composerReady, setComposerReady] = useState(false)

  // Update composer when size or DPR changes
  useEffect(() => {
    if (composerRef.current) {
      // The size includes DPR automatically in the internal calculation
      composerRef.current.setSize(size.width, size.height)
      console.debug(
        "[STARFIELD] PostProcessingController - Size/DPR changed, resizing composer"
      )
    }
    if (gameObjectsMaskRef.current) {
      gameObjectsMaskRef.current.setSize(
        Math.floor(size.width),
        Math.floor(size.height)
      )
    }
  }, [size.width, size.height, viewport.dpr])

  // Effect controls - conditional based on debug mode
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
                      min: 1,
                      max: 20,
                      step: 1,
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
                      value: DEFAULT_EXPOSURE_CONFIG.enabled,
                      label: "Enable Exposure",
                    },
                    /*exposure_amount: {
                      // Always show default amount (0) - startAmount only used for initial effect
                      value: DEFAULT_EXPOSURE_CONFIG.amount,
                      min: -2,
                      max: 2,
                      step: 0.01,
                      label: "Exposure Amount",
                    },*/
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

  // Get stable config - hook handles all stabilization
  // Note: DPR-based gridSize default is computed in mappedSource
  // Note: palette sync is handled by mappedSource (defaultTintPrimary/Secondary and palette.contrast/saturation)
  const controls = useControlSync({
    source: mappedSource,
    defaults: DEFAULT_PP_CONFIG,
    sync: TRANSIENT_PROPERTIES,
    levaValues: levaValues as Partial<typeof DEFAULT_PP_CONFIG>,
    set: set as (values: Partial<typeof DEFAULT_PP_CONFIG>) => void,
  })

  // Configure post-processing effects
  useEffect(() => {
    if (!scene || !camera || !composerReady) return

    console.debug("[STARFIELD] PostProcessingController - Building Passes")

    const composer = composerRef.current
    if (!composer) return
    composer.removeAllPasses()

    // Track uniforms to unregister on cleanup
    const registeredUniforms: string[] = []

    const renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    const orderedEffectPasses: EffectPass[] = []

    const layerDim = new LayerDimEffect({
      opacity: 1.0,
      maskTexture: gameObjectsMaskRef.current?.texture ?? null,
    })
    layerDimEffectRef.current = layerDim

    // Layer Dim
    const layerDimOpacityUniform = layerDim.uniforms.get("dimOpacity")
    if (layerDimOpacityUniform) {
      registerUniform("ppLayerDimOpacity", layerDimOpacityUniform, {
        initial: 1.0,
        meta: { effect: "layerDim" },
      })
      registeredUniforms.push("ppLayerDimOpacity")
    }

    orderedEffectPasses.push(new EffectPass(camera, layerDim))

    // Tint
    if (controls.grading_tintEnabled) {
      const primaryColor = new THREE.Color(controls.grading_tintColorPrimary)
      const secondaryColor = new THREE.Color(
        controls.grading_tintColorSecondary
      )

      const tint = new TintEffect({
        intensity: controls.grading_tintIntensity,
        contrast: controls.grading_tintContrast,
        tintColorPrimary: new THREE.Vector3(
          primaryColor.r,
          primaryColor.g,
          primaryColor.b
        ),
        tintColorSecondary: new THREE.Vector3(
          secondaryColor.r,
          secondaryColor.g,
          secondaryColor.b
        ),
      })
      tintEffectRef.current = tint
      orderedEffectPasses.push(new EffectPass(camera, tint))
    } else {
      tintEffectRef.current?.dispose()
      tintEffectRef.current = null
    }

    // Grading
    if (controls.grading_enabled) {
      const brightnessContrast = new BrightnessContrastEffect({
        brightness: controls.grading_brightness,
        contrast: controls.grading_contrast,
      })
      const hueSaturation = new HueSaturationEffect({
        saturation: controls.grading_saturation,
      })

      const brightnessContrastPass = new EffectPass(camera, brightnessContrast)
      const hueSaturationPass = new EffectPass(camera, hueSaturation)
      composer.addPass(brightnessContrastPass)
      composer.addPass(hueSaturationPass)
    }

    // Dithering effect
    if (controls.dithering_enabled) {
      const dither = new DitheringEffect({
        gridSize: controls.dithering_gridSize,
        pixelSizeRatio: controls.dithering_pixelSizeRatio,
        grayscaleOnly: controls.dithering_grayscaleOnly,
        blendFunction: controls.dithering_blendMode,
      })
      ditheringEffectRef.current = dither

      // Register dithering uniforms
      const gridSizeUniform = dither.uniforms.get("gridSize")
      const pixelSizeRatioUniform = dither.uniforms.get("pixelSizeRatio")

      if (gridSizeUniform) {
        registerUniform("ppDitheringGridSize", gridSizeUniform, {
          initial: controls.dithering_gridSize,
          meta: { effect: "dithering" },
        })
        registeredUniforms.push("ppDitheringGridSize")
      }

      if (pixelSizeRatioUniform) {
        registerUniform("ppDitheringPixelSizeRatio", pixelSizeRatioUniform, {
          initial: controls.dithering_pixelSizeRatio,
          meta: { effect: "dithering" },
        })
        registeredUniforms.push("ppDitheringPixelSizeRatio")
      }

      orderedEffectPasses.push(new EffectPass(camera, dither))
    } else {
      ditheringEffectRef.current?.dispose()
      ditheringEffectRef.current = null
    }

    // Sharpening
    if (controls.sharpening_enabled) {
      const sharpen = new SharpenEffect({
        intensity: controls.sharpening_intensity,
        radius: controls.sharpening_radius,
        threshold: controls.sharpening_threshold,
      })
      sharpenEffectRef.current = sharpen
      orderedEffectPasses.push(new EffectPass(camera, sharpen))
    } else {
      sharpenEffectRef.current?.dispose()
      sharpenEffectRef.current = null
    }

    // 6. Exposure - placed last for true fade to black
    if (controls.exposure_enabled) {
      // Register exposure uniform
      const exposure = new ExposureEffect({
        exposure: exposureInitializedRef.current
          ? DEFAULT_EXPOSURE_CONFIG.amount
          : DEFAULT_EXPOSURE_CONFIG.startAmount,
      })
      const exposureUniform = exposure.uniforms.get("exposure")
      if (exposureUniform) {
        registerUniform("ppExposure", exposureUniform, {
          initial: DEFAULT_EXPOSURE_CONFIG.amount,
          meta: { effect: "exposure", min: 0, max: 3, step: 0.01 },
        })
        registeredUniforms.push("ppExposure")
      }

      exposureInitializedRef.current = DEFAULT_EXPOSURE_CONFIG.amount

      orderedEffectPasses.push(new EffectPass(camera, exposure))
    } else {
      removeUniform("ppExposure")
      exposureEffectRef.current?.dispose()
      exposureEffectRef.current = null
    }

    // 7. Shockwave effect - config-driven, triggered via sequence in useFrame
    if (controls.shockwave_enabled) {
      const maxRadius = controls.shockwave_maxRadius
      const durationSeconds = Math.max(controls.shockwave_speed, 0.001)
      const effectSpeed = maxRadius / durationSeconds
      const shockwave = new ShockWaveEffect(
        camera,
        shockwaveEpicenterRef.current,
        {
          speed: effectSpeed,
          maxRadius: maxRadius,
          waveSize: controls.shockwave_waveSize,
          amplitude: controls.shockwave_amplitude,
        }
      )
      shockWaveEffectRef.current = shockwave
      // Sync sequence ref so we don't trigger on effect recreation
      lastShockwaveSequenceRef.current =
        useAnimationStore.getState().shockwaveSequence
      orderedEffectPasses.push(new EffectPass(camera, shockwave))
    } else {
      shockWaveEffectRef.current?.dispose()
      shockWaveEffectRef.current = null
    }

    orderedEffectPasses.forEach((pass) => composer.addPass(pass))

    invalidate()

    // Cleanup: unregister all uniforms when effect rebuilds
    return () => {
      registeredUniforms.forEach((key) => removeUniform(key))
    }
  }, [scene, camera, composerReady, controls, registerUniform, removeUniform])

  // Frame updates - only non-animated logic
  useFrame(({ gl, camera: currentCamera }) => {
    // Initialize composer if not yet created
    if (!composerRef.current) {
      composerRef.current = new EffectComposer(gl)
      composerRef.current.setSize(
        Math.floor(size.width),
        Math.floor(size.height)
      )
      setComposerReady(true)
    }

    // Initialize GAMEOBJECTS mask render target if not yet created
    if (!gameObjectsMaskRef.current) {
      gameObjectsMaskRef.current = new THREE.WebGLRenderTarget(
        Math.floor(size.width),
        Math.floor(size.height),
        {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
        }
      )
    }

    // Update layer dim effect mask texture reference if it was created after the effect
    const layerDimEffect = layerDimEffectRef.current
    if (layerDimEffect) {
      if (
        gameObjectsMaskRef.current &&
        layerDimEffect.maskTexture !== gameObjectsMaskRef.current.texture
      ) {
        layerDimEffect.maskTexture = gameObjectsMaskRef.current.texture
      }
    }

    // Update shockwave epicenter and check for trigger
    const shockwaveEffect = shockWaveEffectRef.current
    if (shockwaveEffect) {
      // Update epicenter position every frame (follows camera)
      const distance = controls.shockwave_distance
      currentCamera.getWorldDirection(shockwaveDirectionRef.current)
      shockwaveEpicenterRef.current
        .copy(currentCamera.position)
        .add(shockwaveDirectionRef.current.multiplyScalar(distance))
      shockwaveEffect.epicenter.copy(shockwaveEpicenterRef.current)

      // Handle pending explode (delayed by one frame to avoid huge deltaTime)
      if (shockwavePendingExplodeRef.current) {
        shockwavePendingExplodeRef.current = false
        shockwaveEffect.explode()
        // Signal actual start time for accurate duration tracking
        useAnimationStore.getState().setShockwaveStartTime(performance.now())
      }

      // Check for new trigger (sequence changed)
      const currentSequence = useAnimationStore.getState().shockwaveSequence
      if (currentSequence !== lastShockwaveSequenceRef.current) {
        lastShockwaveSequenceRef.current = currentSequence
        // Defer explode to next frame so deltaTime is small
        shockwavePendingExplodeRef.current = true
        invalidate()
      }
    }

    // Render GAMEOBJECTS to mask render target for dim exclusion
    const maskTarget = gameObjectsMaskRef.current
    if (maskTarget && scene) {
      // Store current camera layers
      const originalLayers = currentCamera.layers.mask

      // Set camera to only see GAMEOBJECTS layer
      currentCamera.layers.set(LAYERS.GAMEOBJECTS)

      // Render to mask target with black background
      gl.setRenderTarget(maskTarget)
      gl.setClearColor(0x000000, 0)
      gl.clear()
      gl.render(scene, currentCamera)
      gl.setRenderTarget(null)

      // Restore camera layers
      currentCamera.layers.mask = originalLayers
    }

    // Render the composer (excluding OVERLAY layer so tunnel isn't affected by exposure)
    if (composerRef.current && scene) {
      const originalLayers = currentCamera.layers.mask

      // Disable OVERLAY layer during post-processing
      currentCamera.layers.disable(LAYERS.OVERLAY)

      // Render post-processed scene
      composerRef.current.render()

      // Render OVERLAY layer (tunnel) on top without post-processing
      currentCamera.layers.set(LAYERS.OVERLAY)
      gl.render(scene, currentCamera)

      // Restore camera layers
      currentCamera.layers.mask = originalLayers
    }
  }, 1)

  return null
}

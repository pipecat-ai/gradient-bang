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
import { useShowControls } from "@/hooks/useStarfieldControls"
import { useAnimationStore } from "@/useAnimationStore"
import { useGameStore } from "@/useGameStore"
import { useUniformStore } from "@/useUniformStore"

// Default config values
const DEFAULT_SHARPENING_CONFIG = {
  enabled: true,
  intensity: 2.0,
  radius: 6.0,
  threshold: 0.0,
}

const DEFAULT_DITHERING_CONFIG = {
  enabled: true,
  gridSize: 2,
  pixelSizeRatio: 1,
  blendMode: BlendFunction.SET,
  grayscaleOnly: false,
}

const DEFAULT_GRADING_CONFIG = {
  enabled: true,
  brightness: 0.1,
  contrast: 0.25,
  saturation: 0.0,
  tintEnabled: false,
  tintIntensity: 0.5,
  tintContrast: 1.0,
}

const DEFAULT_EXPOSURE_CONFIG = {
  enabled: true,
  amount: 1,
  startAmount: 0,
}

const DEFAULT_SHOCKWAVE_CONFIG = {
  enabled: true,
  speed: 1,
  maxRadius: 0.6,
  waveSize: 0.15,
  amplitude: 0.1,
  distance: 4,
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
    shockwave: shockwaveConfig,
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
                    sharpeningEnabled: {
                      value:
                        storedSharpening?.enabled ??
                        DEFAULT_SHARPENING_CONFIG.enabled,
                      label: "Enable Sharpening",
                    },
                    sharpeningIntensity: {
                      value:
                        storedSharpening?.intensity ??
                        DEFAULT_SHARPENING_CONFIG.intensity,
                      label: "Intensity",
                      min: 0,
                      max: 20,
                      step: 0.1,
                    },
                    sharpeningRadius: {
                      value:
                        storedSharpening?.radius ??
                        DEFAULT_SHARPENING_CONFIG.radius,
                      label: "Radius",
                      min: 0,
                      max: 10,
                      step: 0.1,
                    },
                    sharpeningThreshold: {
                      value:
                        storedSharpening?.threshold ??
                        DEFAULT_SHARPENING_CONFIG.threshold,
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
                    ditheringEnabled: {
                      value:
                        storedDithering?.enabled ??
                        DEFAULT_DITHERING_CONFIG.enabled,
                      label: "Enable Dithering",
                    },
                    ditheringGridSize: {
                      value:
                        storedDithering?.gridSize ??
                        DEFAULT_DITHERING_CONFIG.gridSize,
                      min: 1,
                      max: 20,
                      step: 1,
                      label: "Effect Resolution",
                    },
                    ditheringPixelSizeRatio: {
                      value:
                        storedDithering?.pixelSizeRatio ??
                        DEFAULT_DITHERING_CONFIG.pixelSizeRatio,
                      min: 0,
                      max: 10,
                      step: 1,
                      label: "Pixelation Strength",
                    },
                    ditheringBlendMode: {
                      value: DEFAULT_DITHERING_CONFIG.blendMode,
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
                    ditheringGrayscaleOnly: {
                      value:
                        storedDithering?.grayscaleOnly ??
                        DEFAULT_DITHERING_CONFIG.grayscaleOnly,
                      label: "Grayscale Only",
                    },
                  },
                  { collapsed: true }
                ),
                Grading: folder(
                  {
                    gradingEnabled: {
                      value:
                        storedGrading?.enabled ??
                        DEFAULT_GRADING_CONFIG.enabled,
                      label: "Enable Grading",
                    },
                    gradingBrightness: {
                      value:
                        storedGrading?.brightness ??
                        DEFAULT_GRADING_CONFIG.brightness,
                      min: 0,
                      max: 2,
                      step: 0.1,
                      label: "Brightness",
                    },
                    gradingContrast: {
                      value:
                        storedGrading?.contrast ??
                        palette.contrast ??
                        DEFAULT_GRADING_CONFIG.contrast,
                      min: 0,
                      max: 2,
                      step: 0.01,
                      label: "Contrast",
                    },
                    gradingSaturation: {
                      value:
                        storedGrading?.saturation ??
                        palette.saturation ??
                        DEFAULT_GRADING_CONFIG.saturation,
                      min: -2,
                      max: 2,
                      step: 0.1,
                      label: "Saturation",
                    },
                    tintEnabled: {
                      value:
                        storedGrading?.tintEnabled ??
                        DEFAULT_GRADING_CONFIG.tintEnabled,
                      label: "Enable Tint",
                    },
                    tintIntensity: {
                      value:
                        storedGrading?.tintIntensity ??
                        DEFAULT_GRADING_CONFIG.tintIntensity,
                      min: 0,
                      max: 1,
                      step: 0.01,
                      label: "Tint Intensity",
                    },
                    tintContrast: {
                      value:
                        storedGrading?.tintContrast ??
                        DEFAULT_GRADING_CONFIG.tintContrast,
                      min: 0,
                      max: 3,
                      step: 0.1,
                      label: "Tint Contrast",
                    },
                    tintColorPrimary: {
                      value: defaultTintPrimary,
                      label: "Tint Primary Color",
                    },
                    tintColorSecondary: {
                      value: defaultTintSecondary,
                      label: "Tint Secondary Color",
                    },
                  },
                  { collapsed: true }
                ),
                Exposure: folder(
                  {
                    exposureEnabled: {
                      value: DEFAULT_EXPOSURE_CONFIG.enabled,
                      label: "Enable Exposure",
                    },
                    /*exposureAmount: {
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
              },
              { collapsed: true, order: -1 }
            ),
          }
        : {}) as Schema
  )

  // Get values from Leva when showing controls, otherwise from config/defaults
  const controls = useMemo(
    () =>
      showControls
        ? (levaValues as {
            sharpeningEnabled: boolean
            sharpeningIntensity: number
            sharpeningRadius: number
            sharpeningThreshold: number
            ditheringEnabled: boolean
            ditheringGridSize: number
            ditheringPixelSizeRatio: number
            ditheringBlendMode: BlendFunction
            ditheringGrayscaleOnly: boolean
            gradingEnabled: boolean
            gradingBrightness: number
            gradingContrast: number
            gradingSaturation: number
            tintEnabled: boolean
            tintIntensity: number
            tintContrast: number
            tintColorPrimary: string
            tintColorSecondary: string
            exposureEnabled: boolean
            exposureAmount: number
          })
        : {
            sharpeningEnabled:
              storedSharpening?.enabled ?? DEFAULT_SHARPENING_CONFIG.enabled,
            sharpeningIntensity:
              storedSharpening?.intensity ??
              DEFAULT_SHARPENING_CONFIG.intensity,
            sharpeningRadius:
              storedSharpening?.radius ?? DEFAULT_SHARPENING_CONFIG.radius,
            sharpeningThreshold:
              storedSharpening?.threshold ??
              DEFAULT_SHARPENING_CONFIG.threshold,
            ditheringEnabled:
              storedDithering?.enabled ?? DEFAULT_DITHERING_CONFIG.enabled,
            ditheringGridSize:
              storedDithering?.gridSize ?? DEFAULT_DITHERING_CONFIG.gridSize,
            ditheringPixelSizeRatio:
              storedDithering?.pixelSizeRatio ??
              DEFAULT_DITHERING_CONFIG.pixelSizeRatio,
            ditheringBlendMode: DEFAULT_DITHERING_CONFIG.blendMode,
            ditheringGrayscaleOnly:
              storedDithering?.grayscaleOnly ??
              DEFAULT_DITHERING_CONFIG.grayscaleOnly,
            gradingEnabled:
              storedGrading?.enabled ?? DEFAULT_GRADING_CONFIG.enabled,
            gradingBrightness:
              storedGrading?.brightness ?? DEFAULT_GRADING_CONFIG.brightness,
            gradingContrast:
              storedGrading?.contrast ??
              palette.contrast ??
              DEFAULT_GRADING_CONFIG.contrast,
            gradingSaturation:
              storedGrading?.saturation ??
              palette.saturation ??
              DEFAULT_GRADING_CONFIG.saturation,
            tintEnabled:
              storedGrading?.tintEnabled ?? DEFAULT_GRADING_CONFIG.tintEnabled,
            tintIntensity:
              storedGrading?.tintIntensity ??
              DEFAULT_GRADING_CONFIG.tintIntensity,
            tintContrast:
              storedGrading?.tintContrast ??
              DEFAULT_GRADING_CONFIG.tintContrast,
            tintColorPrimary: defaultTintPrimary,
            tintColorSecondary: defaultTintSecondary,
            exposureEnabled: DEFAULT_EXPOSURE_CONFIG.enabled,
          },
    [
      showControls,
      levaValues,
      storedSharpening,
      storedDithering,
      storedGrading,
      palette,
      defaultTintPrimary,
      defaultTintSecondary,
    ]
  )

  // Sync: DPR changes -> Leva dithering grid size
  useEffect(() => {
    if (!showControls) return
    if (storedDithering?.gridSize) return
    try {
      set({ ditheringGridSize: viewport.dpr >= 2 ? 2 : 1 })
    } catch {
      // Controls may not be mounted
    }
  }, [showControls, viewport.dpr, storedDithering?.gridSize, set])

  // Sync: palette changes -> Leva grading controls
  useEffect(() => {
    if (!showControls) return
    if (
      storedGrading?.tintColorPrimary ||
      storedGrading?.tintColorSecondary ||
      storedGrading?.contrast ||
      storedGrading?.saturation
    ) {
      return
    }
    try {
      set({
        gradingContrast: palette.contrast,
        gradingSaturation: palette.saturation,
        tintColorPrimary: `#${palette.c1.getHexString()}`,
        tintColorSecondary: `#${palette.c2.getHexString()}`,
      })
    } catch {
      // Controls may not be mounted
    }
  }, [showControls, starfieldConfig.palette, palette, storedGrading, set])

  // Configure post-processing effects
  useEffect(() => {
    if (!scene || !camera || !composerReady) return

    console.debug(
      "[STARFIELD] PostProcessingController - Building Passes",
      controls
    )

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
    if (controls.tintEnabled) {
      const primaryColor = new THREE.Color(controls.tintColorPrimary)
      const secondaryColor = new THREE.Color(controls.tintColorSecondary)

      const tint = new TintEffect({
        intensity: controls.tintIntensity,
        contrast: controls.tintContrast,
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
    if (controls.gradingEnabled) {
      const brightnessContrast = new BrightnessContrastEffect({
        brightness: controls.gradingBrightness,
        contrast: controls.gradingContrast,
      })
      const hueSaturation = new HueSaturationEffect({
        saturation: controls.gradingSaturation,
      })

      const brightnessContrastPass = new EffectPass(camera, brightnessContrast)
      const hueSaturationPass = new EffectPass(camera, hueSaturation)
      composer.addPass(brightnessContrastPass)
      composer.addPass(hueSaturationPass)
    }

    // Dithering effect (always on)
    const dither = new DitheringEffect({
      gridSize: controls.ditheringGridSize,
      pixelSizeRatio: controls.ditheringPixelSizeRatio,
      grayscaleOnly: controls.ditheringGrayscaleOnly,
      blendFunction: controls.ditheringBlendMode,
    })
    ditheringEffectRef.current = dither

    // Register dithering uniforms
    const gridSizeUniform = dither.uniforms.get("gridSize")
    const pixelSizeRatioUniform = dither.uniforms.get("pixelSizeRatio")

    if (gridSizeUniform) {
      registerUniform("ppDitheringGridSize", gridSizeUniform, {
        initial: controls.ditheringGridSize,
        meta: { effect: "dithering" },
      })
      registeredUniforms.push("ppDitheringGridSize")
    }

    if (pixelSizeRatioUniform) {
      registerUniform("ppDitheringPixelSizeRatio", pixelSizeRatioUniform, {
        initial: controls.ditheringPixelSizeRatio,
        meta: { effect: "dithering" },
      })
      registeredUniforms.push("ppDitheringPixelSizeRatio")
    }

    orderedEffectPasses.push(new EffectPass(camera, dither))

    // Sharpening
    if (controls.sharpeningEnabled) {
      const sharpen = new SharpenEffect({
        intensity: controls.sharpeningIntensity,
        radius: controls.sharpeningRadius,
        threshold: controls.sharpeningThreshold,
      })
      sharpenEffectRef.current = sharpen
      orderedEffectPasses.push(new EffectPass(camera, sharpen))
    } else {
      sharpenEffectRef.current?.dispose()
      sharpenEffectRef.current = null
    }

    // 6. Exposure - placed last for true fade to black
    if (controls.exposureEnabled) {
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
    if (shockwaveConfig?.enabled ?? DEFAULT_SHOCKWAVE_CONFIG.enabled) {
      const maxRadius =
        shockwaveConfig?.maxRadius ?? DEFAULT_SHOCKWAVE_CONFIG.maxRadius
      const durationSeconds = Math.max(
        shockwaveConfig?.speed ?? DEFAULT_SHOCKWAVE_CONFIG.speed,
        0.001
      )
      const effectSpeed = maxRadius / durationSeconds
      const shockwave = new ShockWaveEffect(
        camera,
        shockwaveEpicenterRef.current,
        {
          speed: effectSpeed,
          maxRadius: maxRadius,
          waveSize:
            shockwaveConfig?.waveSize ?? DEFAULT_SHOCKWAVE_CONFIG.waveSize,
          amplitude:
            shockwaveConfig?.amplitude ?? DEFAULT_SHOCKWAVE_CONFIG.amplitude,
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
  }, [
    scene,
    camera,
    composerReady,
    controls,
    shockwaveConfig,
    registerUniform,
    removeUniform,
  ])

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
      const distance =
        shockwaveConfig?.distance ?? DEFAULT_SHOCKWAVE_CONFIG.distance
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

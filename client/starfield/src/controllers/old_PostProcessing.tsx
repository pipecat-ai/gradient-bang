import { useEffect, useRef, useState } from "react"
import { easings } from "@react-spring/three"
import { invalidate, useFrame, useThree } from "@react-three/fiber"
import { folder, useControls } from "leva"
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  ShockWaveEffect,
  VignetteEffect,
} from "postprocessing"
import * as THREE from "three"

import { getPalette } from "@/colors"
import { LAYERS } from "@/constants"
import { DitheringEffect } from "@/fx/DitherEffect"
import { ExposureEffect } from "@/fx/ExposureEffect"
import { LayerDimEffect } from "@/fx/LayerDimEffect"
import { ScanlineEffect } from "@/fx/ScanlineEffect"
import { SharpenEffect } from "@/fx/SharpenEffect"
import { TintEffect } from "@/fx/TintEffect"
import {
  useExposure,
  useLayerDim,
  useShockwave,
  useWarpAnimation,
} from "@/hooks/animations"
import { useGameStore } from "@/useGameStore"

/**
 * Component that manages all post-processing effects
 * Configures and applies various effects to the rendered scene
 */
export const PostProcessing = () => {
  // Composer instance
  const composerRef = useRef<EffectComposer | null>(null)

  // Effect instances - updated in useFrame for animation, rebuilt on config changes
  const bloomEffectRef = useRef<BloomEffect | null>(null)
  const bloomPassRef = useRef<EffectPass | null>(null)
  const vignetteEffectRef = useRef<VignetteEffect | null>(null)
  const vignettePassRef = useRef<EffectPass | null>(null)
  const shockWaveEffectRef = useRef<ShockWaveEffect | null>(null)
  const layerDimEffectRef = useRef<LayerDimEffect | null>(null)
  const tintEffectRef = useRef<TintEffect | null>(null)
  const ditheringEffectRef = useRef<DitheringEffect | null>(null)
  const scanlineEffectRef = useRef<ScanlineEffect | null>(null)
  const sharpenEffectRef = useRef<SharpenEffect | null>(null)
  const exposureEffectRef = useRef<ExposureEffect | null>(null)

  // Shockwave animation state
  const shockwaveEpicenterRef = useRef(new THREE.Vector3())
  const shockwaveDirectionRef = useRef(new THREE.Vector3())
  const lastShockwaveSequenceRef = useRef(0)

  // Render target for GAMEOBJECTS mask (used to exclude from dim effect)
  const gameObjectsMaskRef = useRef<THREE.WebGLRenderTarget | null>(null)

  const starfieldConfig = useGameStore((state) => state.starfieldConfig)
  const {
    hyerpspaceUniforms,
    dithering: storedDithering,
    sharpening: storedSharpening,
    vignette: storedVignette,
    shockwave: storedShockwave,
    scanlines: storedScanlines,
    grading: storedGrading,
  } = starfieldConfig
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)

  // Get active palette
  const palette = getPalette(starfieldConfig.palette)

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
        "[STARFIELD] PostProcessing - Size/DPR changed, resizing composer"
      )
    }
    if (gameObjectsMaskRef.current) {
      gameObjectsMaskRef.current.setSize(
        Math.floor(size.width),
        Math.floor(size.height)
      )
    }
  }, [size.width, size.height, viewport.dpr])

  // Effect controls
  const [ppUniforms, set] = useControls(() => ({
    "Post Processing": folder(
      {
        Bloom: folder(
          {
            bloomEnabled: {
              value: false,
              label: "Enable Bloom (Pre-Dithering)",
            },
            bloomThreshold: {
              value: 0.0,
              min: 0,
              max: 2,
              step: 0.01,
              label: "Threshold",
            },
            bloomIntensity: {
              value: 0.0,
              min: 0,
              max: 50,
              step: 0.1,
              label: "Intensity",
            },
            bloomRadius: {
              value: 0.0,
              min: 0,
              max: 1,
              step: 0.1,
              label: "Radius",
            },
          },
          { collapsed: true }
        ),
        Sharpening: folder(
          {
            sharpeningEnabled: {
              value: storedSharpening.sharpeningEnabled ?? true,
              label: "Enable Sharpening",
            },
            sharpeningIntensity: {
              value: storedSharpening.sharpeningIntensity ?? 2.0,
              label: "Intensity",
              min: 0,
              max: 20,
              step: 0.1,
            },
            sharpeningRadius: {
              value: storedSharpening.sharpeningRadius ?? 6.0,
              label: "Radius",
              min: 0,
              max: 10,
              step: 0.1,
            },
            sharpeningThreshold: {
              value: storedSharpening.sharpeningThreshold ?? 0.0,
              label: "Threshold",
              min: 0,
              max: 1,
              step: 0.01,
            },
          },
          { collapsed: true }
        ),
        Vignette: folder(
          {
            vignetteEnabled: {
              value: storedVignette.vignetteEnabled ?? true,
              label: "Enable Vignette",
            },
            vignetteOffset: {
              value: storedVignette.vignetteOffset ?? 0,
              min: 0,
              max: 1,
              step: 0.01,
              label: "Offset",
            },
            vignetteDarkness: {
              value: storedVignette.vignetteDarkness ?? 0.5,
              min: 0,
              max: 1.5,
              step: 0.01,
              label: "Darkness",
            },
          },
          { collapsed: true }
        ),
        Shockwave: folder(
          {
            shockwaveEnabled: {
              value: storedShockwave.shockwaveEnabled ?? true,
              label: "Enable Shockwave",
            },
            shockwaveSpeed: {
              value: storedShockwave.shockwaveSpeed ?? 1.25,
              min: 0.1,
              max: 5,
              step: 0.05,
              label: "Speed",
            },
            shockwaveMaxRadius: {
              value: storedShockwave.shockwaveMaxRadius ?? 0.8,
              min: 0.1,
              max: 5,
              step: 0.05,
              label: "Max Radius",
            },
            shockwaveWaveSize: {
              value: storedShockwave.shockwaveWaveSize ?? 0.25,
              min: 0.01,
              max: 1,
              step: 0.01,
              label: "Wave Size",
            },
            shockwaveAmplitude: {
              value: storedShockwave.shockwaveAmplitude ?? 0.15,
              min: 0,
              max: 1,
              step: 0.01,
              label: "Amplitude",
            },
            shockwaveDistance: {
              value: storedShockwave.shockwaveDistance ?? 2.5,
              min: 0.1,
              max: 20,
              step: 0.1,
              label: "Epicenter Distance",
            },
          },
          { collapsed: true }
        ),
        Dithering: folder(
          {
            ditheringEnabled: {
              value: storedDithering.ditheringEnabled ?? true,
              label: "Enable Dithering",
            },
            ditheringGridSize: {
              value:
                storedDithering.ditheringGridSize ??
                (viewport.dpr >= 2 ? 2 : 1),
              min: 1,
              max: 20,
              step: 1,
              label: "Effect Resolution",
            },
            ditheringPixelSizeRatio: {
              value: storedDithering.ditheringPixelSizeRatio ?? 1,
              min: 0,
              max: 10,
              step: 1,
              label: "Pixelation Strength",
            },
            ditheringBlendMode: {
              value: BlendFunction.SET,
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
              value: storedDithering.ditheringGrayscaleOnly ?? false,
              label: "Grayscale Only",
            },
          },
          { collapsed: true }
        ),
        Scanlines: folder(
          {
            scanlinesEnabled: {
              value: storedScanlines.scanlinesEnabled ?? false,
              label: "Enable Scanlines",
            },
            scanlinesIntensity: {
              value: storedScanlines.scanlinesIntensity ?? 0.2,
              min: 0,
              max: 1,
              step: 0.1,
              label: "Intensity",
            },
            scanlinesFrequency: {
              value: storedScanlines.scanlinesFrequency ?? 0.9,
              min: 0,
              max: 2,
              step: 0.1,
              label: "Frequency",
            },
            scanlinesBlendMode: {
              value: BlendFunction.NORMAL,
              options: {
                Normal: BlendFunction.NORMAL,
                Add: BlendFunction.ADD,
                Screen: BlendFunction.SCREEN,
                Overlay: BlendFunction.OVERLAY,
                Multiply: BlendFunction.MULTIPLY,
              },
              label: "Blend Mode",
            },
          },
          { collapsed: true }
        ),
        Grading: folder(
          {
            gradingEnabled: {
              value: storedGrading.enabled ?? true,
              label: "Enable Grading",
            },
            gradingBrightness: {
              value: storedGrading.brightness ?? 0.1,
              min: 0,
              max: 2,
              step: 0.1,
              label: "Brightness",
            },
            gradingContrast: {
              value: storedGrading.contrast ?? palette.contrast ?? 0.25,
              min: 0,
              max: 2,
              step: 0.01,
              label: "Contrast",
            },
            gradingSaturation: {
              value: storedGrading.saturation ?? palette.saturation,
              min: -2,
              max: 2,
              step: 0.1,
              label: "Saturation",
            },
            tintEnabled: {
              value: storedGrading.tintEnabled ?? false,
              label: "Enable Tint",
            },
            tintIntensity: {
              value: storedGrading.tintIntensity ?? 0.5,
              min: 0,
              max: 1,
              step: 0.01,
              label: "Tint Intensity",
            },
            tintContrast: {
              value: storedGrading.tintContrast ?? 1.0,
              min: 0,
              max: 3,
              step: 0.1,
              label: "Tint Contrast",
            },
            tintColorPrimary: {
              value:
                storedGrading.tintColorPrimary ??
                `#${palette.c1.getHexString()}`,
              label: "Tint Primary Color",
            },
            tintColorSecondary: {
              value:
                storedGrading.tintColorSecondary ??
                `#${palette.c2.getHexString()}`,
              label: "Tint Secondary Color",
            },
          },
          { collapsed: true }
        ),
        Exposure: folder(
          {
            exposureEnabled: {
              value: true,
              label: "Enable Exposure",
            },
          },
          { collapsed: true }
        ),
      },
      { collapsed: true, order: -1 }
    ),
  }))

  useEffect(() => {
    if (!storedDithering.ditheringGridSize) {
      set({
        ditheringGridSize: viewport.dpr >= 2 ? 2 : 1,
      })
    }
  }, [viewport.dpr, storedDithering.ditheringGridSize, set])

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (
      !storedGrading.tintColorPrimary &&
      !storedGrading.tintColorSecondary &&
      !storedGrading.contrast &&
      !storedGrading.saturation
    ) {
      set({
        gradingContrast: palette.contrast,
        gradingSaturation: palette.saturation,
        tintColorPrimary: `#${palette.c1.getHexString()}`,
        tintColorSecondary: `#${palette.c2.getHexString()}`,
      })
    }
  }, [starfieldConfig.palette, palette, storedGrading, set])

  // Configure post-processing effects
  useEffect(() => {
    if (!scene || !camera || !composerReady) return

    console.debug("[STARFIELD] PostProcessing - Building Passes")

    const composer = composerRef.current
    if (!composer) return
    composer.removeAllPasses()

    const renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    const orderedEffectPasses: EffectPass[] = []

    // 1. Effect passes that sit in the background
    if (ppUniforms.bloomEnabled) {
      let bloom = bloomEffectRef.current
      if (!bloom) {
        bloom = new BloomEffect({
          luminanceThreshold: ppUniforms.bloomThreshold,
          intensity: ppUniforms.bloomIntensity,
          radius: ppUniforms.bloomRadius,
          mipmapBlur: true,
        })
        bloomEffectRef.current = bloom
      } else {
        bloom.intensity = ppUniforms.bloomIntensity
        bloom.mipmapBlurPass.radius = ppUniforms.bloomRadius
        bloom.luminanceMaterial.threshold = ppUniforms.bloomThreshold
      }

      if (!bloomPassRef.current) {
        bloomPassRef.current = new EffectPass(camera, bloom)
      }
      orderedEffectPasses.push(bloomPassRef.current)
    } else {
      bloomPassRef.current = null
    }

    if (ppUniforms.shockwaveEnabled) {
      const durationSeconds = Math.max(ppUniforms.shockwaveSpeed ?? 1.25, 0.001)
      const effectSpeed = ppUniforms.shockwaveMaxRadius / durationSeconds
      const shockwave = new ShockWaveEffect(
        camera,
        shockwaveEpicenterRef.current,
        {
          speed: effectSpeed,
          maxRadius: ppUniforms.shockwaveMaxRadius,
          waveSize: ppUniforms.shockwaveWaveSize,
          amplitude: ppUniforms.shockwaveAmplitude,
        }
      )
      shockWaveEffectRef.current = shockwave
      orderedEffectPasses.push(new EffectPass(camera, shockwave))
    } else {
      shockWaveEffectRef.current?.dispose()
      shockWaveEffectRef.current = null
    }

    const layerDim = new LayerDimEffect({
      opacity: 1.0,
      maskTexture: gameObjectsMaskRef.current?.texture ?? null,
    })
    layerDimEffectRef.current = layerDim
    orderedEffectPasses.push(new EffectPass(camera, layerDim))

    // 2. Vignette
    if (ppUniforms.vignetteEnabled) {
      let vignette = vignetteEffectRef.current
      if (!vignette) {
        vignette = new VignetteEffect({
          offset: ppUniforms.vignetteOffset,
          darkness: ppUniforms.vignetteDarkness,
        })
        vignetteEffectRef.current = vignette
      } else {
        vignette.offset = ppUniforms.vignetteOffset
        vignette.darkness = ppUniforms.vignetteDarkness
      }

      if (!vignettePassRef.current) {
        vignettePassRef.current = new EffectPass(camera, vignette)
      }
      orderedEffectPasses.push(vignettePassRef.current)
    } else {
      vignettePassRef.current = null
    }

    // 3. Grading
    if (ppUniforms.tintEnabled) {
      const primaryColor = new THREE.Color(ppUniforms.tintColorPrimary)
      const secondaryColor = new THREE.Color(ppUniforms.tintColorSecondary)

      const tint = new TintEffect({
        intensity: ppUniforms.tintIntensity,
        contrast: ppUniforms.tintContrast,
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

    if (ppUniforms.gradingEnabled) {
      const brightnessContrast = new BrightnessContrastEffect({
        brightness: ppUniforms.gradingBrightness,
        contrast: ppUniforms.gradingContrast,
      })
      const hueSaturation = new HueSaturationEffect({
        saturation: ppUniforms.gradingSaturation,
      })

      const brightnessContrastPass = new EffectPass(camera, brightnessContrast)
      const hueSaturationPass = new EffectPass(camera, hueSaturation)
      composer.addPass(brightnessContrastPass)
      composer.addPass(hueSaturationPass)
    }

    // 4. Dithering effect (always on)
    const dither = new DitheringEffect({
      gridSize: ppUniforms.ditheringGridSize ?? 3,
      pixelSizeRatio: ppUniforms.ditheringPixelSizeRatio ?? 1,
      grayscaleOnly: ppUniforms.ditheringGrayscaleOnly ?? false,
      blendFunction: ppUniforms.ditheringBlendMode ?? BlendFunction.SET,
    })
    ditheringEffectRef.current = dither
    orderedEffectPasses.push(new EffectPass(camera, dither))

    // 5. Scanline effect
    if (ppUniforms.scanlinesEnabled) {
      const scanline = new ScanlineEffect({
        intensity: ppUniforms.scanlinesIntensity,
        frequency: ppUniforms.scanlinesFrequency,
        blendMode: ppUniforms.scanlinesBlendMode,
      })
      scanlineEffectRef.current = scanline
      orderedEffectPasses.push(new EffectPass(camera, scanline))
    } else {
      scanlineEffectRef.current?.dispose()
      scanlineEffectRef.current = null
    }

    // 6. Sharpening
    if (ppUniforms.sharpeningEnabled) {
      const sharpen = new SharpenEffect({
        intensity: ppUniforms.sharpeningIntensity,
        radius: ppUniforms.sharpeningRadius,
        threshold: ppUniforms.sharpeningThreshold,
      })
      sharpenEffectRef.current = sharpen
      orderedEffectPasses.push(new EffectPass(camera, sharpen))
    } else {
      sharpenEffectRef.current?.dispose()
      sharpenEffectRef.current = null
    }

    // 7. Exposure - placed last for true fade to black
    if (ppUniforms.exposureEnabled) {
      const exposure = new ExposureEffect({ exposure: 1.0 })
      exposureEffectRef.current = exposure
      orderedEffectPasses.push(new EffectPass(camera, exposure))
    } else {
      exposureEffectRef.current?.dispose()
      exposureEffectRef.current = null
    }

    orderedEffectPasses.forEach((pass) => composer.addPass(pass))

    invalidate()
  }, [scene, camera, composerReady, ppUniforms])

  // Update config for values that matter for synchronization
  useEffect(() => {
    // Shockwave speed impacts how long we remain animating for
    setStarfieldConfig({
      shockwave: {
        shockwaveSpeed: ppUniforms.shockwaveSpeed,
        shockwaveEnabled: ppUniforms.shockwaveEnabled,
      },
    })
  }, [
    ppUniforms.shockwaveSpeed,
    ppUniforms.shockwaveEnabled,
    setStarfieldConfig,
  ])

  const warp = useWarpAnimation()
  const { shockwaveSequence } = useShockwave()
  const { dimOpacity } = useLayerDim()
  const { exposureValue } = useExposure()

  // Animation uniform updates
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

    // Animation uniform updates
    const progress = warp.progress.get()
    const dimValue = dimOpacity.get()

    const ditheringEffect = ditheringEffectRef.current
    if (ditheringEffect) {
      // Only delay the effect on enter, not exit
      const delayedProgress = warp.isWarping
        ? THREE.MathUtils.clamp((progress - 0.4) / (1 - 0.4), 0, 1)
        : progress
      const easedProgress = warp.isWarping
        ? easings.easeInCubic(delayedProgress)
        : easings.easeOutExpo(delayedProgress)

      // Only update if warping or if progress is non-zero to prevent unnecessary recalculations
      if (progress > 0.001) {
        ditheringEffect.uniforms.get("gridSize")!.value = THREE.MathUtils.lerp(
          ppUniforms.ditheringGridSize,
          ppUniforms.ditheringGridSize * 2,
          easedProgress
        )
        ditheringEffect.uniforms.get("pixelSizeRatio")!.value =
          THREE.MathUtils.lerp(
            ppUniforms.ditheringPixelSizeRatio,
            ppUniforms.ditheringPixelSizeRatio * 6,
            easedProgress
          )
      } else {
        // Reset to base values when not warping
        ditheringEffect.uniforms.get("gridSize")!.value =
          ppUniforms.ditheringGridSize
        ditheringEffect.uniforms.get("pixelSizeRatio")!.value =
          ppUniforms.ditheringPixelSizeRatio
      }
    }

    if (ppUniforms.bloomEnabled && bloomEffectRef.current) {
      const easedProgress = warp.isWarping
        ? easings.easeInCubic(progress)
        : easings.easeOutExpo(progress)

      bloomEffectRef.current.intensity = THREE.MathUtils.lerp(
        ppUniforms.bloomIntensity,
        hyerpspaceUniforms.bloomIntensity,
        easedProgress
      )
      bloomEffectRef.current.mipmapBlurPass.radius = THREE.MathUtils.lerp(
        ppUniforms.bloomRadius,
        hyerpspaceUniforms.bloomRadius,
        easedProgress
      )
    }

    if (ppUniforms.vignetteEnabled && vignetteEffectRef.current) {
      const earlyProgress = THREE.MathUtils.clamp(progress / 0.4, 0, 1)
      vignetteEffectRef.current.darkness = THREE.MathUtils.lerp(
        ppUniforms.vignetteDarkness,
        hyerpspaceUniforms.vignetteAmount,
        earlyProgress
      )
    }

    const shockwaveEffect = shockWaveEffectRef.current
    if (shockwaveEffect) {
      const direction = shockwaveDirectionRef.current
      currentCamera.getWorldDirection(direction)
      const epicenter = shockwaveEpicenterRef.current
      epicenter
        .copy(currentCamera.position)
        .add(direction.multiplyScalar(ppUniforms.shockwaveDistance))
      shockwaveEffect.epicenter.copy(epicenter)

      if (shockwaveSequence !== lastShockwaveSequenceRef.current) {
        shockwaveEffect.explode()
        lastShockwaveSequenceRef.current = shockwaveSequence
        invalidate()
      }
    }

    // Update layer dim effect (full screen)
    const layerDimEffect = layerDimEffectRef.current
    if (layerDimEffect) {
      layerDimEffect.opacity = dimValue

      // Update mask texture reference if it was created after the effect
      if (
        gameObjectsMaskRef.current &&
        layerDimEffect.maskTexture !== gameObjectsMaskRef.current.texture
      ) {
        layerDimEffect.maskTexture = gameObjectsMaskRef.current.texture
      }
    }

    // Update exposure effect - driven by warp progress during warps
    const exposureEffect = exposureEffectRef.current
    if (exposureEffect) {
      if (progress > 0.001) {
        // During warp animation, fade based on progress
        // Fade out: progress 0.7 → 1.0 maps to exposure 1.0 → 0.0
        // Fade in: progress 1.0 → 0.0 maps to exposure 0.0 → 1.0
        if (warp.isWarping) {
          // Entering warp - fade out as we approach peak
          const fadeOutStart = 0.7
          const fadeProgress = THREE.MathUtils.clamp(
            (progress - fadeOutStart) / (1 - fadeOutStart),
            0,
            0.5
          )
          exposureEffect.exposure = 1 - fadeProgress
        } else {
          // Exiting warp - fade back in
          exposureEffect.exposure = 1 - progress
        }
      } else {
        // Not warping - use manual exposure value
        exposureEffect.exposure = exposureValue.get()
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

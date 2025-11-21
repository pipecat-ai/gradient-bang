import { useCallback, useEffect, useRef, useState } from "react"
import { easings } from "@react-spring/three"
import { invalidate, useFrame } from "@react-three/fiber"
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
import { DitheringEffect } from "@/fx/DitherEffect"
import { LayerDimEffect } from "@/fx/LayerDimEffect"
import { LensFlareEffect } from "@/fx/LensFlare"
import { ScanlineEffect } from "@/fx/ScanlineEffect"
import { SharpenEffect } from "@/fx/SharpenEffect"
import { TintEffect } from "@/fx/TintEffect"
import { useLayerDim, useShockwave, useWarpAnimation } from "@/hooks/animations"
import { useGameStore } from "@/useGameStore"

/**
 * Component that manages all post-processing effects
 * Configures and applies various effects to the rendered scene
 */
export const PostProcessing = () => {
  const composerRef = useRef<EffectComposer | null>(null)
  const ditheringEffectRef = useRef<DitheringEffect | null>(null)
  const bloomEffectRef = useRef<BloomEffect | null>(null)
  const vignetteEffectRef = useRef<VignetteEffect | null>(null)
  const shockWaveEffectRef = useRef<ShockWaveEffect | null>(null)
  const layerDimEffectRef = useRef<LayerDimEffect | null>(null)
  const sharpenEffectRef = useRef<SharpenEffect | null>(null)
  const scanlineEffectRef = useRef<ScanlineEffect | null>(null)
  const tintEffectRef = useRef<TintEffect | null>(null)
  const lensFlareEffectRef = useRef<LensFlareEffect | null>(null)
  const shockwaveEpicenterRef = useRef(new THREE.Vector3())
  const shockwaveDirectionRef = useRef(new THREE.Vector3())
  const lastShockwaveSequenceRef = useRef(0)

  const [scene, setScene] = useState<THREE.Scene | null>(null)
  const [camera, setCamera] = useState<THREE.Camera | null>(null)
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

  // Effect controls
  const [ppUniforms, set] = useControls(() => ({
    "Post Processing": folder(
      {
        Bloom: folder(
          {
            bloomEnabled: {
              value: true,
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
              value: storedSharpening.sharpeningIntensity ?? 3.0,
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
              step: 0.1,
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
              value: storedDithering.ditheringGridSize ?? 2,
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
              value: BlendFunction.NORMAL,
              options: {
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
        "Lens Flare": folder(
          {
            lensFlareEnabled: {
              value: false,
              label: "Enable Lens Flare",
            },
            lensFlarePositionX: {
              value: -40,
              min: -300,
              max: 300,
              step: 1,
              label: "Position X",
            },
            lensFlarePositionY: {
              value: 30,
              min: -300,
              max: 300,
              step: 1,
              label: "Position Y",
            },
            lensFlarePositionZ: {
              value: -80,
              min: -300,
              max: 300,
              step: 1,
              label: "Position Z",
            },
            lensFlareEnableOcclusion: {
              value: true,
              label: "Enable Occlusion",
            },
            lensFlareAnamorphic: {
              value: false,
              label: "Anamorphic",
            },
            lensFlareColor: {
              value: `#${palette.base.getHexString()}`,
              label: "Color",
            },
            lensFlareBlendMode: {
              value: BlendFunction.SCREEN,
              options: {
                Normal: BlendFunction.NORMAL,
                Add: BlendFunction.ADD,
                Screen: BlendFunction.SCREEN,
                Overlay: BlendFunction.OVERLAY,
                Multiply: BlendFunction.MULTIPLY,
                Lighten: BlendFunction.LIGHTEN,
                Darken: BlendFunction.DARKEN,
                ColorDodge: BlendFunction.COLOR_DODGE,
                ColorBurn: BlendFunction.COLOR_BURN,
                LinearDodge: BlendFunction.LINEAR_DODGE,
                LinearBurn: BlendFunction.LINEAR_BURN,
              },
              label: "Blend Mode",
            },
            lensFlareGlareSize: {
              value: 0.35,
              min: 0,
              max: 1,
              step: 0.01,
              label: "Glare Size",
            },
            lensFlareEnableRays: {
              value: true,
              label: "Enable Star Rays",
            },
            lensFlareStarPoints: {
              value: 6.0,
              min: 3,
              max: 12,
              step: 1,
              label: "Star Points",
            },
            lensFlareStarBurst: {
              value: true,
              label: "Enable Lens Dirt/Patterns",
            },
            lensFlareSecondaryGhosts: {
              value: true,
              label: "Enable Secondary Ghosts",
            },
            lensFlareAdditionalStreaks: {
              value: true,
              label: "Enable Additional Streaks",
            },
            lensFlareSize: {
              value: 0.005,
              min: 0,
              max: 0.1,
              step: 0.001,
              label: "Flare Size",
            },
            lensFlareShape: {
              value: 0.02,
              min: 0,
              max: 0.1,
              step: 0.01,
              label: "Flare Shape",
            },
            lensFlareHaloScale: {
              value: 0.5,
              min: 0,
              max: 2,
              step: 0.1,
              label: "Halo Scale",
            },
            lensFlareGhostScale: {
              value: 0.5,
              min: 0,
              max: 2,
              step: 0.1,
              label: "Ghost Scale",
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
      },
      { collapsed: true, order: -1 }
    ),
  }))

  // Sync palette changes to Leva controls
  useEffect(() => {
    if (
      !storedGrading.tintColorPrimary &&
      !storedGrading.tintColorSecondary &&
      !storedGrading.contrast &&
      !storedGrading.saturation
    ) {
      set({
        lensFlareColor: `#${palette.base.getHexString()}`,
        gradingContrast: palette.contrast,
        gradingSaturation: palette.saturation,
        tintColorPrimary: `#${palette.c1.getHexString()}`,
        tintColorSecondary: `#${palette.c2.getHexString()}`,
      })
    }
  }, [starfieldConfig.palette, palette, storedGrading, set])

  // Memoized resize handler
  const handleResize = useCallback(() => {
    if (composerRef.current) {
      composerRef.current.setSize(window.innerWidth, window.innerHeight)
    }

    // Update lens flare resolution
    if (lensFlareEffectRef.current) {
      const resolution = lensFlareEffectRef.current.uniforms.get("iResolution")
      if (resolution) {
        resolution.value.set(window.innerWidth, window.innerHeight)
      }
    }
  }, [])

  // Handle window resize
  useEffect(() => {
    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [handleResize])

  // Configure post-processing effects
  useEffect(() => {
    if (!scene || !camera || !composerRef.current) return

    console.log("[STARFIELD] PostProcessing - Building Passes")

    const composer = composerRef.current
    composer.removeAllPasses()

    const renderPass = new RenderPass(scene, camera)
    renderPass.clearPass.setClearFlags(true, true, true)
    composer.addPass(renderPass)

    const orderedEffectPasses: EffectPass[] = []

    // 1. Effect passes that sit in the background
    if (ppUniforms.bloomEnabled) {
      const bloom = new BloomEffect({
        luminanceThreshold: ppUniforms.bloomThreshold,
        intensity: ppUniforms.bloomIntensity,
        radius: ppUniforms.bloomRadius,
        mipmapBlur: true,
      })
      bloomEffectRef.current = bloom
      orderedEffectPasses.push(new EffectPass(camera, bloom))
    } else {
      bloomEffectRef.current?.dispose()
      bloomEffectRef.current = null
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

    const layerDim = new LayerDimEffect({ opacity: 1.0 })
    layerDimEffectRef.current = layerDim
    orderedEffectPasses.push(new EffectPass(camera, layerDim))

    if (ppUniforms.lensFlareEnabled) {
      const flareColor = new THREE.Color(ppUniforms.lensFlareColor)
      // Scale color to 0-255 range for shader (shader divides by 256)
      const colorGain = new THREE.Color(
        flareColor.r * 255,
        flareColor.g * 255,
        flareColor.b * 255
      )
      const lensFlare = new LensFlareEffect({
        enabled: true,
        blendFunction: ppUniforms.lensFlareBlendMode,
        anamorphic: ppUniforms.lensFlareAnamorphic,
        colorGain: colorGain,
        glareSize: ppUniforms.lensFlareGlareSize,
        starBurst: ppUniforms.lensFlareStarBurst,
        secondaryGhosts: ppUniforms.lensFlareSecondaryGhosts,
        aditionalStreaks: ppUniforms.lensFlareAdditionalStreaks,
        starPoints: ppUniforms.lensFlareEnableRays
          ? ppUniforms.lensFlareStarPoints
          : 0,
        flareSize: ppUniforms.lensFlareSize,
        flareShape: ppUniforms.lensFlareShape,
        haloScale: ppUniforms.lensFlareHaloScale,
        ghostScale: ppUniforms.lensFlareGhostScale,
        iResolution: [window.innerWidth, window.innerHeight],
        lensPosition: [0, 0],
        sourcePosition: new THREE.Vector3(
          ppUniforms.lensFlarePositionX,
          ppUniforms.lensFlarePositionY,
          ppUniforms.lensFlarePositionZ
        ),
        enableOcclusion: ppUniforms.lensFlareEnableOcclusion,
      })
      lensFlareEffectRef.current = lensFlare
      orderedEffectPasses.push(new EffectPass(camera, lensFlare))
    } else {
      lensFlareEffectRef.current?.dispose()
      lensFlareEffectRef.current = null
    }

    // 2. Vignette
    if (ppUniforms.vignetteEnabled) {
      const vignette = new VignetteEffect({
        offset: ppUniforms.vignetteOffset,
        darkness: ppUniforms.vignetteDarkness,
      })
      vignetteEffectRef.current = vignette
      orderedEffectPasses.push(new EffectPass(camera, vignette))
    } else {
      vignetteEffectRef.current?.dispose()
      vignetteEffectRef.current = null
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

    // 4. Dithering effect
    if (ppUniforms.ditheringEnabled) {
      const dither = new DitheringEffect({
        gridSize: ppUniforms.ditheringGridSize ?? 2,
        pixelSizeRatio: ppUniforms.ditheringPixelSizeRatio ?? 1,
        grayscaleOnly: ppUniforms.ditheringGrayscaleOnly ?? false,
        blendFunction: ppUniforms.ditheringBlendMode ?? BlendFunction.NORMAL,
      })
      ditheringEffectRef.current = dither
      orderedEffectPasses.push(new EffectPass(camera, dither))
    }

    // 5. Scanline effect
    if (ppUniforms.scanlinesEnabled) {
      const scanline = new ScanlineEffect({
        intensity: ppUniforms.scanlinesIntensity,
        frequency: ppUniforms.scanlinesFrequency,
        blendMode: ppUniforms.scanlinesBlendMode,
      })
      scanlineEffectRef.current = scanline
      orderedEffectPasses.push(new EffectPass(camera, scanline))
    }

    // 6. Sharpening - place last for max impact
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

    orderedEffectPasses.forEach((pass) => composer.addPass(pass))

    invalidate()
  }, [scene, camera, ppUniforms, palette])

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

  // Animation uniform updates
  useFrame(({ gl, scene: currentScene, camera: currentCamera }) => {
    // Initialize composer if not yet created
    if (!composerRef.current) {
      composerRef.current = new EffectComposer(gl, {
        stencilBuffer: true,
      })
      handleResize()
    }

    // Update scene and camera references if changed
    if (scene !== currentScene) setScene(currentScene)
    if (camera !== currentCamera) setCamera(currentCamera)

    // Animation uniform updates
    const progress = warp.progress.get()
    const dimValue = dimOpacity.get()

    const ditheringEffect = ditheringEffectRef.current
    if (ditheringEffect) {
      const delayedProgress = THREE.MathUtils.clamp(
        (progress - 0.4) / (1 - 0.4),
        0,
        1
      )
      const easedProgress = warp.isWarping
        ? easings.easeInCubic(delayedProgress)
        : easings.easeOutExpo(delayedProgress)

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
    }

    const bloomEffect = bloomEffectRef.current
    if (bloomEffect) {
      const easedProgress = warp.isWarping
        ? easings.easeInCubic(progress)
        : easings.easeOutExpo(progress)

      bloomEffect.intensity = THREE.MathUtils.lerp(
        ppUniforms.bloomIntensity,
        hyerpspaceUniforms.bloomIntensity,
        easedProgress
      )
      bloomEffect.mipmapBlurPass.radius = THREE.MathUtils.lerp(
        ppUniforms.bloomRadius,
        hyerpspaceUniforms.bloomRadius,
        easedProgress
      )
    }

    const vignetteEffect = vignetteEffectRef.current
    if (vignetteEffect) {
      const earlyProgress = THREE.MathUtils.clamp(progress / 0.4, 0, 1)
      vignetteEffect.darkness = THREE.MathUtils.lerp(
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
    }

    // Update lens flare effect
    const lensFlareEffect = lensFlareEffectRef.current
    if (lensFlareEffect && currentScene) {
      // Update lens flare parameters from controls
      lensFlareEffect.blendMode.blendFunction = ppUniforms.lensFlareBlendMode
      const flareColor = new THREE.Color(ppUniforms.lensFlareColor)
      // Scale color to 0-255 range for shader (shader divides by 256)
      const colorGain = new THREE.Color(
        flareColor.r * 255,
        flareColor.g * 255,
        flareColor.b * 255
      )
      lensFlareEffect.uniforms.get("colorGain")!.value = colorGain
      lensFlareEffect.glareSize = ppUniforms.lensFlareGlareSize
      lensFlareEffect.uniforms.get("anamorphic")!.value =
        ppUniforms.lensFlareAnamorphic
      lensFlareEffect.uniforms.get("starBurst")!.value =
        ppUniforms.lensFlareStarBurst
      lensFlareEffect.uniforms.get("secondaryGhosts")!.value =
        ppUniforms.lensFlareSecondaryGhosts
      lensFlareEffect.uniforms.get("aditionalStreaks")!.value =
        ppUniforms.lensFlareAdditionalStreaks
      lensFlareEffect.uniforms.get("starPoints")!.value =
        ppUniforms.lensFlareEnableRays ? ppUniforms.lensFlareStarPoints : 0
      lensFlareEffect.uniforms.get("flareSize")!.value =
        ppUniforms.lensFlareSize
      lensFlareEffect.uniforms.get("flareShape")!.value =
        ppUniforms.lensFlareShape
      lensFlareEffect.uniforms.get("haloScale")!.value =
        ppUniforms.lensFlareHaloScale
      lensFlareEffect.uniforms.get("ghostScale")!.value =
        ppUniforms.lensFlareGhostScale
      lensFlareEffect.enableOcclusion = ppUniforms.lensFlareEnableOcclusion

      // Update source position (relative to camera)
      lensFlareEffect.sourcePosition.set(
        currentCamera.position.x + ppUniforms.lensFlarePositionX,
        currentCamera.position.y + ppUniforms.lensFlarePositionY,
        currentCamera.position.z + ppUniforms.lensFlarePositionZ
      )

      // Update position and occlusion
      lensFlareEffect.updatePosition(currentCamera, currentScene)
    }

    // Render the composer if available
    composerRef.current?.render()
  }, 1)

  return null
}

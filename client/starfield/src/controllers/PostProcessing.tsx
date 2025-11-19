import { useCallback, useEffect, useRef, useState } from "react"
import { easings } from "@react-spring/three"
import { invalidate, useFrame } from "@react-three/fiber"
import { folder, useControls } from "leva"
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ShockWaveEffect,
  VignetteEffect,
} from "postprocessing"
import * as THREE from "three"

import { DitheringEffect } from "@/fx/DitherEffect"
import { LayerDimEffect } from "@/fx/LayerDimEffect"
import { ScanlineEffect } from "@/fx/ScanlineEffect"
import { SharpenEffect } from "@/fx/SharpenEffect"
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

  const shockwaveEpicenterRef = useRef(new THREE.Vector3())
  const shockwaveDirectionRef = useRef(new THREE.Vector3())
  const lastShockwaveSequenceRef = useRef(0)

  const [scene, setScene] = useState<THREE.Scene | null>(null)
  const [camera, setCamera] = useState<THREE.Camera | null>(null)
  const {
    hyerpspaceUniforms,
    dithering: storedDithering,
    sharpening: storedSharpening,
    vignette: storedVignette,
    shockwave: storedShockwave,
    scanlines: storedScanlines,
  } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const { dimOpacity } = useLayerDim()

  // Effect controls
  const [ppUniforms] = useControls(() => ({
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
              value: storedSharpening.sharpeningIntensity ?? 1.0,
              label: "Intensity",
            },
            sharpeningRadius: {
              value: storedSharpening.sharpeningRadius ?? 3.0,
              label: "Radius",
            },
            sharpeningThreshold: {
              value: storedSharpening.sharpeningThreshold ?? 0.0,
              label: "Threshold",
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
              value: storedDithering.ditheringGridSize ?? 3,
              min: 1,
              max: 20,
              step: 1,
              label: "Effect Resolution",
            },
            ditheringPixelSizeRatio: {
              value: storedDithering.ditheringPixelSizeRatio ?? 1,
              min: 1,
              max: 10,
              step: 1,
              label: "Pixelation Strength",
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
              value: storedScanlines.scanlinesEnabled ?? true,
              label: "Enable Scanlines",
            },
            scanlinesIntensity: {
              value: storedScanlines.scanlinesIntensity ?? 0.3,
              min: 0,
              max: 1,
              step: 0.1,
              label: "Intensity",
            },
            scanlinesFrequency: {
              value: storedScanlines.scanlinesFrequency ?? 1.3,
              min: 0,
              max: 2,
              step: 0.1,
              label: "Frequency",
            },
          },
          { collapsed: true }
        ),
      },
      { collapsed: true, order: -1 }
    ),
  }))

  // Memoized resize handler
  const handleResize = useCallback(() => {
    if (composerRef.current) {
      composerRef.current.setSize(window.innerWidth, window.innerHeight)
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
    composer.addPass(renderPass)

    const orderedEffectPasses: EffectPass[] = []

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

    // Layer dim effect - full screen dimming
    const layerDim = new LayerDimEffect({ opacity: 1.0 })
    layerDimEffectRef.current = layerDim
    orderedEffectPasses.push(new EffectPass(camera, layerDim))

    // Dithering effect
    if (ppUniforms.ditheringEnabled) {
      const dither = new DitheringEffect({
        gridSize: ppUniforms.ditheringGridSize ?? 3,
        pixelSizeRatio: ppUniforms.ditheringPixelSizeRatio ?? 1,
        grayscaleOnly: ppUniforms.ditheringGrayscaleOnly ?? false,
      })
      ditheringEffectRef.current = dither
      orderedEffectPasses.push(new EffectPass(camera, dither))
    }

    // Scanline effect - place before sharpening for max impact
    if (ppUniforms.scanlinesEnabled) {
      const scanline = new ScanlineEffect({
        intensity: ppUniforms.scanlinesIntensity,
        frequency: ppUniforms.scanlinesFrequency,
      })
      scanlineEffectRef.current = scanline
      orderedEffectPasses.push(new EffectPass(camera, scanline))
    }
    // Sharpening - place last for max impact
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
  }, [scene, camera, ppUniforms])

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

  // Animation uniform updates
  useFrame(({ gl, scene: currentScene, camera: currentCamera }) => {
    // Initialize composer if not yet created
    if (!composerRef.current) {
      composerRef.current = new EffectComposer(gl)
      handleResize()
    }

    // Update scene and camera references if changed
    if (scene !== currentScene) setScene(currentScene)
    if (camera !== currentCamera) setCamera(currentCamera)

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

    // Render the composer if available
    composerRef.current?.render()
  }, 1)

  return null
}

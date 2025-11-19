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
  const shockwaveEpicenterRef = useRef(new THREE.Vector3())
  const shockwaveDirectionRef = useRef(new THREE.Vector3())
  const lastShockwaveSequenceRef = useRef(0)
  const [scene, setScene] = useState<THREE.Scene | null>(null)
  const [camera, setCamera] = useState<THREE.Camera | null>(null)
  const {
    vignetteAmount,
    hyerpspaceUniforms,
    shockwaveSpeed: storedShockwaveSpeed,
    shockwaveEnabled: storedShockwaveEnabled,
  } = useGameStore((state) => state.starfieldConfig)
  const setStarfieldConfig = useGameStore((state) => state.setStarfieldConfig)
  const { dimOpacity } = useLayerDim()

  // Effect controls
  const { bloomEnabled, bloomThreshold, bloomIntensity, bloomRadius } =
    useControls({
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
    })

  const { ditheringGridSize, pixelSizeRatio, grayscaleOnly } = useControls({
    Dithering: folder(
      {
        ditheringGridSize: {
          value: 3,
          min: 1,
          max: 20,
          step: 1,
          label: "Effect Resolution",
        },
        pixelSizeRatio: {
          value: 1,
          min: 1,
          max: 10,
          step: 1,
          label: "Pixelation Strength",
        },
        grayscaleOnly: { value: false, label: "Grayscale Only" },
      },
      { collapsed: true }
    ),
  })

  const { vignetteEnabled, vignetteOffset, vignetteDarkness } = useControls({
    Vignette: folder(
      {
        vignetteEnabled: { value: true, label: "Enable Vignette" },
        vignetteOffset: {
          value: 0,
          min: 0,
          max: 1,
          step: 0.01,
          label: "Offset",
        },
        vignetteDarkness: {
          value: vignetteAmount,
          min: 0,
          max: 1.5,
          step: 0.01,
          label: "Darkness",
        },
      },
      { collapsed: true }
    ),
  })

  const [
    {
      shockwaveMaxRadius,
      shockwaveWaveSize,
      shockwaveAmplitude,
      shockwaveDistance,
    },
  ] = useControls(() => ({
    Shockwave: folder(
      {
        shockwaveEnabled: {
          value: storedShockwaveEnabled ?? true,
          label: "Enable Shockwave",
          onChange: (value: boolean) => {
            setStarfieldConfig({ shockwaveEnabled: value })
          },
          transient: true,
        },
        shockwaveSpeed: {
          value: storedShockwaveSpeed ?? 1.25,
          min: 0.1,
          max: 5,
          step: 0.05,
          label: "Speed",
          onChange: (value: number) => {
            setStarfieldConfig({ shockwaveSpeed: value })
          },
        },
        shockwaveMaxRadius: {
          value: 0.8,
          min: 0.1,
          max: 5,
          step: 0.05,
          label: "Max Radius",
        },
        shockwaveWaveSize: {
          value: 0.25,
          min: 0.01,
          max: 1,
          step: 0.01,
          label: "Wave Size",
        },
        shockwaveAmplitude: {
          value: 0.15,
          min: 0,
          max: 1,
          step: 0.01,
          label: "Amplitude",
        },
        shockwaveDistance: {
          value: 2.5,
          min: 0.1,
          max: 20,
          step: 0.1,
          label: "Epicenter Distance",
        },
      },
      { collapsed: true }
    ),
  }))

  useEffect(() => {
    invalidate()
  }, [ditheringGridSize, pixelSizeRatio, grayscaleOnly])

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

    console.log("[STARFIELD] PostProcessing - Rebuilding Pass")

    const composer = composerRef.current
    composer.removeAllPasses()

    const renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    const orderedEffectPasses: EffectPass[] = []

    if (bloomEnabled) {
      const bloom = new BloomEffect({
        luminanceThreshold: bloomThreshold,
        intensity: bloomIntensity,
        radius: bloomRadius,
        mipmapBlur: true,
      })
      bloomEffectRef.current = bloom
      orderedEffectPasses.push(new EffectPass(camera, bloom))
    } else {
      bloomEffectRef.current?.dispose()
      bloomEffectRef.current = null
    }

    if (storedShockwaveEnabled) {
      const durationSeconds = Math.max(storedShockwaveSpeed ?? 1.25, 0.001)
      const effectSpeed = shockwaveMaxRadius / durationSeconds
      const shockwave = new ShockWaveEffect(
        camera,
        shockwaveEpicenterRef.current,
        {
          speed: effectSpeed,
          maxRadius: shockwaveMaxRadius,
          waveSize: shockwaveWaveSize,
          amplitude: shockwaveAmplitude,
        }
      )
      shockWaveEffectRef.current = shockwave
      orderedEffectPasses.push(new EffectPass(camera, shockwave))
    } else {
      shockWaveEffectRef.current?.dispose()
      shockWaveEffectRef.current = null
    }

    if (vignetteEnabled) {
      const vignette = new VignetteEffect({
        offset: vignetteOffset,
        darkness: vignetteDarkness,
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

    // Dithering effect - always active and always last
    const dither = new DitheringEffect({
      gridSize: ditheringGridSize,
      pixelSizeRatio,
      grayscaleOnly,
    })
    ditheringEffectRef.current = dither
    orderedEffectPasses.push(new EffectPass(camera, dither))

    orderedEffectPasses.forEach((pass) => composer.addPass(pass))
  }, [
    scene,
    camera,
    bloomEnabled,
    bloomThreshold,
    bloomIntensity,
    bloomRadius,
    ditheringGridSize,
    pixelSizeRatio,
    grayscaleOnly,
    vignetteEnabled,
    vignetteOffset,
    vignetteDarkness,
    storedShockwaveEnabled,
    shockwaveMaxRadius,
    shockwaveWaveSize,
    shockwaveAmplitude,
    storedShockwaveSpeed,
  ])

  const warp = useWarpAnimation()
  const { shockwaveSequence } = useShockwave()

  // Handle rendering
  useFrame(({ gl, scene: currentScene, camera: currentCamera }) => {
    // Initialize composer if not yet created
    if (!composerRef.current) {
      composerRef.current = new EffectComposer(gl)
      handleResize() // Initial sizing
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
        ditheringGridSize,
        ditheringGridSize * 2,
        easedProgress
      )
      ditheringEffect.uniforms.get("pixelSizeRatio")!.value =
        THREE.MathUtils.lerp(pixelSizeRatio, pixelSizeRatio * 6, easedProgress)
    }

    const bloomEffect = bloomEffectRef.current
    if (bloomEffect) {
      const easedProgress = warp.isWarping
        ? easings.easeInCubic(progress)
        : easings.easeOutExpo(progress)

      bloomEffect.intensity = THREE.MathUtils.lerp(
        bloomIntensity,
        hyerpspaceUniforms.bloomIntensity,
        easedProgress
      )
      bloomEffect.mipmapBlurPass.radius = THREE.MathUtils.lerp(
        bloomRadius,
        hyerpspaceUniforms.bloomRadius,
        easedProgress
      )
    }

    const vignetteEffect = vignetteEffectRef.current
    if (vignetteEffect) {
      const earlyProgress = THREE.MathUtils.clamp(progress / 0.4, 0, 1)
      vignetteEffect.darkness = THREE.MathUtils.lerp(
        vignetteDarkness,
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
        .add(direction.multiplyScalar(shockwaveDistance))
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

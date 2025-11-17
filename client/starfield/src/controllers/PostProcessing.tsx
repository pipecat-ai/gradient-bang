import { useCallback, useEffect, useRef, useState } from "react"
import { easings } from "@react-spring/three"
import { invalidate, useFrame } from "@react-three/fiber"
import { folder, useControls } from "leva"
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
} from "postprocessing"
import * as THREE from "three"

import { DitheringEffect } from "../fx/DitherEffect"
import { useWarpAnimation } from "./AnimationController"

/**
 * Component that manages all post-processing effects
 * Configures and applies various effects to the rendered scene
 */
export const PostProcessing = () => {
  // References
  const composerRef = useRef<EffectComposer | null>(null)
  const ditheringEffectRef = useRef<DitheringEffect | null>(null)
  const bloomEffectRef = useRef<BloomEffect | null>(null)
  const [scene, setScene] = useState<THREE.Scene | null>(null)
  const [camera, setCamera] = useState<THREE.Camera | null>(null)

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
          value: 4,
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

  useEffect(() => {
    invalidate()
  }, [ditheringGridSize, pixelSizeRatio, grayscaleOnly, invalidate])

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

    const composer = composerRef.current
    composer.removeAllPasses()

    // Add required passes in order
    const renderPass = new RenderPass(scene, camera)
    composer.addPass(renderPass)

    if (bloomEnabled) {
      const bloom = new BloomEffect({
        luminanceThreshold: bloomThreshold,
        intensity: bloomIntensity,
        radius: bloomRadius,
        mipmapBlur: true,
      })
      composer.addPass(new EffectPass(camera, bloom))
      bloomEffectRef.current = bloom
    } else {
      bloomEffectRef.current?.dispose()
      bloomEffectRef.current = null
    }

    // Dithering effect - always active
    const dither = new DitheringEffect({
      gridSize: ditheringGridSize,
      pixelSizeRatio,
      grayscaleOnly,
    })
    ditheringEffectRef.current = dither
    composer.addPass(new EffectPass(camera, dither))
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
  ])

  const warp = useWarpAnimation()

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

    const progress = warp.warpProgress.get()

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
      bloomEffect.intensity = THREE.MathUtils.lerp(bloomIntensity, 50, progress)
      bloomEffect.mipmapBlurPass.radius = THREE.MathUtils.lerp(
        bloomRadius,
        1,
        progress
      )
    }
    // Render the composer if available
    composerRef.current?.render()
  }, 1)

  return null
}

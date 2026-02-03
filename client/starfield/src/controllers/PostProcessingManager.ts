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

import { LAYERS } from "@/constants"
import { DitheringEffect } from "@/fx/DitherEffect"
import { ExposureEffect } from "@/fx/ExposureEffect"
import { LayerDimEffect } from "@/fx/LayerDimEffect"
import { SharpenEffect } from "@/fx/SharpenEffect"
import { TintEffect } from "@/fx/TintEffect"
import { useAnimationStore } from "@/useAnimationStore"
import type { RegisterUniformOptions, UniformValue } from "@/useUniformStore"

// Config type matching the flattened controls shape
export interface PPConfig {
  // Sharpening
  sharpening_enabled: boolean
  sharpening_intensity: number
  sharpening_radius: number
  sharpening_threshold: number
  // Dithering
  dithering_enabled: boolean
  dithering_gridSize: number
  dithering_pixelSizeRatio: number
  dithering_blendMode: BlendFunction
  dithering_grayscaleOnly: boolean
  // Grading
  grading_enabled: boolean
  grading_brightness: number
  grading_contrast: number
  grading_saturation: number
  grading_tintEnabled: boolean
  grading_tintIntensity: number
  grading_tintContrast: number
  grading_tintColorPrimary: string
  grading_tintColorSecondary: string
  // Exposure
  exposure_enabled: boolean
  // Shockwave
  shockwave_enabled: boolean
  shockwave_speed: number
  shockwave_maxRadius: number
  shockwave_waveSize: number
  shockwave_amplitude: number
  shockwave_distance: number
}

// Structure tracking for detecting Leva toggles
interface StructureState {
  sharpening_enabled: boolean
  dithering_enabled: boolean
  grading_enabled: boolean
  grading_tintEnabled: boolean
  exposure_enabled: boolean
  shockwave_enabled: boolean
}

// Default exposure config
const DEFAULT_EXPOSURE_CONFIG = {
  amount: 1,
  startAmount: 0,
}

/**
 * PostProcessingManager - Singleton class that manages the post-processing pipeline.
 *
 * - Builds pipeline once on construction
 * - syncParameters() updates uniforms in-place (never re-registers)
 * - handleStructuralChanges() only runs on Leva toggles (add/remove effects)
 * - Uniforms are registered once per effect lifecycle
 */
export class PostProcessingManager {
  private composer: EffectComposer
  private gameObjectsMask: THREE.WebGLRenderTarget

  // Effect instances (nullable - may be toggled off via Leva)
  private layerDim: LayerDimEffect | null = null
  private tint: TintEffect | null = null
  private brightnessContrast: BrightnessContrastEffect | null = null
  private hueSaturation: HueSaturationEffect | null = null
  private dithering: DitheringEffect | null = null
  private sharpen: SharpenEffect | null = null
  private exposure: ExposureEffect | null = null
  private shockwave: ShockWaveEffect | null = null

  // Shockwave state
  private shockwaveEpicenter = new THREE.Vector3()
  private shockwaveDirection = new THREE.Vector3()
  private lastShockwaveSequence = 0
  private shockwavePendingExplode = false

  // Exposure initialization tracking
  private exposureInitialized = false

  // Track current structure for detecting Leva toggles
  private currentStructure: StructureState

  // Track which uniforms we've registered (to avoid re-registration)
  private registeredUniformKeys = new Set<string>()

  // Dependencies passed via constructor
  private gl: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.Camera
  private registerUniform: <T>(
    key: string,
    uniform: UniformValue<T>,
    options?: RegisterUniformOptions<T>
  ) => void
  private removeUniform: (key: string) => void

  constructor(
    gl: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    registerUniform: <T>(
      key: string,
      uniform: UniformValue<T>,
      options?: RegisterUniformOptions<T>
    ) => void,
    removeUniform: (key: string) => void,
    initialConfig: PPConfig,
    initialSize: { width: number; height: number }
  ) {
    // Assign dependencies
    this.gl = gl
    this.scene = scene
    this.camera = camera
    this.registerUniform = registerUniform
    this.removeUniform = removeUniform

    // Create composer
    this.composer = new EffectComposer(gl)
    this.composer.setSize(
      Math.floor(initialSize.width),
      Math.floor(initialSize.height)
    )

    // Create mask render target
    this.gameObjectsMask = new THREE.WebGLRenderTarget(
      Math.floor(initialSize.width),
      Math.floor(initialSize.height),
      {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
      }
    )

    // Initialize structure state from config
    this.currentStructure = {
      sharpening_enabled: initialConfig.sharpening_enabled,
      dithering_enabled: initialConfig.dithering_enabled,
      grading_enabled: initialConfig.grading_enabled,
      grading_tintEnabled: initialConfig.grading_tintEnabled,
      exposure_enabled: initialConfig.exposure_enabled,
      shockwave_enabled: initialConfig.shockwave_enabled,
    }

    // Build the initial pipeline
    this.buildPipeline(initialConfig)

    // Sync initial parameters
    this.syncParameters(initialConfig)

    console.debug("[STARFIELD] PostProcessingManager - Pipeline built")
  }

  /**
   * Builds the post-processing pipeline based on the current structure.
   * Called once on construction, and again only when structure changes (Leva toggles).
   */
  private buildPipeline(config: PPConfig) {
    // Clear existing passes
    this.composer.removeAllPasses()

    // Render pass (always present)
    this.composer.addPass(new RenderPass(this.scene, this.camera))

    // Collect effect passes in order
    const orderedEffectPasses: EffectPass[] = []

    // Layer Dim (always present)
    this.layerDim = new LayerDimEffect({
      opacity: 1.0,
      maskTexture: this.gameObjectsMask.texture,
    })
    this.safeRegisterUniform(
      "ppLayerDimOpacity",
      this.layerDim.uniforms.get("dimOpacity")!,
      { initial: 1.0, meta: { effect: "layerDim" } }
    )
    orderedEffectPasses.push(new EffectPass(this.camera, this.layerDim))

    // Tint (conditional)
    if (config.grading_tintEnabled) {
      this.tint = new TintEffect({
        intensity: config.grading_tintIntensity,
        contrast: config.grading_tintContrast,
        tintColorPrimary: new THREE.Vector3(1, 1, 1),
        tintColorSecondary: new THREE.Vector3(1, 1, 1),
      })
      orderedEffectPasses.push(new EffectPass(this.camera, this.tint))
    } else {
      this.tint = null
    }

    // Grading (conditional)
    if (config.grading_enabled) {
      this.brightnessContrast = new BrightnessContrastEffect({
        brightness: config.grading_brightness,
        contrast: config.grading_contrast,
      })
      this.hueSaturation = new HueSaturationEffect({
        saturation: config.grading_saturation,
      })
      orderedEffectPasses.push(
        new EffectPass(this.camera, this.brightnessContrast)
      )
      orderedEffectPasses.push(new EffectPass(this.camera, this.hueSaturation))
    } else {
      this.brightnessContrast = null
      this.hueSaturation = null
    }

    // Dithering (conditional)
    if (config.dithering_enabled) {
      this.dithering = new DitheringEffect({
        gridSize: config.dithering_gridSize,
        pixelSizeRatio: config.dithering_pixelSizeRatio,
        grayscaleOnly: config.dithering_grayscaleOnly,
        blendFunction: config.dithering_blendMode,
      })
      this.safeRegisterUniform(
        "ppDitheringGridSize",
        this.dithering.uniforms.get("gridSize")!,
        { initial: config.dithering_gridSize, meta: { effect: "dithering" } }
      )
      this.safeRegisterUniform(
        "ppDitheringPixelSizeRatio",
        this.dithering.uniforms.get("pixelSizeRatio")!,
        {
          initial: config.dithering_pixelSizeRatio,
          meta: { effect: "dithering" },
        }
      )
      orderedEffectPasses.push(new EffectPass(this.camera, this.dithering))
    } else {
      this.safeRemoveUniform("ppDitheringGridSize")
      this.safeRemoveUniform("ppDitheringPixelSizeRatio")
      this.dithering = null
    }

    // Sharpening (conditional)
    if (config.sharpening_enabled) {
      this.sharpen = new SharpenEffect({
        intensity: config.sharpening_intensity,
        radius: config.sharpening_radius,
        threshold: config.sharpening_threshold,
      })
      orderedEffectPasses.push(new EffectPass(this.camera, this.sharpen))
    } else {
      this.sharpen = null
    }

    // Exposure (conditional) - placed late for true fade to black
    if (config.exposure_enabled) {
      const initialExposure = this.exposureInitialized
        ? DEFAULT_EXPOSURE_CONFIG.amount
        : DEFAULT_EXPOSURE_CONFIG.startAmount
      this.exposure = new ExposureEffect({
        exposure: initialExposure,
      })
      this.safeRegisterUniform(
        "ppExposure",
        this.exposure.uniforms.get("exposure")!,
        {
          initial: DEFAULT_EXPOSURE_CONFIG.amount,
          meta: { effect: "exposure", min: 0, max: 3, step: 0.01 },
        }
      )
      this.exposureInitialized = true
      orderedEffectPasses.push(new EffectPass(this.camera, this.exposure))
    } else {
      this.safeRemoveUniform("ppExposure")
      this.exposure = null
    }

    // Shockwave (conditional)
    if (config.shockwave_enabled) {
      const durationSeconds = Math.max(config.shockwave_speed, 0.001)
      const effectSpeed = config.shockwave_maxRadius / durationSeconds
      this.shockwave = new ShockWaveEffect(
        this.camera,
        this.shockwaveEpicenter,
        {
          speed: effectSpeed,
          maxRadius: config.shockwave_maxRadius,
          waveSize: config.shockwave_waveSize,
          amplitude: config.shockwave_amplitude,
        }
      )
      // Sync sequence ref so we don't trigger on effect recreation
      this.lastShockwaveSequence = useAnimationStore.getState().shockwaveSequence
      orderedEffectPasses.push(new EffectPass(this.camera, this.shockwave))
    } else {
      this.shockwave = null
    }

    // Add all effect passes
    orderedEffectPasses.forEach((pass) => this.composer.addPass(pass))
  }

  /**
   * Register a uniform only if not already registered.
   * This prevents clobbering animation mutations when structure rebuilds.
   */
  private safeRegisterUniform<T>(
    key: string,
    uniform: UniformValue<T>,
    options?: RegisterUniformOptions<T>
  ) {
    if (!this.registeredUniformKeys.has(key)) {
      this.registerUniform(key, uniform, options)
      this.registeredUniformKeys.add(key)
    }
  }

  /**
   * Remove a uniform and track that it's no longer registered.
   */
  private safeRemoveUniform(key: string) {
    if (this.registeredUniformKeys.has(key)) {
      this.removeUniform(key)
      this.registeredUniformKeys.delete(key)
    }
  }

  /**
   * Updates all effect parameters in-place.
   *
   * IMPORTANT: This method NEVER re-registers uniforms. It only:
   * 1. Checks for structural changes (Leva toggles)
   * 2. Updates effect parameters via setters (mutates existing uniforms)
   */
  syncParameters(config: PPConfig) {
    // Check for structural changes first
    if (this.hasStructuralChanges(config)) {
      this.handleStructuralChanges(config)
      return // buildPipeline already synced initial values
    }

    // Update parameters on existing effects (no uniform registration!)

    // Tint
    if (this.tint) {
      this.tint.intensity = config.grading_tintIntensity
      this.tint.contrast = config.grading_tintContrast
      const primary = new THREE.Color(config.grading_tintColorPrimary)
      const secondary = new THREE.Color(config.grading_tintColorSecondary)
      this.tint.tintColorPrimary.set(primary.r, primary.g, primary.b)
      this.tint.tintColorSecondary.set(secondary.r, secondary.g, secondary.b)
    }

    // Grading
    if (this.brightnessContrast) {
      this.brightnessContrast.brightness = config.grading_brightness
      this.brightnessContrast.contrast = config.grading_contrast
    }
    if (this.hueSaturation) {
      this.hueSaturation.saturation = config.grading_saturation
    }

    // Dithering
    if (this.dithering) {
      this.dithering.setGridSize(config.dithering_gridSize)
      this.dithering.setPixelSizeRatio(config.dithering_pixelSizeRatio)
      this.dithering.setGrayscaleOnly(config.dithering_grayscaleOnly)
    }

    // Sharpening
    if (this.sharpen) {
      this.sharpen.intensity = config.sharpening_intensity
      this.sharpen.radius = config.sharpening_radius
      this.sharpen.threshold = config.sharpening_threshold
    }

    // Shockwave
    if (this.shockwave) {
      const durationSeconds = Math.max(config.shockwave_speed, 0.001)
      this.shockwave.speed = config.shockwave_maxRadius / durationSeconds
      this.shockwave.maxRadius = config.shockwave_maxRadius
      this.shockwave.waveSize = config.shockwave_waveSize
      this.shockwave.amplitude = config.shockwave_amplitude
    }
  }

  /**
   * Check if any enabled flags have changed (Leva toggles)
   */
  private hasStructuralChanges(config: PPConfig): boolean {
    return (
      this.currentStructure.sharpening_enabled !== config.sharpening_enabled ||
      this.currentStructure.dithering_enabled !== config.dithering_enabled ||
      this.currentStructure.grading_enabled !== config.grading_enabled ||
      this.currentStructure.grading_tintEnabled !== config.grading_tintEnabled ||
      this.currentStructure.exposure_enabled !== config.exposure_enabled ||
      this.currentStructure.shockwave_enabled !== config.shockwave_enabled
    )
  }

  /**
   * Handle structural changes - rebuild pipeline when effects are toggled.
   * This is the ONLY time we add/remove effects and register/unregister uniforms.
   */
  private handleStructuralChanges(config: PPConfig) {
    console.debug(
      "[STARFIELD] PostProcessingManager - Structure changed, rebuilding pipeline"
    )

    // Update structure state
    this.currentStructure = {
      sharpening_enabled: config.sharpening_enabled,
      dithering_enabled: config.dithering_enabled,
      grading_enabled: config.grading_enabled,
      grading_tintEnabled: config.grading_tintEnabled,
      exposure_enabled: config.exposure_enabled,
      shockwave_enabled: config.shockwave_enabled,
    }

    // Rebuild the pipeline
    this.buildPipeline(config)
  }

  /**
   * Resize composer and mask target
   */
  setSize(width: number, height: number) {
    this.composer.setSize(width, height)
    this.gameObjectsMask.setSize(Math.floor(width), Math.floor(height))
  }

  /**
   * Render the post-processing pipeline.
   * Call this in useFrame.
   */
  render(
    currentCamera: THREE.Camera,
    shockwaveDistance: number
  ) {
    // Update layer dim mask texture if needed
    if (this.layerDim) {
      if (this.layerDim.maskTexture !== this.gameObjectsMask.texture) {
        this.layerDim.maskTexture = this.gameObjectsMask.texture
      }
    }

    // Update shockwave epicenter and check for trigger
    if (this.shockwave) {
      // Update epicenter position every frame (follows camera)
      currentCamera.getWorldDirection(this.shockwaveDirection)
      this.shockwaveEpicenter
        .copy(currentCamera.position)
        .add(this.shockwaveDirection.multiplyScalar(shockwaveDistance))
      this.shockwave.epicenter.copy(this.shockwaveEpicenter)

      // Handle pending explode (delayed by one frame to avoid huge deltaTime)
      if (this.shockwavePendingExplode) {
        this.shockwavePendingExplode = false
        this.shockwave.explode()
        // Signal actual start time for accurate duration tracking
        useAnimationStore.getState().setShockwaveStartTime(performance.now())
      }

      // Check for new trigger (sequence changed)
      const currentSequence = useAnimationStore.getState().shockwaveSequence
      if (currentSequence !== this.lastShockwaveSequence) {
        this.lastShockwaveSequence = currentSequence
        // Defer explode to next frame so deltaTime is small
        this.shockwavePendingExplode = true
      }
    }

    // Render GAMEOBJECTS to mask render target for dim exclusion
    const originalLayers = currentCamera.layers.mask

    // Set camera to only see GAMEOBJECTS layer
    currentCamera.layers.set(LAYERS.GAMEOBJECTS)

    // Render to mask target with black background
    this.gl.setRenderTarget(this.gameObjectsMask)
    this.gl.setClearColor(0x000000, 0)
    this.gl.clear()
    this.gl.render(this.scene, currentCamera)
    this.gl.setRenderTarget(null)

    // Restore camera layers
    currentCamera.layers.mask = originalLayers

    // Render the composer (excluding OVERLAY layer so tunnel isn't affected by exposure)
    const originalLayersForComposer = currentCamera.layers.mask

    // Disable OVERLAY layer during post-processing
    currentCamera.layers.disable(LAYERS.OVERLAY)

    // Render post-processed scene
    this.composer.render()

    // Render OVERLAY layer (tunnel) on top without post-processing
    currentCamera.layers.set(LAYERS.OVERLAY)
    this.gl.render(this.scene, currentCamera)

    // Restore camera layers
    currentCamera.layers.mask = originalLayersForComposer
  }

  /**
   * Get all registered uniform keys (for cleanup by React component)
   */
  getRegisteredUniformKeys(): string[] {
    return Array.from(this.registeredUniformKeys)
  }

  /**
   * Dispose all resources
   */
  dispose() {
    this.composer.dispose()
    this.gameObjectsMask.dispose()

    // Dispose effects
    this.layerDim?.dispose()
    this.tint?.dispose()
    this.brightnessContrast?.dispose()
    this.hueSaturation?.dispose()
    this.dithering?.dispose()
    this.sharpen?.dispose()
    this.exposure?.dispose()
    this.shockwave?.dispose()

    console.debug("[STARFIELD] PostProcessingManager - Disposed")
  }
}

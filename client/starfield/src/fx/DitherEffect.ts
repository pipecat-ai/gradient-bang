import { BlendFunction, Effect } from "postprocessing"
import * as THREE from "three"

import ditheringShader from "../shaders/DitherShader"

/**
 * Interface for dithering effect options
 */
export interface DitheringEffectOptions {
  resolution?: THREE.Vector2
  gridSize?: number
  luminanceMethod?: number
  invertColor?: boolean
  pixelSizeRatio?: number
  grayscaleOnly?: boolean
  blendFunction?: BlendFunction
}

/**
 * Implementation of the dithering effect
 * Applies a dithering pattern to the rendered scene
 */
export class DitheringEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, THREE.Uniform<number | THREE.Vector2>>

  /**
   * Creates a new dithering effect instance
   * @param options - Configuration options for the effect
   */
  constructor({
    resolution = new THREE.Vector2(1, 1),
    gridSize = 4.0,
    luminanceMethod = 0,
    invertColor = false,
    pixelSizeRatio = 1,
    grayscaleOnly = false,
    blendFunction = BlendFunction.ADD,
  }: DitheringEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, THREE.Uniform<number | THREE.Vector2>>([
      ["resolution", new THREE.Uniform(resolution)],
      ["gridSize", new THREE.Uniform(gridSize)],
      ["luminanceMethod", new THREE.Uniform(luminanceMethod)],
      ["invertColor", new THREE.Uniform(invertColor ? 1 : 0)],
      ["ditheringEnabled", new THREE.Uniform(1)], // Enabled by default
      ["pixelSizeRatio", new THREE.Uniform(pixelSizeRatio)],
      ["grayscaleOnly", new THREE.Uniform(grayscaleOnly ? 1 : 0)],
    ])

    super("DitheringEffect", ditheringShader, {
      blendFunction: blendFunction,
      uniforms,
    })

    this.uniforms = uniforms
  }

  /**
   * Updates the effect parameters on each frame
   * @param renderer - The WebGL renderer
   * @param inputBuffer - The input render target
   * @param deltaTime - Time elapsed since the last frame
   */
  update(
    _renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    _deltaTime: number
  ): void {
    // Update resolution uniform to match current render target
    const resolutionUniform = this.uniforms.get("resolution")
    if (
      resolutionUniform !== undefined &&
      resolutionUniform.value instanceof THREE.Vector2
    ) {
      resolutionUniform.value.set(inputBuffer.width, inputBuffer.height)
    }
  }

  /**
   * Performs initialization tasks
   * @param renderer - The WebGL renderer
   * @param alpha - Whether the renderer uses the alpha channel
   * @param frameBufferType - The type of the main frame buffers
   */
  initialize(): void {
    // No special initialization required for this effect
  }

  /**
   * Sets the grid size for the dithering pattern
   * @param size - The grid size value
   */
  setGridSize(size: number): void {
    const gridSizeUniform = this.uniforms.get("gridSize")
    if (gridSizeUniform !== undefined) {
      gridSizeUniform.value = size
    }
  }

  /**
   * Sets the pixel size ratio for the pixelation effect
   * @param ratio - The pixel size ratio
   */
  setPixelSizeRatio(ratio: number): void {
    const pixelSizeRatioUniform = this.uniforms.get("pixelSizeRatio")
    if (pixelSizeRatioUniform !== undefined) {
      pixelSizeRatioUniform.value = ratio
    }
  }

  /**
   * Enables or disables grayscale-only mode
   * @param grayscaleOnly - Whether to use grayscale only
   */
  setGrayscaleOnly(grayscaleOnly: boolean): void {
    const grayscaleOnlyUniform = this.uniforms.get("grayscaleOnly")
    if (grayscaleOnlyUniform !== undefined) {
      grayscaleOnlyUniform.value = grayscaleOnly ? 1 : 0
    }
  }
}

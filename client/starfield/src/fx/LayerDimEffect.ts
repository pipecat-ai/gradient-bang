import { Effect } from "postprocessing"
import { Uniform } from "three"

/**
 * Interface for layer dim effect options
 */
export interface LayerDimEffectOptions {
  opacity?: number
}

/**
 * Implementation of the layer dimming effect
 * Applies opacity adjustment to dim layers in the rendered scene
 */
export class LayerDimEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, Uniform<number>>

  /**
   * Creates a new layer dim effect instance
   * @param options - Configuration options for the effect
   */
  constructor({ opacity = 1.0 }: LayerDimEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, Uniform<number>>([
      ["dimOpacity", new Uniform(opacity)],
    ])

    super(
      "LayerDimEffect",
      // Fragment shader
      `
      uniform float dimOpacity;
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        // Multiply RGB channels by opacity to dim the layer
        outputColor = vec4(inputColor.rgb * dimOpacity, inputColor.a);
      }
      `,
      {
        uniforms,
      }
    )

    this.uniforms = uniforms
  }

  /**
   * Gets the current opacity value
   */
  get opacity(): number {
    return this.uniforms.get("dimOpacity")!.value
  }

  /**
   * Sets the opacity value for dimming
   * @param value - The opacity value (0.0 = fully dimmed, 1.0 = no dimming)
   */
  set opacity(value: number) {
    this.uniforms.get("dimOpacity")!.value = value
  }
}

import { Effect } from "postprocessing"
import type { Texture } from "three"
import { Uniform } from "three"

/**
 * Interface for layer dim effect options
 */
export interface LayerDimEffectOptions {
  opacity?: number
  maskTexture?: Texture | null
}

/**
 * Implementation of the layer dimming effect
 * Applies opacity adjustment to dim layers in the rendered scene
 * Optionally excludes areas defined by a mask texture
 */
export class LayerDimEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, Uniform<number | Texture | null>>

  /**
   * Creates a new layer dim effect instance
   * @param options - Configuration options for the effect
   */
  constructor({ opacity = 1.0, maskTexture = null }: LayerDimEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, Uniform<number | Texture | null>>([
      ["dimOpacity", new Uniform(opacity)],
      ["maskTexture", new Uniform(maskTexture)],
    ])

    super(
      "LayerDimEffect",
      // Fragment shader
      `
      uniform float dimOpacity;
      uniform sampler2D maskTexture;
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        // Sample the mask texture
        vec4 mask = texture2D(maskTexture, uv);
        
        // If mask has any color (object present), don't dim
        // Otherwise, apply dimming
        float maskValue = max(mask.r, max(mask.g, mask.b));
        float effectiveOpacity = mix(dimOpacity, 1.0, maskValue);
        
        // Multiply RGB channels by opacity to dim the layer
        outputColor = vec4(inputColor.rgb * effectiveOpacity, inputColor.a);
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
    return this.uniforms.get("dimOpacity")!.value as number
  }

  /**
   * Sets the opacity value for dimming
   * @param value - The opacity value (0.0 = fully dimmed, 1.0 = no dimming)
   */
  set opacity(value: number) {
    this.uniforms.get("dimOpacity")!.value = value
  }

  /**
   * Gets the current mask texture
   */
  get maskTexture(): Texture | null {
    return this.uniforms.get("maskTexture")!.value as Texture | null
  }

  /**
   * Sets the mask texture for excluding areas from dimming
   * @param value - The mask texture (white = no dim, black = dim)
   */
  set maskTexture(value: Texture | null) {
    this.uniforms.get("maskTexture")!.value = value
  }
}

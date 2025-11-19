import { Effect } from "postprocessing"
import { Uniform } from "three"

/**
 * Interface for scanline effect options
 */
export interface ScanlineEffectOptions {
  intensity?: number
  frequency?: number
}

/**
 * Implementation of the scanline effect
 * Applies horizontal scanlines for a retro CRT monitor look
 */
export class ScanlineEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, Uniform>

  /**
   * Creates a new scanline effect instance
   * @param options - Configuration options for the effect
   */
  constructor({
    intensity = 0.3,
    frequency = 1.0,
  }: ScanlineEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, Uniform>([
      ["intensity", new Uniform(intensity)],
      ["frequency", new Uniform(frequency)],
    ])

    super(
      "ScanlineEffect",
      // Fragment shader using mainImage signature
      `
      uniform float intensity;
      uniform float frequency;
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 resolution = vec2(textureSize(inputBuffer, 0));
        
        // Calculate scanline effect
        float scanline = sin(uv.y * resolution.y * frequency) * intensity + (1.0 - intensity);
        
        // Apply scanlines to the input color
        vec3 finalColor = inputColor.rgb * scanline;
        
        outputColor = vec4(finalColor, inputColor.a);
      }
      `,
      {
        uniforms,
      }
    )

    this.uniforms = uniforms
  }

  /**
   * Gets the current intensity value
   */
  get intensity(): number {
    return this.uniforms.get("intensity")!.value
  }

  /**
   * Sets the intensity value (0.0 = no effect, 1.0 = full black lines)
   */
  set intensity(value: number) {
    this.uniforms.get("intensity")!.value = value
  }

  /**
   * Gets the current frequency value
   */
  get frequency(): number {
    return this.uniforms.get("frequency")!.value
  }

  /**
   * Sets the frequency value (higher = more scanlines)
   */
  set frequency(value: number) {
    this.uniforms.get("frequency")!.value = value
  }
}

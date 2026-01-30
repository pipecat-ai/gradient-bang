import { Effect } from "postprocessing"
import { Uniform } from "three"

/**
 * Interface for exposure effect options
 */
export interface ExposureEffectOptions {
  exposure?: number
}

/**
 * Simple exposure effect that multiplies scene color by exposure value
 * Provides true black at exposure=0, normal at exposure=1
 */
export class ExposureEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, Uniform>

  /**
   * Creates a new exposure effect instance
   * @param options - Configuration options for the effect
   */
  constructor({ exposure = 1.0 }: ExposureEffectOptions = {}) {
    const uniforms = new Map<string, Uniform>([
      ["exposure", new Uniform(exposure)],
    ])

    super(
      "ExposureEffect",
      `
      uniform float exposure;
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
      }
      `,
      {
        uniforms,
      }
    )

    this.uniforms = uniforms
  }

  /**
   * Gets the current exposure value
   */
  get exposure(): number {
    return this.uniforms.get("exposure")!.value
  }

  /**
   * Sets the exposure value (0.0 = black, 1.0 = normal, >1.0 = brighter)
   */
  set exposure(value: number) {
    this.uniforms.get("exposure")!.value = value
  }
}

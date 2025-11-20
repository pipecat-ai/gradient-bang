import { Effect } from "postprocessing"
import { Uniform, Vector3 } from "three"

/**
 * Interface for tint effect options
 */
export interface TintEffectOptions {
  intensity?: number
  contrast?: number
  tintColorPrimary?: Vector3
  tintColorSecondary?: Vector3
}

/**
 * Implementation of the tint effect
 * Applies a color tint based on scene brightness for a terminal-like appearance
 */
export class TintEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, Uniform>

  /**
   * Creates a new tint effect instance
   * @param options - Configuration options for the effect
   */
  constructor({
    intensity = 0.5,
    contrast = 1.0,
    tintColorPrimary = new Vector3(0.0, 1.0, 0.0), // Green
    tintColorSecondary = new Vector3(1.0, 0.75, 0.0), // Amber
  }: TintEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, Uniform>([
      ["intensity", new Uniform(intensity)],
      ["contrast", new Uniform(contrast)],
      ["tintColorPrimary", new Uniform(tintColorPrimary)],
      ["tintColorSecondary", new Uniform(tintColorSecondary)],
    ])

    super(
      "TintEffect",
      // Fragment shader using mainImage signature
      `
      uniform float intensity;
      uniform float contrast;
      uniform vec3 tintColorPrimary;
      uniform vec3 tintColorSecondary;
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        // Sample the input color
        vec3 sceneColor = inputColor.rgb;
        
        // Convert scene to brightness
        float brightness = dot(sceneColor, vec3(0.299, 0.587, 0.114));
        brightness = pow(brightness * contrast, 1.5);
        
        // Mix between primary and secondary tint colors based on brightness
        vec3 tintColor = mix(
          tintColorPrimary,
          tintColorSecondary,
          brightness * 0.5
        );
        
        // Apply tint effect - blend the original scene with the tinted brightness
        vec3 finalColor = mix(sceneColor, tintColor * brightness, intensity);
        
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
   * Sets the intensity value (0.0 = original scene, 1.0 = full tint)
   */
  set intensity(value: number) {
    this.uniforms.get("intensity")!.value = value
  }

  /**
   * Gets the current contrast value
   */
  get contrast(): number {
    return this.uniforms.get("contrast")!.value
  }

  /**
   * Sets the contrast value
   */
  set contrast(value: number) {
    this.uniforms.get("contrast")!.value = value
  }

  /**
   * Gets the primary tint color
   */
  get tintColorPrimary(): Vector3 {
    return this.uniforms.get("tintColorPrimary")!.value
  }

  /**
   * Sets the primary tint color
   */
  set tintColorPrimary(value: Vector3) {
    this.uniforms.get("tintColorPrimary")!.value = value
  }

  /**
   * Gets the secondary tint color
   */
  get tintColorSecondary(): Vector3 {
    return this.uniforms.get("tintColorSecondary")!.value
  }

  /**
   * Sets the secondary tint color
   */
  set tintColorSecondary(value: Vector3) {
    this.uniforms.get("tintColorSecondary")!.value = value
  }
}

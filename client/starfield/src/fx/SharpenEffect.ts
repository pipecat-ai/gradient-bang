import { Effect } from "postprocessing"
import { Uniform } from "three"

/**
 * Interface for sharpen effect options
 */
export interface SharpenEffectOptions {
  intensity?: number
  radius?: number
  threshold?: number
}

/**
 * Implementation of the sharpen effect
 * Applies unsharp mask sharpening to the rendered scene
 */
export class SharpenEffect extends Effect {
  /**
   * Map of uniforms used by the shader
   */
  uniforms: Map<string, Uniform>

  /**
   * Creates a new sharpen effect instance
   * @param options - Configuration options for the effect
   */
  constructor({
    intensity = 1.0,
    radius = 1.0,
    threshold = 0.0,
  }: SharpenEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, Uniform>([
      ["intensity", new Uniform(intensity)],
      ["radius", new Uniform(radius)],
      ["threshold", new Uniform(threshold)],
    ])

    super(
      "SharpenEffect",
      // Fragment shader using mainImage signature
      `
      uniform float intensity;
      uniform float radius;
      uniform float threshold;
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 texelSize = 1.0 / vec2(textureSize(inputBuffer, 0));
        
        // Sample the center pixel
        vec3 center = inputColor.rgb;
        
        // Sample neighboring pixels for blur calculation
        vec3 blur = vec3(0.0);
        float totalWeight = 0.0;
        
        // Create a simple box blur kernel
        float r = radius;
        for (float x = -r; x <= r; x += 1.0) {
          for (float y = -r; y <= r; y += 1.0) {
            vec2 offset = vec2(x, y) * texelSize;
            vec3 sampleColor = texture(inputBuffer, uv + offset).rgb;
            float weight = 1.0 / ((2.0 * r + 1.0) * (2.0 * r + 1.0));
            blur += sampleColor * weight;
            totalWeight += weight;
          }
        }
        blur /= totalWeight;
        
        // Calculate the difference between center and blurred
        vec3 diff = center - blur;
        
        // Apply threshold to avoid sharpening noise
        float diffMagnitude = length(diff);
        if (diffMagnitude < threshold) {
          diff = vec3(0.0);
        }
        
        // Apply sharpening by adding the difference back
        vec3 sharpened = center + diff * intensity;
        
        // Clamp to prevent oversaturation
        sharpened = clamp(sharpened, 0.0, 1.0);
        
        outputColor = vec4(sharpened, inputColor.a);
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
   * Sets the intensity value
   */
  set intensity(value: number) {
    this.uniforms.get("intensity")!.value = value
  }

  /**
   * Gets the current radius value
   */
  get radius(): number {
    return this.uniforms.get("radius")!.value
  }

  /**
   * Sets the radius value
   */
  set radius(value: number) {
    this.uniforms.get("radius")!.value = value
  }

  /**
   * Gets the current threshold value
   */
  get threshold(): number {
    return this.uniforms.get("threshold")!.value
  }

  /**
   * Sets the threshold value
   */
  set threshold(value: number) {
    this.uniforms.get("threshold")!.value = value
  }
}

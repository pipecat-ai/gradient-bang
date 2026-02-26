import { Effect } from "postprocessing"
import { Uniform } from "three"

/**
 * Interface for sharpen effect options
 */
export interface SharpenEffectOptions {
  intensity?: number
  radius?: number
}

/**
 * Laplacian sharpening effect.
 * Uses 4 neighbour samples at a configurable distance (radius).
 * Larger radius detects wider-scale edges, producing an AO-like halo.
 */
export class SharpenEffect extends Effect {
  uniforms: Map<string, Uniform>

  constructor({ intensity = 1.0, radius = 1.0 }: SharpenEffectOptions = {}) {
    const uniforms = new Map<string, Uniform>([
      ["intensity", new Uniform(intensity)],
      ["radius", new Uniform(radius)],
    ])

    super(
      "SharpenEffect",
      `
      uniform float intensity;
      uniform float radius;

      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 texelSize = radius / vec2(textureSize(inputBuffer, 0));

        // 4-tap Laplacian: sample NSEW neighbours at radius distance
        vec3 n = texture(inputBuffer, uv + vec2(0.0, texelSize.y)).rgb;
        vec3 s = texture(inputBuffer, uv - vec2(0.0, texelSize.y)).rgb;
        vec3 e = texture(inputBuffer, uv + vec2(texelSize.x, 0.0)).rgb;
        vec3 w = texture(inputBuffer, uv - vec2(texelSize.x, 0.0)).rgb;

        // Laplacian = center * 4 - (n + s + e + w)
        vec3 laplacian = inputColor.rgb * 4.0 - (n + s + e + w);

        // Add scaled edge signal back to sharpen
        vec3 sharpened = inputColor.rgb + laplacian * intensity;

        outputColor = vec4(clamp(sharpened, 0.0, 1.0), inputColor.a);
      }
      `,
      {
        uniforms,
      }
    )

    this.uniforms = uniforms
  }

  get intensity(): number {
    return this.uniforms.get("intensity")!.value
  }

  set intensity(value: number) {
    this.uniforms.get("intensity")!.value = value
  }

  get radius(): number {
    return this.uniforms.get("radius")!.value
  }

  set radius(value: number) {
    this.uniforms.get("radius")!.value = value
  }
}

import { Effect } from "postprocessing"
import { Uniform, Vector3 } from "three"

/**
 * Interface for scanline/terminal effect options
 */
export interface ScanlineEffectOptions {
  time?: number
  intensity?: number
  cellSize?: number
  characterDensity?: number
  contrast?: number
  scanlineIntensity?: number
  scanlineFrequency?: number
  scanlinesEnabled?: boolean
  terminalColorPrimary?: Vector3
  terminalColorSecondary?: Vector3
}

/**
 * Implementation of the scanline/terminal effect
 * Applies retro terminal-style rendering with ASCII characters and scanlines
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
    time = 0.0,
    intensity = 0.0,
    cellSize = 8.0,
    characterDensity = 0.5,
    contrast = 1.0,
    scanlineIntensity = 0.3,
    scanlineFrequency = 1.0,
    scanlinesEnabled = false,
    terminalColorPrimary = new Vector3(0.0, 1.0, 0.0), // Green
    terminalColorSecondary = new Vector3(1.0, 0.75, 0.0), // Amber
  }: ScanlineEffectOptions = {}) {
    // Initialize uniforms with default values
    const uniforms = new Map<string, Uniform>([
      ["time", new Uniform(time)],
      ["intensity", new Uniform(intensity)],
      ["cellSize", new Uniform(cellSize)],
      ["characterDensity", new Uniform(characterDensity)],
      ["contrast", new Uniform(contrast)],
      ["scanlineIntensity", new Uniform(scanlineIntensity)],
      ["scanlineFrequency", new Uniform(scanlineFrequency)],
      ["scanlinesEnabled", new Uniform(scanlinesEnabled)],
      ["terminalColorPrimary", new Uniform(terminalColorPrimary)],
      ["terminalColorSecondary", new Uniform(terminalColorSecondary)],
    ])

    super(
      "ScanlineEffect",
      // Fragment shader using mainImage signature
      `
      uniform float time;
      uniform float intensity;
      uniform float cellSize;
      uniform float characterDensity;
      uniform float contrast;
      uniform float scanlineIntensity;
      uniform float scanlineFrequency;
      uniform bool scanlinesEnabled;
      uniform vec3 terminalColorPrimary;
      uniform vec3 terminalColorSecondary;
      
      // Hash function for random character generation
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      
      // Generate ASCII-like characters
      float getCharacter(vec2 cellUV, float brightness) {
        vec2 charPos = cellUV * 8.0; // 8x8 character grid
        vec2 grid = floor(charPos);
        vec2 charUV = fract(charPos);
        
        // Hash based on cell position and brightness level
        float charIndex = hash(grid + floor(brightness * 8.0));
        
        // Generate different character patterns based on brightness
        float char = 0.0;
        
        if (brightness > 0.8) {
          // Dense characters for bright areas (█, ▓)
          char = step(0.2, charUV.x) * step(0.2, charUV.y) * 
                 (1.0 - step(0.8, charUV.x)) * (1.0 - step(0.8, charUV.y));
        } else if (brightness > 0.6) {
          // Medium characters (▒, ░)
          char = step(0.3, mod(charUV.x + charUV.y + charIndex, 0.6));
        } else if (brightness > 0.4) {
          // Sparse characters (., :, ;)
          char = step(0.7, hash(charUV + charIndex)) * 
                 step(distance(charUV, vec2(0.5)), 0.2);
        } else if (brightness > 0.2) {
          // Very sparse (single pixels)
          char = step(0.9, hash(charUV + charIndex)) * 
                 step(distance(charUV, vec2(0.5)), 0.1);
        }
        
        return char * step(characterDensity, hash(grid * 0.1 + time * 0.001));
      }
      
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 resolution = vec2(textureSize(inputBuffer, 0));
        vec2 screenUV = uv;
        
        // Sample the actual rendered scene
        vec3 sceneColor = inputColor.rgb;
        
        // Get cell coordinates
        vec2 cellCoord = floor(screenUV * resolution / cellSize);
        vec2 cellUV = fract(screenUV * resolution / cellSize);
        
        // Convert scene to brightness
        float brightness = dot(sceneColor, vec3(0.299, 0.587, 0.114));
        brightness = pow(brightness * contrast, 1.5);
        
        // Generate terminal character
        float terminalChar = getCharacter(cellUV, brightness);
        
        // Terminal colors (configurable)
        vec3 terminalColor = mix(
          terminalColorPrimary,   // Primary color (default: green)
          terminalColorSecondary, // Secondary color (default: amber)
          brightness * 0.5
        );
        
        // Apply terminal effect
        vec3 finalColor = sceneColor;
        
        if (intensity > 0.0) {
          if (terminalChar > 0.0) {
            // Replace scene with terminal characters
            finalColor = mix(sceneColor, terminalColor * terminalChar, intensity);
          } else {
            // Dark areas become black in terminal mode
            finalColor = mix(sceneColor, vec3(0.0), intensity * 0.3);
          }
        }
        
        // Add configurable scan lines (only if enabled)
        if (scanlinesEnabled) {
          float scanline = sin(screenUV.y * resolution.y * scanlineFrequency) * scanlineIntensity + (1.0 - scanlineIntensity);
          finalColor *= scanline;
        }
        
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
   * Gets the current time value
   */
  get time(): number {
    return this.uniforms.get("time")!.value
  }

  /**
   * Sets the time value (for animation)
   */
  set time(value: number) {
    this.uniforms.get("time")!.value = value
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
   * Gets the current cell size value
   */
  get cellSize(): number {
    return this.uniforms.get("cellSize")!.value
  }

  /**
   * Sets the cell size value
   */
  set cellSize(value: number) {
    this.uniforms.get("cellSize")!.value = value
  }

  /**
   * Gets the current character density value
   */
  get characterDensity(): number {
    return this.uniforms.get("characterDensity")!.value
  }

  /**
   * Sets the character density value
   */
  set characterDensity(value: number) {
    this.uniforms.get("characterDensity")!.value = value
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
   * Gets the current scanline intensity value
   */
  get scanlineIntensity(): number {
    return this.uniforms.get("scanlineIntensity")!.value
  }

  /**
   * Sets the scanline intensity value
   */
  set scanlineIntensity(value: number) {
    this.uniforms.get("scanlineIntensity")!.value = value
  }

  /**
   * Gets the current scanline frequency value
   */
  get scanlineFrequency(): number {
    return this.uniforms.get("scanlineFrequency")!.value
  }

  /**
   * Sets the scanline frequency value
   */
  set scanlineFrequency(value: number) {
    this.uniforms.get("scanlineFrequency")!.value = value
  }

  /**
   * Gets whether scanlines are enabled
   */
  get scanlinesEnabled(): boolean {
    return this.uniforms.get("scanlinesEnabled")!.value
  }

  /**
   * Sets whether scanlines are enabled
   */
  set scanlinesEnabled(value: boolean) {
    this.uniforms.get("scanlinesEnabled")!.value = value
  }

  /**
   * Gets the primary terminal color
   */
  get terminalColorPrimary(): Vector3 {
    return this.uniforms.get("terminalColorPrimary")!.value
  }

  /**
   * Sets the primary terminal color
   */
  set terminalColorPrimary(value: Vector3) {
    this.uniforms.get("terminalColorPrimary")!.value = value
  }

  /**
   * Gets the secondary terminal color
   */
  get terminalColorSecondary(): Vector3 {
    return this.uniforms.get("terminalColorSecondary")!.value
  }

  /**
   * Sets the secondary terminal color
   */
  set terminalColorSecondary(value: Vector3) {
    this.uniforms.get("terminalColorSecondary")!.value = value
  }
}

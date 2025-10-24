/**
 * ConfigUniformMapper - Declarative config-to-uniform mapping
 * Provides type-safe configuration-to-uniform conversion with comprehensive mapping support
 */

import { type FrameState, type RGBColor } from "./types";
import { type GalaxyStarfieldConfig } from "./constants";
import { UniformManager } from "./managers/UniformManager";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Uniform mapping definition types */
export type UniformMapping = string | UniformMappingConfig;

/** Complex uniform mapping with type conversion */
export interface UniformMappingConfig {
  uniform: string;
  type: "vec3" | "vec2" | "color" | "texture" | "float" | "int" | "bool";
  transform?: (value: unknown) => unknown;
}

/** Material-specific uniform mappings */
export interface MaterialMappings {
  [configKey: string]: UniformMapping;
}

/** Complete mapping configuration for all materials */
export interface ConfigMappings {
  clouds: MaterialMappings;
  nebula: MaterialMappings;
  terminal: MaterialMappings;
  sharpen: MaterialMappings;
  colorAdjust: MaterialMappings;
  background: MaterialMappings;
}

/** Star-specific configuration mappings */
export interface StarConfigMappings {
  [configKey: string]: string;
}

/** Shadow center coordinates */
export interface ShadowCenter {
  x: number;
  y: number;
}

/** Frame-based uniform updates */
export interface FrameUpdates {
  [materialId: string]: {
    [uniformName: string]: unknown;
  };
}

// ============================================================================
// CONFIG UNIFORM MAPPER CLASS
// ============================================================================

/**
 * ConfigUniformMapper Class
 * Handles declarative mapping from configuration values to shader uniforms
 * with type safety and performance optimization
 */
export class ConfigUniformMapper {
  private uniformManager: UniformManager;
  private mappings: ConfigMappings;

  constructor(uniformManager: UniformManager) {
    this.uniformManager = uniformManager;

    // Define all config-to-uniform mappings in one place
    this.mappings = {
      clouds: {
        cloudsIntensity: "intensity",
        cloudsSpeed: "speed",
        cloudsIterPrimary: "iterPrimary",
        cloudsIterSecondary: "iterSecondary",
        cloudsDomainScale: "domainScale",
        cloudsParallaxAmount: "parallaxAmount",
        cloudsColor: { uniform: "color", type: "vec3" },
        cloudsColorPrimary: { uniform: "cloudsColorPrimary", type: "vec3" },
        cloudsColorSecondary: { uniform: "cloudsColorSecondary", type: "vec3" },
      },
      nebula: {
        nebulaIntensity: "intensity",
        nebulaPosterizeLevels: "posterizeLevels",
        nebulaDitherAmount: "ditherAmount",
        nebulaPixelateScale: "pixelateScale",
        nebulaIdleNoiseSpeed: "nebulaIdleNoiseSpeed",
        nebulaDriftSpeed: "driftSpeed",
        nebulaAnisotropy: "anisotropy",
        nebulaDomainWarpStrength: "domainWarpStrength",
        nebulaFilamentContrast: "filamentContrast",
        nebulaDarkLaneStrength: "darkLaneStrength",
        nebulaColor1: { uniform: "nebulaColor1", type: "vec3" },
        nebulaColor2: { uniform: "nebulaColor2", type: "vec3" },
        nebulaColorMid: { uniform: "nebulaColorMid", type: "vec3" },
      },
      terminal: {
        terminalIntensity: "intensity",
        terminalCellSize: "cellSize",
        terminalCharacterDensity: "characterDensity",
        terminalContrast: "contrast",
        terminalScanlineIntensity: "scanlineIntensity",
        terminalScanlineFrequency: "scanlineFrequency",
        terminalScanlinesEnabled: "scanlinesEnabled",
        terminalColorPrimary: { uniform: "terminalColorPrimary", type: "vec3" },
        terminalColorSecondary: {
          uniform: "terminalColorSecondary",
          type: "vec3",
        },
      },
      sharpen: {
        sharpenIntensity: "intensity",
        sharpenRadius: "radius",
        sharpenThreshold: "threshold",
      },
      colorAdjust: {
        colorAdjustBrightness: "brightness",
        colorAdjustContrast: "contrast",
        colorAdjustSaturation: "saturation",
        colorAdjustGamma: "gamma",
        colorAdjustShadows: { uniform: "shadows", type: "vec3" },
        colorAdjustMidtones: { uniform: "midtones", type: "vec3" },
        colorAdjustHighlights: { uniform: "highlights", type: "vec3" },
      },
      background: {
        planetOpacity: "opacity",
      },
    };
  }

  /**
   * Apply all config updates based on what changed
   */
  public applyAllUpdates(
    newConfig: Partial<GalaxyStarfieldConfig>,
    currentConfig: GalaxyStarfieldConfig
  ): void {
    // Process each material type
    Object.keys(this.mappings).forEach((materialId) => {
      this.applyConfigUpdates(materialId, newConfig, currentConfig);
    });

    // Handle star-specific updates
    this.applyStarUpdates(newConfig, currentConfig);
  }

  /**
   * Apply config updates to a specific material
   */
  public applyConfigUpdates(
    materialId: string,
    newConfig: Partial<GalaxyStarfieldConfig>,
    currentConfig: GalaxyStarfieldConfig
  ): void {
    const mapping = this.mappings[materialId as keyof ConfigMappings];
    if (!mapping || !this.uniformManager.hasMaterial(materialId)) {
      return;
    }

    const updates: { [uniformName: string]: unknown } = {};

    for (const [configKey, uniformDef] of Object.entries(mapping)) {
      if (!(configKey in newConfig)) continue;

      const configValue =
        currentConfig[configKey as keyof GalaxyStarfieldConfig];
      if (configValue === undefined) continue;

      if (typeof uniformDef === "string") {
        updates[uniformDef] = configValue;
      } else if (uniformDef.type === "vec3" && configValue) {
        // Handle RGB color conversion to Vector3
        const rgbValue = configValue as RGBColor;
        updates[uniformDef.uniform] = {
          x: rgbValue.r || 0,
          y: rgbValue.g || 0,
          z: rgbValue.b || 0,
        };
      } else if (uniformDef.transform) {
        // Apply custom transformation
        updates[uniformDef.uniform] = uniformDef.transform(configValue);
      } else {
        // Direct mapping with type conversion
        updates[uniformDef.uniform] = configValue;
      }
    }

    if (Object.keys(updates).length > 0) {
      this.uniformManager.updateUniforms(materialId, updates);
    }
  }

  /**
   * Apply updates to star layers
   */
  public applyStarUpdates(
    newConfig: Partial<GalaxyStarfieldConfig>,
    currentConfig: GalaxyStarfieldConfig
  ): void {
    const starUpdates: { [uniformName: string]: unknown } = {};

    const starConfigs: StarConfigMappings = {
      fogNear: "fogNear",
      fogFar: "fogFar",
      twinkleIntensity: "twinkleIntensity",
      motionBlurIntensity: "motionBlurIntensity",
    };

    for (const [configKey, uniformName] of Object.entries(starConfigs)) {
      if (configKey in newConfig) {
        starUpdates[uniformName] =
          currentConfig[configKey as keyof GalaxyStarfieldConfig];
      }
    }

    // Apply star updates to star materials using pattern matching
    if (Object.keys(starUpdates).length > 0) {
      this.uniformManager.updateUniformsByPattern(/^star/, starUpdates);
    }
  }

  /**
   * Get frame-based uniform updates for animation states
   */
  public getFrameUpdates(
    state: FrameState,
    config: GalaxyStarfieldConfig,
    dimmingFactors?: { [materialId: string]: number }
  ): FrameUpdates {
    const updates: FrameUpdates = {};

    // Terminal updates (only if enabled)
    if (config.terminalEnabled) {
      updates.terminal = {
        intensity: config.terminalIntensity,
        cellSize: config.terminalCellSize,
        characterDensity: config.terminalCharacterDensity,
        contrast: config.terminalContrast,
        scanlineIntensity: config.terminalScanlineIntensity,
        scanlineFrequency: config.terminalScanlineFrequency,
        scanlinesEnabled: config.terminalScanlinesEnabled,
        terminalColorPrimary: {
          x: config.terminalColorPrimary.r,
          y: config.terminalColorPrimary.g,
          z: config.terminalColorPrimary.b,
        },
        terminalColorSecondary: {
          x: config.terminalColorSecondary.r,
          y: config.terminalColorSecondary.g,
          z: config.terminalColorSecondary.b,
        },
      };
    }

    // Background updates
    if (this.uniformManager.hasMaterial("background")) {
      // Determine if planet should shake
      const shouldShake =
        state.currentState === "shake" ||
        (state.currentState === "warping" &&
          state.warpPhase !== "FLASH" &&
          state.warpPhase !== "COOLDOWN" &&
          state.warpPhase !== "IDLE");

      updates.background = {
        opacity: this.calculateBackgroundOpacity(
          config,
          dimmingFactors?.background
        ),
        shakeIntensity: state.currentShakeIntensity || 0,
        shakePhase: state.shakePhase || 0,
        shakeAmplitude: shouldShake
          ? (state.currentShakeIntensity || 0) * (config.shakeAmplitude || 0.02)
          : 0,
        warpProgress: state.warpProgress || 0,
        tunnelEffect: state.tunnelEffectValue || 0,
      };
    }

    // Nebula updates
    if (this.uniformManager.hasMaterial("nebula")) {
      updates.nebula = {
        warpProgress: state.warpProgress || 0,
        tunnelEffect: state.tunnelEffectValue || 0,
        intensity: this.calculateNebulaIntensity(
          state,
          config,
          dimmingFactors?.nebula
        ),
      };
    }

    // Clouds updates
    if (this.uniformManager.hasMaterial("clouds")) {
      updates.clouds = {
        resolution: { x: window.innerWidth, y: window.innerHeight },
        cameraRotation: state.cameraRotation,
        intensity: this.calculateCloudsIntensity(
          state,
          config,
          dimmingFactors?.clouds
        ),
        speed: this.calculateCloudsSpeed(state, config),
        domainScale: config.cloudsDomainScale,
        shakeWarpIntensity: config.cloudsShakeWarpIntensity,
        shakeWarpRampTime: config.cloudsShakeWarpRampTime,
        noiseUse: this.calculateNoiseUse(state),
        shakePhase:
          state.currentState === "shake" || state.currentState === "warping"
            ? (state.shakePhase || 0) * 0.1 // Scale down and use smooth transition
            : 0,
        cloudsShakeProgress: state.cloudsShakeProgress || 0,
      };
    }

    // Star updates
    updates.stars = {
      shakeIntensity: state.currentShakeIntensity,
      warpProgress: state.warpProgress,
      tunnelEffect: state.tunnelEffectValue,
    };

    return updates;
  }

  /**
   * Calculate dynamic clouds intensity based on state and dimming
   */
  private calculateCloudsIntensity(
    state: FrameState,
    config: GalaxyStarfieldConfig,
    dimmingFactor?: number
  ): number {
    let baseIntensity = config.cloudsIntensity;

    if (state.currentState === "shake") {
      // Increase intensity during shake
      baseIntensity =
        config.cloudsIntensity * (1 + state.currentShakeIntensity * 0.5);
    } else if (state.currentState === "warping") {
      // Reduce intensity during warp
      baseIntensity = config.cloudsIntensity * (1 - state.warpProgress * 0.3);
    }

    // Apply dimming factor if provided
    if (dimmingFactor !== undefined) {
      baseIntensity *= dimmingFactor;
    }

    return baseIntensity;
  }

  /**
   * Calculate dynamic nebula intensity based on state and dimming
   */
  private calculateNebulaIntensity(
    state: FrameState,
    config: GalaxyStarfieldConfig,
    dimmingFactor?: number
  ): number {
    let baseIntensity = config.nebulaIntensity || 1.0;

    if (state.currentState === "shake") {
      // Increase intensity during shake
      baseIntensity = baseIntensity * (1 + state.currentShakeIntensity * 0.3);
    } else if (state.currentState === "warping") {
      // Reduce intensity during warp
      baseIntensity = baseIntensity * (1 - state.warpProgress * 0.5);
    }

    // Apply dimming factor if provided
    if (dimmingFactor !== undefined) {
      baseIntensity *= dimmingFactor;
    }

    return baseIntensity;
  }

  /**
   * Calculate dynamic background opacity based on dimming
   */
  private calculateBackgroundOpacity(
    config: GalaxyStarfieldConfig,
    dimmingFactor?: number
  ): number {
    let baseOpacity = config.planetOpacity || 1.0;

    // Apply dimming factor if provided
    if (dimmingFactor !== undefined) {
      baseOpacity *= dimmingFactor;
    }

    return baseOpacity;
  }

  /**
   * Calculate dynamic clouds speed based on state
   */
  private calculateCloudsSpeed(
    state: FrameState,
    config: GalaxyStarfieldConfig
  ): number {
    if (state.currentState === "shake") {
      return config.cloudsSpeed * config.cloudShakeSpeed;
    }

    if (state.currentState === "warping") {
      return (
        config.cloudsSpeed *
        config.cloudWarpSpeed *
        (1 + state.warpProgress * 2)
      );
    }

    return config.cloudsSpeed;
  }

  /**
   * Calculate noise usage for performance optimization
   */
  private calculateNoiseUse(state: FrameState): number {
    if (state.currentState === "warping") {
      // Reduce noise complexity during warp for performance
      return Math.max(0.3, 1 - state.warpProgress * 0.7);
    }

    return 1.0; // Full noise usage by default
  }

  /**
   * Apply frame updates to all materials
   */
  public applyFrameUpdates(frameUpdates: FrameUpdates): void {
    for (const [materialId, updates] of Object.entries(frameUpdates)) {
      if (this.uniformManager.hasMaterial(materialId)) {
        this.uniformManager.updateUniforms(materialId, updates);
      }
    }
  }

  /**
   * Get all material mappings for debugging
   */
  public getMappings(): ConfigMappings {
    return { ...this.mappings };
  }

  /**
   * Check if a config key affects a specific material
   */
  public affectsMaterial(configKey: string, materialId: string): boolean {
    const mapping = this.mappings[materialId as keyof ConfigMappings];
    return mapping ? configKey in mapping : false;
  }

  /**
   * Get all config keys that affect any material
   */
  public getAllMappedConfigKeys(): string[] {
    const keys = new Set<string>();

    for (const mapping of Object.values(this.mappings) as MaterialMappings[]) {
      for (const configKey of Object.keys(mapping)) {
        keys.add(configKey);
      }
    }

    return Array.from(keys);
  }

  /**
   * Validate that all mapped config keys exist in the configuration
   */
  public validateMappings(_config: GalaxyStarfieldConfig): string[] {
    const errors: string[] = [];
    const allKeys = this.getAllMappedConfigKeys();

    for (const key of allKeys) {
      if (!((key as keyof GalaxyStarfieldConfig) in _config)) {
        errors.push(`Missing config key: ${key}`);
      }
    }

    return errors;
  }
}

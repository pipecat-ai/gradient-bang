/**
 * Scene Manager
 * Manages scene generation and configuration cycling for the starfield
 */

import {
  DEFAULT_GALAXY_CONFIG,
  type GalaxyStarfieldConfig,
  NEBULA_PALETTES,
  type NebulaPalette,
  PLANET_IMAGES,
  type StarfieldSceneConfig,
} from "../constants";
import customDeepmerge from "../utils/merge";

// Type definitions for SceneManager
interface SceneMetadata {
  configId?: string;
  storedAt?: number;
  mergedWithRandom?: boolean;
  updatedAt?: number;
  sceneId?: number;
}

type StoredConfig = GalaxyStarfieldConfig & SceneMetadata;

interface SceneHistoryEntry {
  id: number;
  timestamp: number;
  config: StoredConfig;
  sourceConfigId?: string;
}

export class SceneManager {
  public currentSceneId: number;
  private sceneHistory: SceneHistoryEntry[];
  private namedConfigs: Map<string, StoredConfig | StarfieldSceneConfig>;

  constructor() {
    this.currentSceneId = 0;
    this.sceneHistory = [];
    this.namedConfigs = new Map();
  }

  /**
   * Store a scene variant (lightweight, recommended for scene transitions)
   */
  storeSceneVariant(
    configId: string,
    variant: StarfieldSceneConfig
  ): StarfieldSceneConfig {
    this.namedConfigs.set(configId, variant);
    return variant;
  }

  /**
   * Store a named configuration that can be retrieved later
   */
  storeNamedConfig(
    configId: string,
    customConfig: Partial<GalaxyStarfieldConfig> = {},
    mergeWithRandom: boolean = true
  ): StoredConfig {
    let finalConfig: StoredConfig;

    if (mergeWithRandom) {
      const randomNebula = this._getRandomNebula();
      const randomPlanet = this._getRandomPlanet();
      const baseConfig = this._cycleDefaultConfig(randomNebula, randomPlanet);

      finalConfig = customDeepmerge(baseConfig, customConfig) as StoredConfig;
    } else {
      finalConfig = customDeepmerge(
        DEFAULT_GALAXY_CONFIG,
        customConfig
      ) as StoredConfig;
    }

    finalConfig.configId = configId;
    finalConfig.storedAt = Date.now();
    finalConfig.mergedWithRandom = mergeWithRandom;

    this.namedConfigs.set(configId, JSON.parse(JSON.stringify(finalConfig)));

    return finalConfig;
  }

  /**
   * Retrieve a stored named configuration
   */
  getNamedConfig(configId: string): StoredConfig | StarfieldSceneConfig | null {
    const config = this.namedConfigs.get(configId);
    if (!config) {
      console.warn(
        `[STARFIELD] SceneManager: Named config "${configId}" not found`
      );
      return null;
    }

    return JSON.parse(JSON.stringify(config));
  }

  /**
   * Check if a named config exists
   */
  hasNamedConfig(configId: string): boolean {
    return this.namedConfigs.has(configId);
  }

  /**
   * Get all stored named config IDs
   */
  getNamedConfigIds(): string[] {
    return Array.from(this.namedConfigs.keys());
  }

  /**
   * Prepare a scene variant for a sector (get existing or create new)
   * This is the main method to use for scene transitions
   * @param id - Sector/scene identifier
   * @param sceneConfig - Partial scene config (merges with random defaults), undefined = fully random
   * @param gameObjects - Base game object configs to add to scene
   * @param gameObjectManager - Manager to generate full game object configs
   */
  prepareSceneVariant(
    id: string,
    sceneConfig: Partial<StarfieldSceneConfig> | undefined
  ): StarfieldSceneConfig {
    // Map planetImageIndex to planetImageUrl if provided
    const mappedConfig = this._mapPlanetIndex(sceneConfig);

    if (this.hasNamedConfig(id)) {
      const stored = this.getNamedConfig(id) as StarfieldSceneConfig;

      return {
        ...stored,
        ...mappedConfig,
      };
    } else {
      const variant = this.createVariant(mappedConfig);
      this.storeSceneVariant(id, variant);
      return variant;
    }
  }

  /**
   * Create a scene variant config (lightweight, only scene-varying properties)
   * Accepts partial config - missing properties are randomized
   * @param options - Partial scene config (any missing properties get random values)
   */
  createVariant(
    options: Partial<StarfieldSceneConfig> = {}
  ): StarfieldSceneConfig {
    const randomNebula = this._getRandomNebula();
    const randomPlanet = this._getRandomPlanetVariant();

    const randomDefaults: StarfieldSceneConfig = {
      nebulaColor1: randomNebula.c1,
      nebulaColor2: randomNebula.c2,
      nebulaColorMid: randomNebula.mid,
      nebulaIntensity: Math.random() * 2 + 0.15,
      nebulaDarkLaneStrength: Math.random() * 0.65 + 0.35,
      nebulaDomainWarpStrength: Math.random() * 0.3 + 0.05,
      nebulaIdleNoiseSpeed: Math.random() * 0.15 + 0.02,
      nebulaAnisotropy: Math.random() * 2.5 + 1.0,
      nebulaFilamentContrast: Math.random() * 0.8 + 0.2,

      cloudsIntensity: Math.random() * 0.65 + 0.22,
      cloudsColorPrimary: randomNebula.c1,
      cloudsColorSecondary: randomNebula.c2,
      cloudsIterPrimary: Math.floor(Math.random() * 20) + 10,
      cloudsIterSecondary: Math.floor(Math.random() * 10) + 1,
      cloudsDomainScale: Math.random() * 0.99 + 0.5,
      cloudsSpeed: Math.random() * 0.005 + 0.001,

      planetImageUrl: randomPlanet.url,
      planetScale: randomPlanet.scale,
      planetPositionX: randomPlanet.positionX,
      planetPositionY: randomPlanet.positionY,

      starSize: Math.random() * 0.5 + 0.75,
    };

    return { ...randomDefaults, ...options };
  }

  /**
   * Create a completely new scene configuration
   */
  create(options: Partial<GalaxyStarfieldConfig> = {}): StoredConfig {
    const randomNebula = this._getRandomNebula();
    const randomPlanet = this._getRandomPlanet();

    const freshConfig = this._cycleDefaultConfig(randomNebula, randomPlanet);

    const finalConfig: StoredConfig = customDeepmerge(
      freshConfig,
      options
    ) as StoredConfig;

    this.currentSceneId++;
    finalConfig.sceneId = this.currentSceneId;

    this.sceneHistory.push({
      id: this.currentSceneId,
      timestamp: Date.now(),
      config: JSON.parse(JSON.stringify(finalConfig)),
    });

    if (this.sceneHistory.length > 10) {
      this.sceneHistory.shift();
    }

    return finalConfig;
  }

  /**
   * Map planetImageIndex to planetImageUrl using PLANET_IMAGES array
   * Only maps if planetImageUrl is not already provided (URL takes precedence)
   * @private
   */
  private _mapPlanetIndex(
    config: Partial<StarfieldSceneConfig> | undefined
  ): Partial<StarfieldSceneConfig> {
    if (!config) return {};

    const mapped = { ...config };

    // If planetImageUrl is already provided, use it directly (no mapping needed)
    if (mapped.planetImageUrl) {
      delete mapped.planetImageIndex; // Clean up index if both are present
      return mapped;
    }

    // Otherwise, map planetImageIndex to planetImageUrl
    if (
      mapped.planetImageIndex !== undefined &&
      mapped.planetImageIndex >= 0 &&
      mapped.planetImageIndex < PLANET_IMAGES.length
    ) {
      mapped.planetImageUrl = PLANET_IMAGES[mapped.planetImageIndex];
      delete mapped.planetImageIndex; // Remove index from final config
    }

    return mapped;
  }

  /**
   * Get a random nebula palette
   * @private
   */
  private _getRandomNebula(): NebulaPalette {
    return NEBULA_PALETTES[Math.floor(Math.random() * NEBULA_PALETTES.length)];
  }

  /**
   * Get a random planet image
   * @private
   */
  private _getRandomPlanet(): string {
    return PLANET_IMAGES[Math.floor(Math.random() * PLANET_IMAGES.length)];
  }

  /**
   * Get random planet properties for scene variants
   * @private
   */
  private _getRandomPlanetVariant(): {
    url: string;
    scale: number;
    positionX: number;
    positionY: number;
  } {
    return {
      url: PLANET_IMAGES[Math.floor(Math.random() * PLANET_IMAGES.length)],
      scale: Math.random() * 4 + 2,
      positionX: (Math.random() - 0.5) * 400,
      positionY: (Math.random() - 0.5) * 400,
    };
  }

  /**
   * Cycle through the default config to generate fresh random values
   * @private
   */
  private _cycleDefaultConfig(
    randomNebula: NebulaPalette,
    randomPlanet: string
  ): GalaxyStarfieldConfig {
    const config: GalaxyStarfieldConfig = { ...DEFAULT_GALAXY_CONFIG };

    config.nebulaDomainWarpStrength = Math.random() * 0.3 + 0.05;
    config.nebulaIdleNoiseSpeed = Math.random() * 0.15 + 0.02;
    config.nebulaAnisotropy = Math.random() * 2.5 + 1.0;
    config.nebulaFilamentContrast = Math.random() * 0.8 + 0.2;
    config.nebulaDarkLaneStrength = Math.random() * 0.65 + 0.35;

    config.cloudsIntensity = Math.random() * 0.65 + 0.22;
    config.cloudsColorPrimary = randomNebula.c1;
    config.cloudsColorSecondary = randomNebula.c2;
    config.cloudsIterPrimary = Math.floor(Math.random() * 20) + 10;
    config.cloudsIterSecondary = Math.floor(Math.random() * 10) + 1;
    config.cloudsDomainScale = Math.random() * 0.99 + 0.5;
    config.cloudsShakeWarpIntensity = Math.random() * 0.08 + 0.01;
    config.cloudsShakeWarpRampTime = Math.random() * 8 + 2;
    config.cloudsSpeed = Math.random() * 0.005 + 0.001;

    config.nebulaColor1 = randomNebula.c1;
    config.nebulaColor2 = randomNebula.c2;
    config.nebulaColorMid = randomNebula.mid;

    config.planetImageUrl = randomPlanet;
    config.planetScale = Math.random() * 3 + 1.5;
    config.planetSpawnRangeX = Math.random() * 200 + 300;
    config.planetSpawnRangeY = Math.random() * 200 + 300;

    config.planetPositionX = (Math.random() - 0.5) * config.planetSpawnRangeX;
    config.planetPositionY = (Math.random() - 0.5) * config.planetSpawnRangeY;

    config.starSize = Math.random() * 0.5 + 0.75;

    return config;
  }

  /**
   * Reset scene manager
   */
  reset(): void {
    this.currentSceneId = 0;
    this.sceneHistory = [];
    this.namedConfigs.clear();
  }
}

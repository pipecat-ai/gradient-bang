/**
 * Scene Manager
 * Manages scene generation and configuration cycling for the starfield
 */

import {
  DEFAULT_GALAXY_CONFIG,
  NEBULA_PALETTES,
  PLANET_IMAGES,
  type GalaxyStarfieldConfig,
  type NebulaPalette,
  type StarfieldSceneConfig,
} from "../constants";
import {
  type GameObjectBaseConfig,
  type GameObjectConfig,
  type GameObjectSpawnRules,
} from "../types/GameObject";
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
    console.debug(
      `[STARFIELD] SceneManager: Storing scene variant: ${configId}`
    );

    // Store variant directly (much smaller than full config)
    this.namedConfigs.set(configId, variant);

    console.debug(
      `[STARFIELD] SceneManager: Scene variant "${configId}" stored successfully`
    );
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
    console.debug(
      `[STARFIELD] SceneManager: Storing named config: ${configId}`
    );

    let finalConfig: StoredConfig;

    if (mergeWithRandom) {
      // Generate fresh random values and merge with custom config
      const randomNebula = this._getRandomNebula();
      const randomPlanet = this._getRandomPlanet();
      const baseConfig = this._cycleDefaultConfig(randomNebula, randomPlanet);

      // Merge: base random config + custom overrides
      // Use custom deepmerge with arrays replaced, not merged
      finalConfig = customDeepmerge(baseConfig, customConfig) as StoredConfig;
    } else {
      // Use custom config as-is, only filling in missing required properties
      finalConfig = customDeepmerge(
        DEFAULT_GALAXY_CONFIG,
        customConfig
      ) as StoredConfig;
    }

    // Add metadata
    finalConfig.configId = configId;
    finalConfig.storedAt = Date.now();
    finalConfig.mergedWithRandom = mergeWithRandom;

    // Store the config - store a deep copy to preserve all values exactly
    this.namedConfigs.set(configId, JSON.parse(JSON.stringify(finalConfig)));

    console.debug(
      `[STARFIELD] SceneManager: Named config "${configId}" stored successfully`
    );
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

    console.debug(
      `[STARFIELD] SceneManager: Retrieved named config: ${configId}`
    );
    console.debug(
      `[STARFIELD] SceneManager: Sector "${configId}" configuration:`,
      config
    );
    // Return a deep copy to prevent modification and preserve all values exactly
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
    sceneConfig: Partial<StarfieldSceneConfig> | undefined,
    gameObjects: GameObjectBaseConfig[],
    gameObjectManager: {
      generateGameObjectConfig: (
        config: GameObjectBaseConfig
      ) => GameObjectConfig;
    } | null
  ): StarfieldSceneConfig {
    // Check if we already have a scene variant stored
    if (this.hasNamedConfig(id)) {
      console.debug(
        `[STARFIELD] SceneManager: Loading existing scene variant for: ${id}`
      );
      const stored = this.getNamedConfig(id) as StarfieldSceneConfig;

      // Merge stored variant with any overrides from sceneConfig
      const merged = {
        ...stored,
        ...(sceneConfig || {}),
      };

      // Add game objects if provided
      if (gameObjects.length > 0 && gameObjectManager) {
        merged.gameObjects = gameObjects.map((baseConfig) =>
          gameObjectManager.generateGameObjectConfig(baseConfig)
        );
      }

      return merged;
    } else {
      // Create new scene variant (sceneConfig can be partial, undefined, or complete)
      console.debug(
        `[STARFIELD] SceneManager: Creating new scene variant for: ${id}`
      );
      const variant = this.createVariant(sceneConfig || {});

      // Add game objects if provided
      if (gameObjects.length > 0 && gameObjectManager) {
        variant.gameObjects = gameObjects.map((baseConfig) =>
          gameObjectManager.generateGameObjectConfig(baseConfig)
        );
      }

      // Store the variant for future retrieval
      this.storeSceneVariant(id, variant);

      console.debug(
        `[STARFIELD] SceneManager: Created scene variant:`,
        variant
      );
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
    console.debug(
      "[STARFIELD] SceneManager: createVariant() called with options:",
      options
    );

    // Generate fresh random values for variant properties only
    const randomNebula = this._getRandomNebula();
    const randomPlanet = this._getRandomPlanetVariant();

    console.debug(
      "[STARFIELD] SceneManager: Generated random planet:",
      randomPlanet
    );

    // Build variant with random defaults (matches _cycleDefaultConfig logic)
    const randomDefaults: StarfieldSceneConfig = {
      // Nebula variant
      nebulaColor1: randomNebula.c1,
      nebulaColor2: randomNebula.c2,
      nebulaColorMid: randomNebula.mid,
      nebulaIntensity: Math.random() * 2 + 0.15, // 0.15 to 2.15
      nebulaDarkLaneStrength: Math.random() * 0.65 + 0.35, // 0.35 to 1.0
      nebulaDomainWarpStrength: Math.random() * 0.3 + 0.05, // 0.05 to 0.35
      nebulaIdleNoiseSpeed: Math.random() * 0.15 + 0.02, // 0.02 to 0.17
      nebulaAnisotropy: Math.random() * 2.5 + 1.0, // 1.0 to 3.5
      nebulaFilamentContrast: Math.random() * 0.8 + 0.2, // 0.2 to 1.0

      // Clouds variant
      cloudsIntensity: Math.random() * 0.65 + 0.22, // 0.22 to 0.87
      cloudsColorPrimary: randomNebula.c1,
      cloudsColorSecondary: randomNebula.c2,
      cloudsIterPrimary: Math.floor(Math.random() * 20) + 10, // 10 to 30
      cloudsIterSecondary: Math.floor(Math.random() * 10) + 1, // 1 to 11
      cloudsDomainScale: Math.random() * 0.99 + 0.5, // 0.5 to 1.49
      cloudsSpeed: Math.random() * 0.005 + 0.001, // 0.001 to 0.006

      // Planet variant
      planetImageUrl: randomPlanet.url,
      planetScale: randomPlanet.scale,
      planetPositionX: randomPlanet.positionX,
      planetPositionY: randomPlanet.positionY,

      // Star size variant
      starSize: Math.random() * 0.5 + 0.75, // 0.75 to 1.25

      // Game objects (empty by default, added separately)
      gameObjects: [],
    };

    // Merge random defaults with any provided options (options take priority)
    return { ...randomDefaults, ...options };
  }

  /**
   * Create a completely new scene configuration
   */
  create(options: Partial<GalaxyStarfieldConfig> = {}): StoredConfig {
    // Generate fresh random values for properties that should vary
    const randomNebula = this._getRandomNebula();
    const randomPlanet = this._getRandomPlanet();

    // Create fresh config by cycling through the default config
    const freshConfig = this._cycleDefaultConfig(randomNebula, randomPlanet);

    // Apply any custom overrides using custom deepmerge
    const finalConfig: StoredConfig = customDeepmerge(
      freshConfig,
      options
    ) as StoredConfig;

    // Game object logic:
    // 1. If options provided game objects, use them (stored config scenario)
    // 2. If no game objects provided but we're in debug mode, generate new ones
    // 3. Otherwise, use empty array
    if (options.gameObjects && options.gameObjects.length > 0) {
      // Use provided game objects (from stored config)
      finalConfig.gameObjects = options.gameObjects;
      console.debug(
        "[STARFIELD] SceneManager: Using provided game objects from stored config"
      );
    } else if (finalConfig.debugMode) {
      // Generate new game objects for debug mode
      finalConfig.gameObjects = this._generateGameObjects(finalConfig);
      console.debug(
        "[STARFIELD] SceneManager: Generated fresh game objects for debug mode"
      );
    } else {
      // No game objects for non-debug mode
      finalConfig.gameObjects = [];
      console.debug(
        "[STARFIELD] SceneManager: No game objects generated (not in debug mode)"
      );
    }

    // Generate unique scene ID
    this.currentSceneId++;
    finalConfig.sceneId = this.currentSceneId;

    // Store in history - store a deep copy to preserve all values
    this.sceneHistory.push({
      id: this.currentSceneId,
      timestamp: Date.now(),
      config: JSON.parse(JSON.stringify(finalConfig)),
    });

    // Keep only last 10 scenes in history
    if (this.sceneHistory.length > 10) {
      this.sceneHistory.shift();
    }

    return finalConfig;
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
    // Start with the default config but override ALL random properties with fresh values
    const config: GalaxyStarfieldConfig = { ...DEFAULT_GALAXY_CONFIG };

    // Override ALL properties that were computed at import time with fresh random values

    // Nebula properties - completely fresh random values
    config.nebulaDomainWarpStrength = Math.random() * 0.3 + 0.05; // 0.05 to 0.35
    config.nebulaIdleNoiseSpeed = Math.random() * 0.15 + 0.02; // 0.02 to 0.17
    config.nebulaAnisotropy = Math.random() * 2.5 + 1.0; // 1.0 to 3.5
    config.nebulaFilamentContrast = Math.random() * 0.8 + 0.2; // 0.2 to 1.0
    config.nebulaDarkLaneStrength = Math.random() * 0.65 + 0.35; // 0.35 to 1.0

    // Cloud properties - completely fresh random values
    config.cloudsIntensity = Math.random() * 0.65 + 0.22; // 0.22 to 0.87
    config.cloudsColorPrimary = randomNebula.c1;
    config.cloudsColorSecondary = randomNebula.c2;
    config.cloudsIterPrimary = Math.floor(Math.random() * 20) + 10; // 10 to 30
    config.cloudsIterSecondary = Math.floor(Math.random() * 10) + 1; // 1 to 11
    config.cloudsDomainScale = Math.random() * 0.99 + 0.5; // 0.5 to 1.49
    config.cloudsShakeWarpIntensity = Math.random() * 0.08 + 0.01; // 0.01 to 0.09
    config.cloudsShakeWarpRampTime = Math.random() * 8 + 2; // 2 to 10
    config.cloudsSpeed = Math.random() * 0.005 + 0.001; // 0.001 to 0.006

    // Nebula colors - use the same palette for consistency
    config.nebulaColor1 = randomNebula.c1;
    config.nebulaColor2 = randomNebula.c2;
    config.nebulaColorMid = randomNebula.mid;

    // Planet properties - completely fresh random values
    config.planetImageUrl = randomPlanet;
    config.planetScale = Math.random() * 3 + 1.5; // 2 to 6
    config.planetSpawnRangeX = Math.random() * 200 + 300; // 300 to 500
    config.planetSpawnRangeY = Math.random() * 200 + 300; // 300 to 500

    // Set deterministic planet positions for this sector
    config.planetPositionX = (Math.random() - 0.5) * config.planetSpawnRangeX;
    config.planetPositionY = (Math.random() - 0.5) * config.planetSpawnRangeY;

    // Star properties - completely fresh random values
    config.starSize = Math.random() * 0.5 + 0.75; // 0.75 to 1.25

    return config;
  }

  /**
   * Generate game objects for a new scene
   * @private
   */
  private _generateGameObjects(
    config: GalaxyStarfieldConfig
  ): GameObjectConfig[] {
    const gameObjects: GameObjectConfig[] = [];
    let objectId = 1;

    // If debug mode is enabled, generate random game objects
    if (config.debugMode && config.debugGameObjectCounts) {
      Object.entries(config.debugGameObjectCounts).forEach(([type, count]) => {
        for (let i = 0; i < count; i++) {
          const position = this._generateRandomPosition(
            config.gameObjectSpawnRules
          );
          gameObjects.push({
            id: `${type}_${objectId++}`,
            type: type as "playerShip" | "starport" | "npc",
            name: `${type.charAt(0).toUpperCase() + type.slice(1)} ${i + 1}`,
            position: position,
            rotation: { x: 0, y: 0, z: 0 },
            scale:
              config.gameObjectTypes[
                type as keyof typeof config.gameObjectTypes
              ].scale,
            metadata: {
              lastSeen: Date.now(),
            },
          });
        }
      });
    }

    console.debug(
      `[STARFIELD] SceneManager: Generated ${gameObjects.length} game objects for new scene`
    );
    return gameObjects;
  }

  /**
   * Generate a random position within spawn rules
   * @private
   */
  private _generateRandomPosition(spawnRules: GameObjectSpawnRules): Vector3 {
    const x = (Math.random() - 0.5) * 2 * spawnRules.spawnRange.x;
    const y = (Math.random() - 0.5) * 2 * spawnRules.spawnRange.y;
    const z = (Math.random() - 0.5) * 2 * spawnRules.spawnRange.z;

    const position: Vector3 = { x, y, z };
    const distance = Math.sqrt(x * x + y * y + z * z);

    // Ensure minimum distance from player
    if (distance < spawnRules.minDistance) {
      const scale =
        spawnRules.minDistance +
        Math.random() * (spawnRules.maxDistance - spawnRules.minDistance);
      const normalized = distance > 0 ? scale / distance : scale;
      position.x *= normalized;
      position.y *= normalized;
      position.z *= normalized;
    }

    // Ensure maximum distance from player
    if (distance > spawnRules.maxDistance) {
      const scale = spawnRules.maxDistance / distance;
      position.x *= scale;
      position.y *= scale;
      position.z *= scale;
    }

    return position;
  }

  /**
   * Reset scene manager
   */
  reset(): void {
    this.currentSceneId = 0;
    this.sceneHistory = [];
    this.namedConfigs.clear();
    console.debug("[STARFIELD] SceneManager: Reset complete");
  }
}

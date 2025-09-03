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
} from "../constants";
import {
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
  private currentSceneId: number;
  private sceneHistory: SceneHistoryEntry[];
  private namedConfigs: Map<string, StoredConfig>;

  constructor() {
    this.currentSceneId = 0;
    this.sceneHistory = [];
    this.namedConfigs = new Map();
  }

  /**
   * Store a named configuration that can be retrieved later
   */
  storeNamedConfig(
    configId: string,
    customConfig: Partial<GalaxyStarfieldConfig> = {},
    mergeWithRandom: boolean = true
  ): StoredConfig {
    console.log(`Storing named config: ${configId}`);

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

    console.log(`Named config "${configId}" stored successfully`);
    return finalConfig;
  }

  /**
   * Retrieve a stored named configuration
   */
  getNamedConfig(configId: string): StoredConfig | null {
    const config = this.namedConfigs.get(configId);
    if (!config) {
      console.warn(`Named config "${configId}" not found`);
      return null;
    }

    console.log(`Retrieved named config: ${configId}`);
    console.log(`Sector "${configId}" configuration:`, config);
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
   * Update an existing named config
   */
  updateNamedConfig(
    configId: string,
    updates: Partial<GalaxyStarfieldConfig>
  ): StoredConfig | null {
    if (!this.namedConfigs.has(configId)) {
      console.warn(`Cannot update: named config "${configId}" not found`);
      return null;
    }

    const existingConfig = this.namedConfigs.get(configId)!;
    const updatedConfig: StoredConfig = customDeepmerge(
      existingConfig,
      updates
    ) as StoredConfig;

    // Add updated timestamp
    updatedConfig.updatedAt = Date.now();

    // Store a deep copy to preserve all values exactly
    this.namedConfigs.set(configId, JSON.parse(JSON.stringify(updatedConfig)));
    console.log(`Named config "${configId}" updated successfully`);

    return updatedConfig;
  }

  /**
   * Delete a named config
   */
  deleteNamedConfig(configId: string): boolean {
    const deleted = this.namedConfigs.delete(configId);
    if (deleted) {
      console.log(`Named config "${configId}" deleted successfully`);
    } else {
      console.warn(`Cannot delete: named config "${configId}" not found`);
    }
    return deleted;
  }

  /**
   * Create a scene from a stored named config
   */
  createFromNamedConfig(
    configId: string,
    additionalOverrides: Partial<GalaxyStarfieldConfig> = {}
  ): StoredConfig | null {
    const storedConfig = this.getNamedConfig(configId);
    if (!storedConfig) {
      return null;
    }

    // Create a new scene based on the stored config
    const sceneConfig: StoredConfig = customDeepmerge(
      storedConfig,
      additionalOverrides
    ) as StoredConfig;

    // Generate unique scene ID
    this.currentSceneId++;
    sceneConfig.sceneId = this.currentSceneId;

    // Store in history - store a deep copy to preserve all values
    this.sceneHistory.push({
      id: this.currentSceneId,
      timestamp: Date.now(),
      config: JSON.parse(JSON.stringify(sceneConfig)),
      sourceConfigId: configId,
    });

    // Keep only last 10 scenes in history
    if (this.sceneHistory.length > 10) {
      this.sceneHistory.shift();
    }

    console.log(
      `Scene ${this.currentSceneId} created from named config: ${configId}`
    );
    return sceneConfig;
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
      console.debug("Using provided game objects from stored config");
    } else if (finalConfig.debugMode) {
      // Generate new game objects for debug mode
      finalConfig.gameObjects = this._generateGameObjects(finalConfig);
      console.debug("Generated fresh game objects for debug mode");
    } else {
      // No game objects for non-debug mode
      finalConfig.gameObjects = [];
      console.debug("No game objects generated (not in debug mode)");
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
    config.planetScale = Math.random() * 4 + 2; // 2 to 6
    config.planetSpawnRangeX = Math.random() * 200 + 300; // 300 to 500
    config.planetSpawnRangeY = Math.random() * 200 + 300; // 300 to 500

    // Set deterministic planet positions for this sector
    config.planetPositionX = (Math.random() - 0.5) * config.planetSpawnRangeX;
    config.planetPositionY = (Math.random() - 0.5) * config.planetSpawnRangeY;

    // Star properties - completely fresh random values
    config.starSize = Math.random() * 0.5 + 0.75; // 0.75 to 1.25
    config.twinkleSpeed = Math.random() * 0.001 + 0.0002; // 0.0002 to 0.0012
    config.twinkleIntensity = Math.random() * 0.5 + 0.1; // 0.1 to 0.6

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

    console.log(`Generated ${gameObjects.length} game objects for new scene`);
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
   * Cycle a value through a random range, ensuring it's different from the original
   * @private
   */
  private _cycleRandomValue(
    originalValue: number,
    min: number,
    max: number
  ): number {
    let newValue: number;
    let attempts = 0;
    const maxAttempts = 10;

    // Try to get a value that's different from the original
    do {
      newValue = Math.random() * (max - min) + min;
      attempts++;
    } while (
      Math.abs(newValue - originalValue) < (max - min) * 0.1 &&
      attempts < maxAttempts
    );

    return newValue;
  }

  /**
   * Get current scene information
   */
  getCurrentScene(): SceneHistoryEntry | null {
    if (this.sceneHistory.length === 0) return null;
    return this.sceneHistory[this.sceneHistory.length - 1];
  }

  /**
   * Get scene history
   */
  getSceneHistory(): SceneHistoryEntry[] {
    return [...this.sceneHistory];
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

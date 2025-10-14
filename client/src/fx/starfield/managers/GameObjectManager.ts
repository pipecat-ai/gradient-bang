/**
 * Game Object Manager
 * Manages rendering of NPCs and locations as 3D primitives in the starfield
 */

import * as THREE from "three";
import { type GalaxyStarfieldConfig } from "../constants";
import {
  type GameObjectBaseConfig,
  type GameObjectConfig,
  type GameObjectInstance,
  type GameObjectSpawnRules,
  type GameObjectStats,
  type ObjectTypeData,
} from "../types/GameObject";

// ============================================================================
// GAME OBJECT MANAGER CLASS
// ============================================================================

/**
 * GameObjectManager Class
 * Manages 3D game objects (ships, stations, NPCs) in the starfield scene
 */
export class GameObjectManager {
  private scene: THREE.Scene;
  private config: GalaxyStarfieldConfig;
  private gameObjects: Map<string, GameObjectInstance>;
  private selectedObjectId: string | null;
  private objectTypes: { [key: string]: ObjectTypeData };
  private selectionMaterial: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene, config: GalaxyStarfieldConfig) {
    this.scene = scene;
    this.config = config;

    // Store all game objects
    this.gameObjects = new Map();

    // Track selected object (only one can be selected at a time)
    this.selectedObjectId = null;

    // Initialize object type definitions from config (using plain object like JS)
    this.objectTypes = {};
    this._initializeObjectTypes();

    // Selection material (highlighted state)
    this.selectionMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 1, 0), // Yellow highlight
      transparent: true,
      opacity: 1.0,
      wireframe: true,
    });
  }

  /**
   * Initialize object type definitions from configuration
   * @private
   */
  private _initializeObjectTypes(): void {
    if (!this.config.gameObjectTypes) {
      console.warn("GameObjectManager: No gameObjectTypes found in config");
      return;
    }

    Object.entries(this.config.gameObjectTypes).forEach(
      ([typeName, typeConfig]) => {
        // Create geometry based on type
        let geometry: THREE.BufferGeometry;
        switch (typeConfig.geometry) {
          case "box":
            geometry = new THREE.BoxGeometry(1, 1, 1);
            break;
          case "octahedron":
            geometry = new THREE.OctahedronGeometry(1);
            break;
          case "sphere":
            geometry = new THREE.SphereGeometry(1, 8, 6);
            break;
          default:
            geometry = new THREE.BoxGeometry(1, 1, 1);
            break;
        }

        // Create material
        const material = new THREE.MeshBasicMaterial({
          color: new THREE.Color(
            typeConfig.color.r,
            typeConfig.color.g,
            typeConfig.color.b
          ),
          transparent: true,
          opacity: 0.8,
        });

        // Store exactly like JS version
        this.objectTypes[typeName] = {
          geometry: geometry,
          material: material,
          rotationSpeed: typeConfig.rotationSpeed,
          scale: typeConfig.scale,
        };
      }
    );
  }

  /**
   * Create all game objects based on configuration
   */
  private createGameObjects(gameObjects: GameObjectConfig[]): void {
    // Clear existing objects
    this.destroyAllObjects();

    if (!gameObjects || !Array.isArray(gameObjects)) {
      return;
    }

    // Create each game object from the provided list
    gameObjects.forEach((gameObjectConfig) => {
      this.createGameObject(gameObjectConfig);
    });
  }

  /**
   * Create a single game object from configuration
   */
  private createGameObject(gameObjectConfig: GameObjectConfig): void {
    const { id, type, name, position } = gameObjectConfig;

    const objectType = this.objectTypes[type];
    if (!objectType) {
      console.error(`GameObjectManager: Unknown object type: ${type}`);
      return;
    }

    // Create mesh
    const mesh = new THREE.Mesh(
      objectType.geometry,
      objectType.material.clone()
    );

    // Set scale
    mesh.scale.setScalar(objectType.scale);

    // Set position from config
    mesh.position.set(position.x, position.y, position.z);

    const gameObject: GameObjectInstance = {
      id: id,
      type: type,
      name: name || `${type} ${id}`,
      mesh: mesh,
      originalMaterial: objectType.material.clone(),
      rotationSpeed: objectType.rotationSpeed,
      metadata: {
        name: name || `${type} ${id}`,
        lastSeen: Date.now(),
      },
    };

    this.gameObjects.set(id, gameObject);
    this.scene.add(mesh);
  }

  /**
   * Add a single game object (already expanded GameObjectConfig)
   */
  public addGameObject(gameObjectConfig: GameObjectConfig): void {
    if (!this.config.gameObjectsEnabled) return;
    this.createGameObject(gameObjectConfig);
  }

  /**
   * Remove a game object by id
   * Returns true if removed, false if not found
   */
  public removeGameObject(objectId: string): boolean {
    const gameObject = this.gameObjects.get(objectId);
    if (!gameObject) return false;

    this.scene.remove(gameObject.mesh);
    gameObject.mesh.geometry.dispose();
    if (Array.isArray(gameObject.mesh.material)) {
      gameObject.mesh.material.forEach((m) => m.dispose());
    } else {
      gameObject.mesh.material.dispose();
    }
    this.gameObjects.delete(objectId);

    if (this.selectedObjectId === objectId) {
      this.selectedObjectId = null;
    }
    return true;
  }

  /**
   * Update game object rotations only (positions remain fixed)
   */
  public updateRotations(): void {
    if (!this.config.gameObjectsEnabled) {
      return;
    }

    this.gameObjects.forEach((gameObject) => {
      const rotationAmount = gameObject.rotationSpeed * 0.016;
      gameObject.mesh.rotation.y += rotationAmount;
      gameObject.mesh.rotation.x += rotationAmount * 0.5;
    });
  }

  /**
   * Select a game object by ID
   */
  public selectObject(objectId: string): boolean {
    const gameObject = this.gameObjects.get(objectId);
    if (!gameObject) {
      console.warn(`GameObjectManager: Object ${objectId} not found`);
      return false;
    }

    // If we're already selecting this object, do nothing
    if (this.selectedObjectId === objectId) {
      return true;
    }

    // If we're switching from one object to another, just restore the previous object's material
    if (this.selectedObjectId) {
      const previousObject = this.gameObjects.get(this.selectedObjectId);
      if (previousObject) {
        previousObject.mesh.material = previousObject.originalMaterial;
      }
    }

    // Apply selection material to new object
    gameObject.mesh.material = this.selectionMaterial;
    this.selectedObjectId = objectId;

    console.debug(`[STARFIELD] Selected: ${gameObject.metadata.name}`);
    return true;
  }

  /**
   * Deselect a game object
   */
  public deselectObject(objectId?: string): void {
    const targetId = objectId || this.selectedObjectId;
    if (!targetId) return;

    const gameObject = this.gameObjects.get(targetId);
    if (!gameObject) {
      return;
    }

    // Restore original material
    gameObject.mesh.material = gameObject.originalMaterial;

    if (this.selectedObjectId === targetId) {
      this.selectedObjectId = null;
    }
  }

  /**
   * Get currently selected object
   */
  public getSelectedObject(): GameObjectInstance | null {
    if (!this.selectedObjectId) {
      return null;
    }
    return this.gameObjects.get(this.selectedObjectId) || null;
  }

  /**
   * Get all game objects
   */
  public getAllObjects(): GameObjectInstance[] {
    return Array.from(this.gameObjects.values());
  }

  /**
   * Get objects by type
   */
  public getObjectsByType(type: string): GameObjectInstance[] {
    return Array.from(this.gameObjects.values()).filter(
      (obj) => obj.type === type
    );
  }

  /**
   * Get object by ID
   */
  public getObject(objectId: string): GameObjectInstance | undefined {
    return this.gameObjects.get(objectId);
  }

  /**
   * Update configuration and recreate objects if needed
   */
  /*public updateConfig(newConfig: Partial<GalaxyStarfieldConfig>): void {
    console.debug(
      "[STARFIELD] GameObjectManager: updateConfig called with:",
      newConfig
    );

    // Deep merge the new config, but replace arrays instead of merging them
    // This matches the JS behavior of arrayMerge: (target, source) => source
    this.config = customDeepmerge(
      this.config,
      newConfig
    ) as GalaxyStarfieldConfig;

    console.debug("[STARFIELD] GameObjectManager: Merged config:", this.config);

    // Reinitialize object types if gameObjectTypes changed
    if (newConfig.gameObjectTypes) {
      // Dispose of old object type materials and geometries
      Object.values(this.objectTypes).forEach((objectType) => {
        objectType.material.dispose();
        objectType.geometry.dispose();
      });

      // Reinitialize with new types
      this.objectTypes = {};
      this._initializeObjectTypes();
    }

    // Do not recreate objects from config; objects are set explicitly via setGameObjects
  }*/

  /**
   * Destroy all game objects
   */
  public destroyAllObjects(): void {
    this.gameObjects.forEach((gameObject) => {
      this.scene.remove(gameObject.mesh);
      gameObject.mesh.geometry.dispose();
      if (Array.isArray(gameObject.mesh.material)) {
        gameObject.mesh.material.forEach((material) => material.dispose());
      } else {
        gameObject.mesh.material.dispose();
      }
    });

    this.gameObjects.clear();
    this.selectedObjectId = null;
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    this.destroyAllObjects();

    // Dispose of object type materials
    Object.values(this.objectTypes).forEach((objectType) => {
      objectType.material.dispose();
    });

    this.selectionMaterial.dispose();
  }

  // Additional TypeScript-specific public methods for compatibility

  /**
   * Get performance statistics
   */
  public getStats(): GameObjectStats {
    const stats: GameObjectStats = {
      totalObjects: this.gameObjects.size,
      selectedObjects: this.selectedObjectId ? 1 : 0,
      objectsByType: {},
      visibleObjects: 0,
    };

    for (const gameObject of this.gameObjects.values()) {
      const typeName = gameObject.type;
      stats.objectsByType[typeName] = (stats.objectsByType[typeName] || 0) + 1;

      if (gameObject.mesh.visible) {
        stats.visibleObjects++;
      }
    }

    return stats;
  }

  /**
   * Check if game objects are enabled
   */
  public isEnabled(): boolean {
    return this.config.gameObjectsEnabled;
  }

  /**
   * Generate a complete GameObjectConfig from a base config with auto-generated position, rotation, and scale
   */
  public generateGameObjectConfig(
    baseConfig: GameObjectBaseConfig
  ): GameObjectConfig {
    // Use provided position or generate a random one
    const position =
      baseConfig.position ||
      this._generateRandomPosition(this.config.gameObjectSpawnRules);

    // Get scale from object type config
    const objectType = this.objectTypes[baseConfig.type];
    const scale = objectType?.scale || 1.0;

    return {
      ...baseConfig,
      position,
      rotation: { x: 0, y: 0, z: 0 },
      scale,
    };
  }

  /**
   * Replace existing objects with a provided list (already- or to-be-expanded)
   */
  public setGameObjects(gameObjects: GameObjectConfig[]): void {
    if (!this.config.gameObjectsEnabled) {
      this.destroyAllObjects();
      return;
    }
    this.createGameObjects(gameObjects);
  }

  /**
   * Generate a random position for game objects based on spawn rules
   * @private
   */
  private _generateRandomPosition(
    spawnRules: GameObjectSpawnRules | undefined
  ): { x: number; y: number; z: number } {
    // Default spawn area if no rules specified
    const defaultArea = {
      minX: -100,
      maxX: 100,
      minY: -100,
      maxY: 100,
      minZ: -200,
      maxZ: -50,
    };

    if (!spawnRules) {
      return {
        x:
          Math.random() * (defaultArea.maxX - defaultArea.minX) +
          defaultArea.minX,
        y:
          Math.random() * (defaultArea.maxY - defaultArea.minY) +
          defaultArea.minY,
        z:
          Math.random() * (defaultArea.maxZ - defaultArea.minZ) +
          defaultArea.minZ,
      };
    }

    // Use spawn rules if available
    const range = spawnRules.spawnRange;
    return {
      x: (Math.random() - 0.5) * range.x,
      y: (Math.random() - 0.5) * range.y,
      z:
        -Math.random() * (spawnRules.maxDistance - spawnRules.minDistance) -
        spawnRules.minDistance,
    };
  }
}

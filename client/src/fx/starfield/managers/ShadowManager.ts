import * as THREE from "three";
import type { GalaxyStarfieldConfig } from "../constants";
import { UniformManager } from "./UniformManager";

export interface ShadowCenter {
  x: number;
  y: number;
}

/**
 * Centralized manager for all shadow-related calculations and uniform updates
 */
export class ShadowManager {
  private _uniformManager: UniformManager;
  private _shadowCenter: ShadowCenter;
  private _shadowCenterInitialized: boolean;
  private _planetGroup: THREE.Group | null;
  private _planetRandomOffset: { x: number; y: number } | null;
  private _planetTransformDirty: boolean;
  private _config: GalaxyStarfieldConfig | null;

  constructor(uniformManager: UniformManager) {
    this._uniformManager = uniformManager;
    this._shadowCenter = { x: 0.5, y: 0.5 };
    this._shadowCenterInitialized = false;
    this._planetGroup = null;
    this._planetRandomOffset = null;
    this._planetTransformDirty = false;
    this._config = null;
  }

  /**
   * Apply initial shadow settings when materials are ready
   */
  public applyInitialSettings(): void {
    if (this._config) {
      console.debug(
        "[STARFIELD] ShadowManager] Applying initial shadow settings now that materials are ready"
      );
      this.updateShadowSettings(this._config);
    }
  }

  /**
   * Set the planet group and offset for shadow calculations
   */
  public setPlanetGroup(
    planetGroup: THREE.Group,
    randomOffset: { x: number; y: number }
  ): void {
    console.debug(
      "[STARFIELD] ShadowManager] setPlanetGroup called with:",
      planetGroup,
      randomOffset
    );

    this._planetGroup = planetGroup;
    this._planetRandomOffset = randomOffset;
    // Don't mark transform dirty here - Background will do it when needed
    this._planetTransformDirty = false;
  }

  /**
   * Mark planet transform as dirty when Background updates planet position
   * This should be called by the Background class when it moves the planet
   */
  public markPlanetTransformDirty(): void {
    this._planetTransformDirty = true;
  }

  /**
   * Check if shadow center needs to be updated
   */
  public shouldUpdateShadowCenter(): boolean {
    // Update if never initialized or if Background marked transform as dirty
    return !this._shadowCenterInitialized || this._planetTransformDirty;
  }

  /**
   * Update shadow center and apply to all shadow-supporting materials
   */
  public updateShadowCenter(camera: THREE.Camera): boolean {
    if (!this._planetGroup || !this._config?.planetShadowEnabled) {
      return false;
    }

    // Check if update is needed
    if (!this.shouldUpdateShadowCenter()) {
      return false;
    }

    // Calculate new shadow center using screen-space coordinates for consistency
    const worldPos = this._planetGroup.getWorldPosition(new THREE.Vector3());
    const screenPos = worldPos.clone().project(camera);

    const newShadowCenter = {
      x: screenPos.x * 0.5 + 0.5,
      y: screenPos.y * 0.5 + 0.5,
    };

    // Check if shadow center actually changed
    if (
      Math.abs(newShadowCenter.x - this._shadowCenter.x) < 0.001 &&
      Math.abs(newShadowCenter.y - this._shadowCenter.y) < 0.001
    ) {
      return false;
    }

    // Update shadow center
    this._shadowCenter.x = newShadowCenter.x;
    this._shadowCenter.y = newShadowCenter.y;

    // Apply shadow center to all materials
    this._applyShadowCenterToMaterials();

    // Mark as initialized
    this._shadowCenterInitialized = true;
    this._planetTransformDirty = false;

    return true;
  }

  /**
   * Apply shadow center coordinates to all shadow-supporting materials
   */
  private _applyShadowCenterToMaterials(): void {
    const shadowCenterUpdates = {
      shadowCenter: new THREE.Vector2(
        this._shadowCenter.x,
        this._shadowCenter.y
      ),
    };

    // Apply to all shadow-supporting materials
    const shadowMaterials = ["clouds", "nebula"];
    for (const materialId of shadowMaterials) {
      if (this._uniformManager.hasMaterial(materialId)) {
        this._uniformManager.updateUniforms(materialId, shadowCenterUpdates);
      }
    }
  }

  /**
   * Update shadow settings when configuration changes
   */
  public updateShadowSettings(config: GalaxyStarfieldConfig): void {
    console.debug(
      "[STARFIELD] ShadowManager] updateShadowSettings called with config:",
      config
    );
    this._config = config;

    // Scale shadow radius by planet scale for proper proportion
    const scaledShadowRadius = config.planetShadowRadius * config.planetScale;

    const shadowUpdates = {
      shadowRadius: scaledShadowRadius,
      shadowSoftness: config.planetShadowSoftness,
      shadowStrength: config.planetShadowEnabled
        ? config.planetShadowOpacity
        : 0, // 0 when disabled
    };

    console.debug("[STARFIELD] ShadowManager] Shadow scaling:", {
      baseRadius: config.planetShadowRadius,
      planetScale: config.planetScale,
      scaledRadius: scaledShadowRadius,
    });
    console.debug("[STARFIELD] ShadowManager] Shadow updates:", shadowUpdates);

    // Apply to all shadow-supporting materials
    const shadowMaterials = ["clouds", "nebula"];
    for (const materialId of shadowMaterials) {
      if (this._uniformManager.hasMaterial(materialId)) {
        console.debug(
          "[STARFIELD] ShadowManager] Updating material:",
          materialId
        );
        this._uniformManager.updateUniforms(materialId, shadowUpdates);
      } else {
        console.debug(
          "[STARFIELD] ShadowManager] Material not found:",
          materialId
        );
      }
    }
  }

  /**
   * Get current shadow center coordinates
   */
  public getShadowCenter(): ShadowCenter {
    return { ...this._shadowCenter };
  }

  /**
   * Check if shadow center has been initialized
   */
  public isShadowCenterInitialized(): boolean {
    return this._shadowCenterInitialized;
  }

  /**
   * Reset shadow center state (useful for scene changes)
   */
  public resetShadowCenter(): void {
    this._shadowCenterInitialized = false;
    this._planetTransformDirty = true;
  }

  /**
   * Handle scene changes (like warping to new sectors)
   */
  public onSceneChange(): void {
    // Reset shadow center state for new scene
    this.resetShadowCenter();

    // Reset shadow state for new scene
  }

  /**
   * Get planet group for external access
   */
  public getPlanetGroup(): THREE.Group | null {
    return this._planetGroup;
  }

  /**
   * Get planet random offset for external access
   */
  public getPlanetRandomOffset(): { x: number; y: number } | null {
    return this._planetRandomOffset;
  }
}

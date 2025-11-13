/**
 * Uniform Manager
 * Centralizes all shader uniform updates with validation and change tracking
 * Integrates with utility modules for enhanced functionality
 */

import * as THREE from "three";
import { hexToRgb, normalizeRgb, validateRgb } from "../utils/colors";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Supported uniform types for schema validation */
export type UniformType =
  | "float"
  | "vector2"
  | "vector3"
  | "boolean"
  | "int"
  | "bool"
  | "vec2"
  | "vec3"
  | "vec4"
  | "color"
  | "texture"
  | "number"
  | "blendMode"
  | "intensity";

/** Uniform schema definition for validation */
export interface UniformSchema {
  type?: UniformType;
  min?: number;
  max?: number;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  validate?: (value: unknown) => boolean;
}

/** Material registration data */
export interface MaterialData {
  material: THREE.Material & { uniforms: { [key: string]: THREE.IUniform } };
  schema: { [uniformName: string]: UniformSchema };
  lastUpdate: number;
}

/** Batch update queue item */
export interface BatchUpdateItem {
  materialId: string;
  uniformName: string;
  value: unknown;
}

/** Performance statistics for uniform updates */
export interface UniformPerformanceStats {
  totalMaterials: number;
  totalUniforms: number;
  pendingBatchUpdates: number;
  dirtyUniforms: number;
  lastChanges: Record<string, string[]>;
}

/** Formatted performance statistics for display */
export interface FormattedPerformanceStats {
  totalMaterials: number;
  totalUniforms: number;
  pendingBatchUpdates: number;
  dirtyUniforms: number;
  formattedSummary: string;
}

/** Change tracking result */
export interface ChangeTrackingResult {
  [materialId: string]: string[];
}

// ============================================================================
// UNIFORM MANAGER CLASS
// ============================================================================

/**
 * Uniform Manager Class
 * Manages shader uniform updates across all materials with validation and performance optimization
 */
export class UniformManager {
  private materials: Map<string, MaterialData>;
  private uniformCache: Map<string, Map<string, unknown>>;
  private changeTracking: Map<string, Set<string>>;
  private batchUpdates: BatchUpdateItem[];
  private dirtyUniforms: Map<string, Set<string>>;
  private debugMode: boolean;

  // Reusable objects for vector updates to prevent garbage collection
  // private _tempVector2: THREE.Vector2 | null;
  // private _tempVector3: THREE.Vector3 | null;

  constructor() {
    this.materials = new Map();
    this.uniformCache = new Map();
    this.changeTracking = new Map();
    this.batchUpdates = [];
    this.dirtyUniforms = new Map();
    this.debugMode = false;

    // Reusable objects for vector updates to prevent garbage collection
    // this._tempVector2 = null;
    // this._tempVector3 = null;
  }

  /**
   * Registers a material for uniform management
   */
  public registerMaterial(
    materialId: string,
    material: THREE.Material & { uniforms: { [key: string]: THREE.IUniform } },
    uniformSchema: { [uniformName: string]: UniformSchema } = {}
  ): boolean {
    // Validate that material has uniforms property
    if (!material || !material.uniforms) {
      console.error(
        `UniformManager: Material ${materialId} doesn't have uniforms property`
      );
      return false;
    }

    this.materials.set(materialId, {
      material,
      schema: uniformSchema,
      lastUpdate: 0,
    });

    // Initialize cache for this material
    this.uniformCache.set(materialId, new Map());
    this.changeTracking.set(materialId, new Set());
    this.dirtyUniforms.set(materialId, new Set());

    if (this.debugMode) {
      console.debug(`UniformManager: Registered material ${materialId}`);
    }

    return true;
  }

  /**
   * Unregisters a material from uniform management
   */
  public unregisterMaterial(materialId: string): void {
    this.materials.delete(materialId);
    this.uniformCache.delete(materialId);
    this.changeTracking.delete(materialId);
    this.dirtyUniforms.delete(materialId);

    if (this.debugMode) {
      console.debug(`UniformManager: Unregistered material ${materialId}`);
    }
  }

  /**
   * Updates a single uniform on a specific material
   */
  public updateUniform(
    materialId: string,
    uniformName: string,
    value: unknown,
    forceUpdate: boolean = false
  ): boolean {
    const materialData = this.materials.get(materialId);
    if (!materialData) {
      console.warn(`UniformManager: Material ${materialId} not found`);
      return false;
    }

    const { material, schema } = materialData;
    const uniform = material.uniforms[uniformName];

    if (!uniform) {
      console.warn(
        `UniformManager: Uniform ${uniformName} not found in material ${materialId}`
      );
      return false;
    }

    // Apply utility conversions and validate value if schema is provided
    const processedValue = this.processUniformValue(value, schema[uniformName]);

    // Check if value has changed
    const cache = this.uniformCache.get(materialId);
    const cachedValue = cache?.get(uniformName);
    const hasChanged =
      forceUpdate || !this.valuesEqual(cachedValue, processedValue);

    if (!hasChanged) return false;

    // Update the uniform - optimize vector updates to reuse objects
    this.applyUniformValue(uniform, processedValue, schema[uniformName]);

    // Update cache
    cache?.set(uniformName, this.deepClone(processedValue));

    // Track changes
    this.changeTracking.get(materialId)?.add(uniformName);
    materialData.lastUpdate = performance.now();

    // Clear from dirty if it was marked
    this.dirtyUniforms.get(materialId)?.delete(uniformName);

    if (this.debugMode) {
      console.debug(
        `UniformManager: Updated ${materialId}.${uniformName} =`,
        processedValue
      );
    }

    return true;
  }

  /**
   * Process uniform value based on schema
   */
  private processUniformValue(
    value: unknown,
    schemaDef?: UniformSchema
  ): unknown {
    if (!schemaDef) return value;

    // Apply utility conversions
    if (schemaDef.type === "blendMode" && typeof value === "string") {
      // Note: blendMode utility would need to be imported/implemented
      // return getThreeJSBlendMode(value);
      return value; // Placeholder
    }

    if (schemaDef.type === "color") {
      return this.processColorValue(value);
    }

    // Validate the processed value
    if (!this.validateUniformValue(value, schemaDef)) {
      console.warn(`UniformManager: Invalid value for uniform`);
      return value; // Return original if validation fails
    }

    return value;
  }

  /**
   * Process color values from various formats
   */
  private processColorValue(value: unknown): unknown {
    if (typeof value === "string") {
      const rgbColor = hexToRgb(value);
      if (rgbColor) {
        return normalizeRgb(rgbColor.r, rgbColor.g, rgbColor.b);
      }
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (obj.isVector3 || obj.isColor) {
        const r = obj.r !== undefined ? obj.r : obj.x;
        const g = obj.g !== undefined ? obj.g : obj.y;
        const b = obj.b !== undefined ? obj.b : obj.z;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          return normalizeRgb(r, g, b);
        }
      } else if (Array.isArray(value) && value.length >= 3) {
        const [r, g, b] = value;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          return normalizeRgb(r, g, b);
        }
      } else {
        const r = obj.r !== undefined ? obj.r : obj.x;
        const g = obj.g !== undefined ? obj.g : obj.y;
        const b = obj.b !== undefined ? obj.b : obj.z;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          return normalizeRgb(r, g, b);
        }
      }
    }
    return value;
  }

  /**
   * Apply processed value to uniform
   */
  private applyUniformValue(
    uniform: THREE.IUniform,
    processedValue: unknown,
    schemaDef?: UniformSchema
  ): void {
    if (uniform.value && typeof uniform.value === "object") {
      const uniformValue = uniform.value as Record<string, unknown>;

      if (uniformValue.isVector3) {
        // Reuse existing Vector3 object
        if (schemaDef && schemaDef.type === "color") {
          const obj = processedValue as Record<string, unknown>;
          const r = obj.r !== undefined ? obj.r : obj.x;
          const g = obj.g !== undefined ? obj.g : obj.y;
          const b = obj.b !== undefined ? obj.b : obj.z;
          if (
            typeof r === "number" &&
            typeof g === "number" &&
            typeof b === "number"
          ) {
            (uniformValue as unknown as THREE.Vector3).set(r, g, b);
          }
        } else {
          const obj = processedValue as Record<string, unknown>;
          if (
            obj.x !== undefined &&
            obj.y !== undefined &&
            obj.z !== undefined
          ) {
            (uniformValue as unknown as THREE.Vector3).set(
              obj.x as number,
              obj.y as number,
              obj.z as number
            );
          }
        }
      } else if (uniformValue.isVector2) {
        // Reuse existing Vector2 object
        const obj = processedValue as Record<string, unknown>;
        if (obj.x !== undefined && obj.y !== undefined) {
          (uniformValue as unknown as THREE.Vector2).set(
            obj.x as number,
            obj.y as number
          );
        }
      } else if (uniformValue.isColor) {
        // Reuse existing Color object
        const obj = processedValue as Record<string, unknown>;
        const r = obj.r !== undefined ? obj.r : obj.x;
        const g = obj.g !== undefined ? obj.g : obj.y;
        const b = obj.b !== undefined ? obj.b : obj.z;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          (uniformValue as unknown as THREE.Color).setRGB(r, g, b);
        }
      } else {
        // For scalars and other types
        (uniform as { value: unknown }).value = processedValue;
      }
    } else {
      // For scalars and other types
      (uniform as { value: unknown }).value = processedValue;
    }
  }

  /**
   * Updates multiple uniforms on a material
   */
  public updateUniforms(
    materialId: string,
    uniforms: Record<string, unknown>,
    forceUpdate: boolean = false
  ): void {
    const materialData = this.materials.get(materialId);
    if (!materialData) {
      console.warn(`UniformManager: Material ${materialId} not found`);
      return;
    }

    let updatedCount = 0;
    Object.entries(uniforms).forEach(([uniformName, value]) => {
      if (this.updateUniform(materialId, uniformName, value, forceUpdate)) {
        updatedCount++;
      }
    });

    if (this.debugMode && updatedCount > 0) {
      console.debug(
        `UniformManager: Updated ${updatedCount} uniforms on ${materialId}`
      );
    }
  }

  /**
   * Updates a uniform across all registered materials
   */
  public updateUniformGlobal(
    uniformName: string,
    value: unknown,
    forceUpdate: boolean = false
  ): void {
    let updatedCount = 0;
    this.materials.forEach((_materialData, materialId) => {
      if (this.updateUniform(materialId, uniformName, value, forceUpdate)) {
        updatedCount++;
      }
    });

    if (this.debugMode && updatedCount > 0) {
      console.debug(
        `UniformManager: Updated ${uniformName} on ${updatedCount} materials`
      );
    }
  }

  /**
   * Optimized method for updating time uniforms across all materials
   */
  public updateGlobalTimeUniforms(time: number): void {
    // Specialized method for high-frequency updates without validation overhead
    this.materials.forEach((materialData, materialId) => {
      const { material } = materialData;
      if (material.uniforms.time) {
        material.uniforms.time.value = time;

        // Update cache directly for performance
        const cache = this.uniformCache.get(materialId);
        if (cache) {
          cache.set("time", time);
        }
      }
    });
  }

  /**
   * Queues a uniform update for batch processing
   */
  public queueUniformUpdate(
    materialId: string,
    uniformName: string,
    value: unknown
  ): void {
    this.batchUpdates.push({ materialId, uniformName, value });
  }

  /**
   * Processes all queued uniform updates
   */
  public processBatchUpdates(): void {
    if (this.batchUpdates.length === 0) return;

    const updatesByMaterial = new Map<string, Record<string, unknown>>();

    // Group updates by material
    this.batchUpdates.forEach((update) => {
      if (!updatesByMaterial.has(update.materialId)) {
        updatesByMaterial.set(update.materialId, {});
      }
      updatesByMaterial.get(update.materialId)![update.uniformName] =
        update.value;
    });

    // Apply updates
    updatesByMaterial.forEach((uniforms, materialId) => {
      this.updateUniforms(materialId, uniforms);
    });

    // Clear batch
    this.batchUpdates.length = 0;
  }

  /**
   * Validates a uniform value against its schema
   */
  private validateUniformValue(
    value: unknown,
    schema?: UniformSchema
  ): boolean {
    if (!schema || !schema.type) return true;

    const validators: Record<string, (v: unknown) => boolean> = {
      number: (v) => typeof v === "number" && isFinite(v),
      vector2: (v) =>
        Boolean(
          v &&
            typeof v === "object" &&
            typeof (v as Record<string, unknown>).x === "number" &&
            typeof (v as Record<string, unknown>).y === "number"
        ),
      vector3: (v) =>
        Boolean(
          v &&
            typeof v === "object" &&
            typeof (v as Record<string, unknown>).x === "number" &&
            typeof (v as Record<string, unknown>).y === "number" &&
            typeof (v as Record<string, unknown>).z === "number"
        ),
      boolean: (v) => typeof v === "boolean",
      texture: (v) =>
        Boolean(
          v && typeof v === "object" && (v as Record<string, unknown>).isTexture
        ),
      blendMode: (v) => typeof v === "string", // TODO: Use validateBlendMode(v) if utility exists
      intensity: (v) => typeof v === "number" && v >= 0 && v <= 1,
      color: (v) => this.validateColorValue(v),
    };

    const validator = validators[schema.type];
    if (validator && !validator(value)) return false;

    // Range validation
    if (
      schema.min !== undefined &&
      typeof value === "number" &&
      value < schema.min
    )
      return false;
    if (
      schema.max !== undefined &&
      typeof value === "number" &&
      value > schema.max
    )
      return false;
    if (schema.enum && !schema.enum.includes(value)) return false;

    return true;
  }

  /**
   * Validates color value in various formats
   */
  private validateColorValue(value: unknown): boolean {
    if (typeof value === "string") {
      return hexToRgb(value) !== null;
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (obj.isVector3 || obj.isColor) {
        const r = obj.r !== undefined ? obj.r : obj.x;
        const g = obj.g !== undefined ? obj.g : obj.y;
        const b = obj.b !== undefined ? obj.b : obj.z;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          return validateRgb(r, g, b);
        }
      } else if (Array.isArray(value) && value.length >= 3) {
        const [r, g, b] = value;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          return validateRgb(r, g, b);
        }
      } else {
        const r = obj.r !== undefined ? obj.r : obj.x;
        const g = obj.g !== undefined ? obj.g : obj.y;
        const b = obj.b !== undefined ? obj.b : obj.z;
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          return validateRgb(r, g, b);
        }
      }
    }
    return false;
  }

  /**
   * Compares two values for equality (deep comparison)
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;

    if (typeof a === "object" && typeof b === "object") {
      // Check for Three.js types
      const isVec3 = (v: unknown): v is Record<string, unknown> =>
        Boolean(
          (v as Record<string, unknown>)?.isVector3 ||
            ((v as Record<string, unknown>)?.x !== undefined &&
              (v as Record<string, unknown>)?.y !== undefined &&
              (v as Record<string, unknown>)?.z !== undefined)
        );

      const isVec2 = (v: unknown): v is Record<string, unknown> =>
        Boolean(
          (v as Record<string, unknown>)?.isVector2 ||
            ((v as Record<string, unknown>)?.x !== undefined &&
              (v as Record<string, unknown>)?.y !== undefined)
        );

      const isColor = (v: unknown): v is Record<string, unknown> =>
        Boolean(
          (v as Record<string, unknown>)?.isColor ||
            ((v as Record<string, unknown>)?.r !== undefined &&
              (v as Record<string, unknown>)?.g !== undefined &&
              (v as Record<string, unknown>)?.b !== undefined)
        );

      if (isVec3(a) && isVec3(b)) {
        return a.x === b.x && a.y === b.y && a.z === b.z;
      }
      if (isVec2(a) && isVec2(b)) {
        return a.x === b.x && a.y === b.y;
      }
      if (isColor(a) && isColor(b)) {
        return a.r === b.r && a.g === b.g && a.b === b.b;
      }
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((val, index) => this.valuesEqual(val, b[index]));
      }
    }

    return false;
  }

  /**
   * Deep clones a value
   */
  private deepClone(value: unknown): unknown {
    if (value == null || typeof value !== "object") return value;

    const obj = value as Record<string, unknown>;
    if (obj.isVector3 || obj.isVector2 || obj.isColor) {
      return (value as { clone: () => unknown }).clone();
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepClone(item));
    }

    if (typeof value === "object") {
      const cloned: Record<string, unknown> = {};
      Object.keys(value).forEach((key) => {
        cloned[key] = this.deepClone((value as Record<string, unknown>)[key]);
      });
      return cloned;
    }

    return value;
  }

  /**
   * Updates uniforms for materials matching a pattern
   */
  public updateUniformsByPattern(
    pattern:
      | string
      | RegExp
      | ((materialId: string, materialData: MaterialData) => boolean),
    uniforms: Record<string, unknown>
  ): number {
    let matchCount = 0;

    this.materials.forEach((materialData, materialId) => {
      let shouldUpdate = false;

      if (pattern instanceof RegExp) {
        shouldUpdate = pattern.test(materialId);
      } else if (typeof pattern === "function") {
        shouldUpdate = pattern(materialId, materialData);
      } else {
        shouldUpdate = materialId.includes(pattern);
      }

      if (shouldUpdate) {
        this.updateUniforms(materialId, uniforms);
        matchCount++;
      }
    });

    if (this.debugMode && matchCount > 0) {
      console.debug(
        `UniformManager: Updated ${matchCount} materials matching pattern`
      );
    }

    return matchCount;
  }

  /**
   * Gets change tracking information
   */
  public getChangeTracking(): ChangeTrackingResult {
    const changes: ChangeTrackingResult = {};
    this.changeTracking.forEach((changedUniforms, materialId) => {
      if (changedUniforms.size > 0) {
        changes[materialId] = Array.from(changedUniforms);
      }
    });
    return changes;
  }

  /**
   * Clears change tracking
   */
  public clearChangeTracking(): void {
    this.changeTracking.forEach((changedUniforms) => {
      changedUniforms.clear();
    });
  }

  /**
   * Gets performance statistics
   */
  public getPerformanceStats(): UniformPerformanceStats {
    const stats: UniformPerformanceStats = {
      totalMaterials: this.materials.size,
      totalUniforms: 0,
      pendingBatchUpdates: this.batchUpdates.length,
      dirtyUniforms: 0,
      lastChanges: this.getChangeTracking(),
    };

    this.materials.forEach((materialData) => {
      stats.totalUniforms += Object.keys(materialData.material.uniforms).length;
    });

    this.dirtyUniforms.forEach((dirtySet) => {
      stats.dirtyUniforms += dirtySet.size;
    });

    return stats;
  }

  /**
   * Enables or disables debug mode
   */
  public setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  /**
   * Gets cached uniform values for a material
   */
  public getCachedUniforms(materialId: string): Record<string, unknown> {
    const cache = this.uniformCache.get(materialId);
    if (!cache) return {};

    const cached: Record<string, unknown> = {};
    cache.forEach((value, key) => {
      cached[key] = this.deepClone(value);
    });
    return cached;
  }

  /**
   * Resets all cached values
   */
  public resetCache(): void {
    this.uniformCache.forEach((cache) => {
      cache.clear();
    });
    this.clearChangeTracking();
    this.dirtyUniforms.forEach((dirtySet) => {
      dirtySet.clear();
    });
  }

  /**
   * Checks if a material is registered
   */
  public hasMaterial(materialId: string): boolean {
    return this.materials.has(materialId);
  }

  /**
   * Gets all registered material IDs
   */
  public getMaterialIds(): string[] {
    return Array.from(this.materials.keys());
  }
}

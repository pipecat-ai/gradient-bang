/**
 * Star Layer Manager - Simplified Version
 * Manages LOD-based star layers with clear separation between config updates and runtime changes
 */

import { deepmerge } from "deepmerge-ts";
import * as THREE from "three";
import {
  type GalaxyStarfieldConfig,
  type StarLODLayer,
  type WarpPhase,
} from "../constants";
import { type UniformManager } from "./UniformManager";

import { starsFragmentShader, starsVertexShader } from "../shaders/stars";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/** Star layer animation state */
export interface StarLayerState {
  isWarping: boolean;
  warpProgress: number;
  shakeIntensity: number;
  currentPhase: WarpPhase;
  forwardOffset: number;
  tunnelEffect: number;
}

/** Individual star layer data */
export interface StarLayer {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  mesh: THREE.Points;
  originalPositions: Float32Array;
  config: StarLODLayer;
  starCount: number;
}

/** Layer definition for creation */
export interface LayerDefinition {
  enabled: boolean;
  name: "hero" | "mid" | "far";
}

/** Star layer statistics */
export interface StarLayerStats {
  totalLayers: number;
  visibleLayers: number;
  totalStars: number;
  visibleStars: number;
  layerDetails: {
    [layerName: string]: {
      starCount: number;
      visible: boolean;
      triangles: number;
    };
  };
}

/** Uniform update batch */
export interface UniformBatch {
  [uniformName: string]: any;
}

/** Position update function type */
export type PositionUpdateFunction = (
  positions: Float32Array,
  originalPositions: Float32Array,
  layer: StarLayer
) => void;

// ============================================================================
// STAR LAYER MANAGER CLASS
// ============================================================================

/**
 * StarLayerManager Class
 * Manages LOD-based star rendering with performance optimization and animation support
 */
export class StarLayerManager {
  private scene: THREE.Scene;
  private config: GalaxyStarfieldConfig;
  private uniformManager: UniformManager;
  private layers: Map<string, StarLayer>;
  private state: StarLayerState;

  constructor(
    scene: THREE.Scene,
    config: GalaxyStarfieldConfig,
    uniformManager: UniformManager
  ) {
    this.scene = scene;
    this.config = config;
    this.uniformManager = uniformManager;
    this.layers = new Map();

    // State for animations
    this.state = {
      isWarping: false,
      warpProgress: 0,
      shakeIntensity: 0,
      currentPhase: "IDLE",
      forwardOffset: 0,
      tunnelEffect: 0,
    };
  }

  /**
   * Creates all star layers based on configuration
   * Called on initialization and whenever config changes from debug controls
   */
  public createStarfield(): void {
    // Clear existing layers first
    this.destroyAllLayers();

    // Ensure starLOD exists in config
    if (!this.config.starLOD) {
      console.error("StarLayerManager: No starLOD configuration found");
      return;
    }

    // Create enabled layers
    const layerDefinitions: LayerDefinition[] = [
      { enabled: this.config.starLOD.hero.enabled, name: "hero" },
      { enabled: this.config.starLOD.mid.enabled, name: "mid" },
      { enabled: this.config.starLOD.far.enabled, name: "far" },
    ];

    layerDefinitions.forEach(({ enabled, name }) => {
      if (enabled && this.config.starLOD[name]) {
        this.createStarLayer(this.config.starLOD[name], name);
      }
    });

    console.debug(
      `[STARFIELD] StarLayerManager: Created ${this.layers.size} star layers`
    );
  }

  /**
   * Creates a single star layer with the given LOD configuration
   */
  private createStarLayer(lodConfig: StarLODLayer, layerName: string): void {
    const starCount = lodConfig.count;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const twinklePhase = new Float32Array(starCount);
    const twinkleSpeed = new Float32Array(starCount);

    // Generate star data
    for (let i = 0; i < starCount; i++) {
      const i3 = i * 3;

      // Generate random positions within the distance range
      const radius =
        lodConfig.minDistance +
        Math.random() * (lodConfig.maxDistance - lodConfig.minDistance);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i3 + 2] = radius * Math.cos(phi);

      // Color variation
      if (lodConfig.colorVariation) {
        const temp = 3000 + Math.random() * 7000; // Kelvin temperature
        const color = this.temperatureToRGB(temp);
        colors[i3] = color.r;
        colors[i3 + 1] = color.g;
        colors[i3 + 2] = color.b;
      } else {
        // Default white
        colors[i3] = 1.0;
        colors[i3 + 1] = 1.0;
        colors[i3 + 2] = 1.0;
      }

      // Size variation
      sizes[i] = lodConfig.baseSize * (0.5 + Math.random() * 1.5);

      // Twinkle timing offset and speed
      if (lodConfig.twinkleIntensity > 0) {
        twinklePhase[i] = Math.random() * Math.PI * 2;
        twinkleSpeed[i] = 0.5 + Math.random() * 2; // Speed variation
      } else {
        twinklePhase[i] = 0;
        twinkleSpeed[i] = 0;
      }
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute(
      "twinklePhase",
      new THREE.BufferAttribute(twinklePhase, 1)
    );
    geometry.setAttribute(
      "twinkleSpeed",
      new THREE.BufferAttribute(twinkleSpeed, 1)
    );

    // Create material
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        starSize: { value: this.config.starSize },
        globalTwinkleSpeed: { value: lodConfig.twinkleSpeed },
        twinkleIntensity: { value: lodConfig.twinkleIntensity },
        motionBlur: {
          value: lodConfig.motionBlur ? this.config.motionBlurIntensity : 0,
        },
        fogNear: { value: this.config.fogNear },
        fogFar: { value: this.config.fogFar },
        fogColor: { value: new THREE.Color(0x000000) },
        fogDensity: { value: this.config.fogDensity },
        nearFadeEndMultiplier: { value: this.config.nearFadeEndMultiplier },
        shakeIntensity: { value: 0 },
        warpProgress: { value: 0 },
        tunnelEffect: { value: 0 },
        forwardOffset: { value: 0 },
        minPointDepth: { value: lodConfig.minDistance },
        cameraPosition: { value: new THREE.Vector3() },
      },
      vertexShader: starsVertexShader,
      fragmentShader: starsFragmentShader,
      transparent: true,
      vertexColors: true,
      fog: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // Create mesh
    const mesh = new THREE.Points(geometry, material);
    mesh.layers.set(0); // Stars layer
    mesh.frustumCulled = false; // Disable frustum culling for performance

    // Add to scene
    this.scene.add(mesh);

    // Store layer data
    const layer: StarLayer = {
      name: layerName,
      geometry,
      material,
      mesh,
      originalPositions: positions.slice(), // Copy for reset purposes
      config: lodConfig,
      starCount,
    };

    this.layers.set(layerName, layer);

    // Register material with uniform manager
    this.uniformManager.registerMaterial(`stars-${layerName}`, material, {
      time: { type: "float" },
      starSize: { type: "float", min: 0.1, max: 5.0 },
      globalTwinkleSpeed: { type: "float", min: 0, max: 10.0 },
      twinkleIntensity: { type: "float", min: 0, max: 2.0 },
      motionBlur: { type: "float", min: 0, max: 2.0 },
      fogNear: { type: "float", min: 0 },
      fogFar: { type: "float", min: 0 },
      fogColor: { type: "color" },
      fogDensity: { type: "float", min: 0 },
      nearFadeEndMultiplier: { type: "float", min: 0 },
      shakeIntensity: { type: "float", min: 0, max: 2.0 },
      warpProgress: { type: "float", min: 0, max: 1.0 },
      tunnelEffect: { type: "float", min: 0, max: 1.0 },
      forwardOffset: { type: "float" },
      minPointDepth: { type: "float", min: 0 },
      cameraPosition: { type: "vec3" },
      debugTwinkle: { type: "float" },
    });

    console.debug(
      `[STARFIELD] StarLayerManager: Created ${layerName} layer with ${starCount} stars`
    );
  }

  /**
   * Convert temperature (Kelvin) to RGB color
   */
  private temperatureToRGB(temp: number): { r: number; g: number; b: number } {
    temp = temp / 100;

    let red: number;
    if (temp <= 66) {
      red = 255;
    } else {
      red = temp - 60;
      red = 329.698727446 * Math.pow(red, -0.1332047592);
      red = Math.max(0, Math.min(255, red));
    }

    let green: number;
    if (temp <= 66) {
      green = temp;
      green = 99.4708025861 * Math.log(green) - 161.1195681661;
      green = Math.max(0, Math.min(255, green));
    } else {
      green = temp - 60;
      green = 288.1221695283 * Math.pow(green, -0.0755148492);
      green = Math.max(0, Math.min(255, green));
    }

    let blue: number;
    if (temp >= 66) {
      blue = 255;
    } else if (temp <= 19) {
      blue = 0;
    } else {
      blue = temp - 10;
      blue = 138.5177312231 * Math.log(blue) - 305.0447927307;
      blue = Math.max(0, Math.min(255, blue));
    }

    return {
      r: red / 255,
      g: green / 255,
      b: blue / 255,
    };
  }

  /**
   * Updates configuration and recreates layers if star properties changed
   */
  public updateConfig(newConfig: Partial<GalaxyStarfieldConfig>): void {
    this.config = deepmerge(this.config, newConfig) as GalaxyStarfieldConfig;

    const starPropertiesChanged = this.hasStarPropertiesChanged(newConfig);
    if (starPropertiesChanged) {
      console.debug(
        "[STARFIELD] StarLayerManager: Star properties changed, recreating layers"
      );
      this.createStarfield();
    } else {
      // Just update uniforms for non-structural changes
      this.applyCurrentState();
    }
  }

  /**
   * Check if star properties that require layer recreation have changed
   */
  private hasStarPropertiesChanged(
    newConfig: Partial<GalaxyStarfieldConfig>
  ): boolean {
    const structuralProps = ["starLOD", "starMinDistance", "starMaxDistance"];

    return structuralProps.some((prop) => prop in newConfig);
  }

  /**
   * Apply current state to all star materials
   */
  public applyCurrentState(): void {
    const uniforms: UniformBatch = {
      time: performance.now() * 0.001,
      starSize: this.config.starSize,
      motionBlur: this.config.motionBlurIntensity,
      fogNear: this.config.fogNear,
      fogFar: this.config.fogFar,
      nearFadeEndMultiplier: this.config.nearFadeEndMultiplier,
      shakeIntensity: this.state.shakeIntensity,
      warpProgress: this.state.warpProgress,
      tunnelEffect: this.state.tunnelEffect,
      forwardOffset: this.state.forwardOffset,
    };

    this.batchUpdateUniforms(uniforms);
  }

  /**
   * Update time uniform for twinkle animation
   * This should be called every frame
   */
  public updateTimeUniform(): void {
    const time = performance.now() * 0.001;
    this.batchUpdateUniforms({ time });
  }

  /**
   * Set layer visibility
   */
  public setLayerVisible(layerName: string, visible: boolean): void {
    const layer = this.layers.get(layerName);
    if (layer) {
      layer.mesh.visible = visible;
      console.debug(
        `[STARFIELD] StarLayerManager: Set ${layerName} layer visibility to ${visible}`
      );
    }
  }

  /**
   * Batch update uniforms across all star layers
   */
  public batchUpdateUniforms(uniforms: UniformBatch): void {
    for (const [layerName] of this.layers) {
      this.uniformManager.updateUniforms(`stars-${layerName}`, uniforms);
    }
  }

  /**
   * Update star positions using a custom function
   */
  public updateStarPositions(updateFn: PositionUpdateFunction): void {
    for (const layer of this.layers.values()) {
      const positions = layer.geometry.attributes.position
        .array as Float32Array;
      updateFn(positions, layer.originalPositions, layer);
      layer.geometry.attributes.position.needsUpdate = true;
    }
  }

  /**
   * Set warp animation state
   */
  public setWarpState(
    isWarping: boolean,
    progress: number = 0,
    phase: WarpPhase = "IDLE"
  ): void {
    this.state.isWarping = isWarping;
    this.state.warpProgress = progress;
    this.state.currentPhase = phase;

    // Calculate tunnel effect during climax phase
    if (isWarping && phase === "CLIMAX") {
      this.state.tunnelEffect = Math.sin(progress * Math.PI) * 0.8;
    } else {
      this.state.tunnelEffect = 0;
    }

    // Apply forward offset during warp
    this.state.forwardOffset = isWarping ? progress * 100 : 0;

    this.applyCurrentState();
  }

  /**
   * Set shake animation state
   */
  public setShakeState(intensity: number): void {
    this.state.shakeIntensity = Math.max(0, Math.min(2, intensity));
    this.applyCurrentState();
  }

  /**
   * Get the first available layer (for backward compatibility)
   */
  public getFirstLayer(): StarLayer | undefined {
    const firstEntry = this.layers.entries().next();
    return firstEntry.done ? undefined : firstEntry.value[1];
  }

  /**
   * Get a specific layer by name
   */
  public getLayer(layerName: string): StarLayer | undefined {
    return this.layers.get(layerName);
  }

  /**
   * Destroy all star layers
   */
  public destroyAllLayers(): void {
    for (const [layerName, layer] of this.layers) {
      // Remove from scene
      this.scene.remove(layer.mesh);

      // Dispose of Three.js resources
      layer.geometry.dispose();
      layer.material.dispose();

      // Unregister from uniform manager
      this.uniformManager.unregisterMaterial(`stars-${layerName}`);

      console.debug(
        `[STARFIELD] StarLayerManager: Destroyed ${layerName} layer`
      );
    }

    this.layers.clear();
  }

  /**
   * Get performance statistics
   */
  public getStats(): StarLayerStats {
    const stats: StarLayerStats = {
      totalLayers: this.layers.size,
      visibleLayers: 0,
      totalStars: 0,
      visibleStars: 0,
      layerDetails: {},
    };

    for (const [name, layer] of this.layers) {
      const { visible } = layer.mesh;
      const triangles = layer.starCount; // Points render as quads/triangles

      stats.layerDetails[name] = {
        starCount: layer.starCount,
        visible,
        triangles,
      };

      stats.totalStars += layer.starCount;
      if (visible) {
        stats.visibleLayers++;
        stats.visibleStars += layer.starCount;
      }
    }

    return stats;
  }

  /**
   * Get current animation state
   */
  public getState(): StarLayerState {
    return { ...this.state };
  }

  /**
   * Get all layer names
   */
  public getLayerNames(): string[] {
    return Array.from(this.layers.keys());
  }

  /**
   * Check if any layers exist
   */
  public hasLayers(): boolean {
    return this.layers.size > 0;
  }

  /**
   * Get total star count across all layers
   */
  public getTotalStarCount(): number {
    let total = 0;
    for (const layer of this.layers.values()) {
      total += layer.starCount;
    }
    return total;
  }
}

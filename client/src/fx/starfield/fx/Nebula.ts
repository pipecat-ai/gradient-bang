import * as THREE from "three";

import type { GalaxyStarfieldConfig } from "../constants";
import type { UniformManager } from "../managers/UniformManager";
import { nebulaFragmentShader, nebulaVertexShader } from "../shaders/nebula";
import { createNoiseTexture } from "../utils/noiseTexture";
import { FX } from "./FX";

export class Nebula extends FX {
  private _nebula: THREE.Mesh | null;
  private _nebulaMaterial: THREE.ShaderMaterial | null;
  private _noiseTexture: THREE.DataTexture | null;
  private _config: GalaxyStarfieldConfig | null;

  constructor(uniformManager: UniformManager, scene: THREE.Scene) {
    super(uniformManager, scene);
    this._noiseTexture = null;
    this._nebula = null;
    this._nebulaMaterial = null;
    this._config = null;
    this.ensureNoiseTexture();
  }

  public create(config: GalaxyStarfieldConfig): void {
    console.debug("[NEBULA] Creating");

    if (this._nebula) {
      this.destroy();
    }

    this._config = config;
    const nebulaGeometry = new THREE.SphereGeometry(400, 8, 8);

    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const bandAxis = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi)
    ).normalize();

    const noiseTexture = this.ensureNoiseTexture();
    const nebulaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        noiseTexture: { value: noiseTexture },
        nebulaNoiseUse: { value: 0.0 },
        nebulaColor1: {
          value: new THREE.Vector3(
            config.nebulaColor1.r,
            config.nebulaColor1.g,
            config.nebulaColor1.b
          ),
        },
        nebulaColor2: {
          value: new THREE.Vector3(
            config.nebulaColor2.r,
            config.nebulaColor2.g,
            config.nebulaColor2.b
          ),
        },
        intensity: { value: config.nebulaIntensity },
        warpProgress: { value: 0.0 },
        tunnelEffect: { value: 0.0 },
        bandAxis: { value: bandAxis },
        bandWidth: { value: 0.18 },
        bandSoftness: { value: 0.35 },
        baseNoiseScale: { value: 1.5 },
        flowSpeed: { value: 0.05 },
        idleNoiseSpeed: { value: 0.0 },
        nebulaIdleNoiseSpeed: { value: config.nebulaIdleNoiseSpeed },
        warpNoiseSpeed: { value: 0.05 },
        posterizeLevels: { value: config.nebulaPosterizeLevels },
        ditherAmount: { value: config.nebulaDitherAmount },
        pixelateScale: { value: config.nebulaPixelateScale },
        driftSpeed: { value: config.nebulaDriftSpeed },
        anisotropy: { value: config.nebulaAnisotropy },
        domainWarpStrength: { value: config.nebulaDomainWarpStrength },
        filamentContrast: { value: config.nebulaFilamentContrast },
        darkLaneStrength: { value: config.nebulaDarkLaneStrength },
        nebulaColorMid: {
          value: new THREE.Vector3(
            config.nebulaColorMid.r,
            config.nebulaColorMid.g,
            config.nebulaColorMid.b
          ),
        },
        shadowCenter: { value: new THREE.Vector2(0.5, 0.5) },
        shadowRadius: { value: 0.15 },
        shadowSoftness: { value: config.planetShadowSoftness || 0.3 },
        shadowStrength: {
          value: config.planetShadowEnabled
            ? config.planetShadowOpacity || 1.0
            : 0.0,
        },
        resolution: {
          value: new THREE.Vector2(window.innerWidth, window.innerHeight),
        },
      },
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      precision: "mediump",
      side: THREE.BackSide,
      transparent: true,
      blending: config.nebulaBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    this._uniformManager.registerMaterial("nebula", nebulaMaterial, {
      time: { type: "number" },
      intensity: { type: "number", min: 0, max: 5 },
      warpProgress: { type: "number", min: 0, max: 1 },
      tunnelEffect: { type: "number", min: 0, max: 1 },
      nebulaColor1: { type: "color" },
      nebulaColor2: { type: "color" },
      nebulaColorMid: { type: "color" },
      nebulaIdleNoiseSpeed: { type: "number", min: 0 },
      driftSpeed: { type: "number", min: 0 },
      anisotropy: { type: "number", min: 0.5 },
      domainWarpStrength: { type: "number", min: 0, max: 1 },
      filamentContrast: { type: "number", min: 0, max: 1 },
      darkLaneStrength: { type: "number", min: 0, max: 1 },
      posterizeLevels: { type: "number", min: 0 },
      ditherAmount: { type: "number", min: 0, max: 1 },
      pixelateScale: { type: "number", min: 0 },
      shadowCenter: { type: "vector2" },
      shadowRadius: { type: "number", min: 0 },
      shadowSoftness: { type: "number", min: 0 },
      shadowStrength: { type: "number", min: 0, max: 1 },
      resolution: { type: "vector2" },
    });

    this._nebula = new THREE.Mesh(nebulaGeometry, nebulaMaterial);
    this._nebulaMaterial = nebulaMaterial;
    this._nebulaMaterial.blending = config.nebulaBlending;
    this._nebula.renderOrder = -10;
    this._nebula.layers.set(0);
    this._scene.add(this._nebula);
  }

  public destroy(): void {
    console.debug("[NEBULA] Destroying");
    if (!this._nebula) return;

    this._scene.remove(this._nebula);

    this._uniformManager.unregisterMaterial("nebula");
    this._nebula.geometry.dispose();
    (this._nebula.material as THREE.Material).dispose();
    this._nebula = null;
    this._nebulaMaterial = null;
    //this._config = null;
  }

  public toggle(enabled: boolean): void {
    console.log("[NEBULA] Toggling", enabled);
    if (enabled === !!this._nebula) return;

    if (enabled && this._config) {
      this.create(this._config);
    } else {
      this.destroy();
    }
  }

  public restore(): void {
    console.debug("[NEBULA] Restoring");
    if (!this._nebula) return;
    if (this._nebulaMaterial) {
      if (this._noiseTexture) {
        this._noiseTexture.dispose();
        this._noiseTexture = null;
      }
      const noiseTexture = this.ensureNoiseTexture();
      this._nebulaMaterial.uniforms.noiseTexture.value = noiseTexture;
    }
  }

  public reset(): void {
    console.debug("[NEBULA] Resetting");
    if (!this._nebula) return;
    this._uniformManager.updateUniforms("nebula", {
      warpProgress: 0,
      tunnelEffect: 0,
    });
  }

  public resize(width: number, height: number): void {
    console.debug("[NEBULA] Resizing");
    if (!this._nebula) return;
    this._uniformManager.updateUniforms("nebula", {
      resolution: { x: width, y: height },
    });
  }

  /**
   * Get the nebula material for external access (e.g., LayerManager)
   */
  public getNebulaMaterial(): THREE.ShaderMaterial | null {
    return this._nebulaMaterial;
  }

  /**
   * Get layer data for self-registration with LayerManager
   */
  public getLayerData(): {
    name: string;
    material: THREE.Material;
    opacity: number;
  } | null {
    if (!this._nebulaMaterial) return null;
    return {
      name: "nebula",
      material: this._nebulaMaterial,
      opacity: 1.0,
    };
  }

  private ensureNoiseTexture(): THREE.DataTexture {
    if (!this._noiseTexture) {
      this._noiseTexture = createNoiseTexture(256);
    }
    return this._noiseTexture;
  }
}

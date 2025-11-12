import * as THREE from "three";

import type { GalaxyStarfieldConfig } from "../constants";
import type { UniformManager } from "../managers/UniformManager";
import { cloudsFragmentShader, cloudsVertexShader } from "../shaders/clouds";
import { createNoiseTexture } from "../utils/noiseTexture";
import { FX } from "./FX";

export class Clouds extends FX {
  private _clouds: THREE.Mesh | null;
  private _cloudsMaterial: THREE.ShaderMaterial | null;
  private _noiseTexture: THREE.DataTexture | null;
  private _config: GalaxyStarfieldConfig | null;

  constructor(uniformManager: UniformManager, scene: THREE.Scene) {
    super(uniformManager, scene);
    this._clouds = null;
    this._cloudsMaterial = null;
    this._config = null;
    this._noiseTexture = null;
    this.ensureNoiseTexture();
  }

  public create(config: GalaxyStarfieldConfig): void {
    console.debug("[CLOUDS] Creating");

    if (this._clouds) {
      this.destroy();
    }

    this._config = config;
    const noiseTexture = this.ensureNoiseTexture();
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        shakePhase: { value: 0 },
        resolution: {
          value: new THREE.Vector2(window.innerWidth, window.innerHeight),
        },
        cameraRotation: { value: new THREE.Vector3(0, 0, 0) },
        parallaxAmount: { value: config.cloudsParallaxAmount },
        intensity: { value: config.cloudsIntensity },
        color: {
          value: new THREE.Vector3(
            config.cloudsColor.r,
            config.cloudsColor.g,
            config.cloudsColor.b
          ),
        },
        cloudsColorPrimary: {
          value: new THREE.Vector3(
            config.cloudsColorPrimary.r,
            config.cloudsColorPrimary.g,
            config.cloudsColorPrimary.b
          ),
        },
        cloudsColorSecondary: {
          value: new THREE.Vector3(
            config.cloudsColorSecondary.r,
            config.cloudsColorSecondary.g,
            config.cloudsColorSecondary.b
          ),
        },
        speed: { value: config.cloudsSpeed },
        iterPrimary: { value: config.cloudsIterPrimary },
        iterSecondary: { value: config.cloudsIterSecondary },
        domainScale: { value: config.cloudsDomainScale },
        shakeWarpIntensity: { value: config.cloudsShakeWarpIntensity },
        shakeWarpRampTime: { value: config.cloudsShakeWarpRampTime },
        cloudsShakeProgress: { value: 0 },
        noiseTexture: { value: noiseTexture },
        noiseUse: { value: 1.0 },
        shadowCenter: { value: new THREE.Vector2(0.5, 0.5) },
        shadowRadius: { value: 0.15 },
        shadowSoftness: { value: config.planetShadowSoftness || 0.3 },
        shadowStrength: {
          value: config.planetShadowEnabled
            ? config.planetShadowOpacity || 1.0
            : 0.0,
        },
        noiseReduction: { value: config.cloudsNoiseReduction },
      },
      vertexShader: cloudsVertexShader,
      fragmentShader: cloudsFragmentShader,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: config.cloudsBlending,
    });

    const clouds = new THREE.Mesh(geo, mat);
    clouds.frustumCulled = false;
    clouds.renderOrder = -10;
    clouds.layers.set(0);
    this._scene.add(clouds);
    this._clouds = clouds;
    this._cloudsMaterial = mat;

    this._uniformManager.registerMaterial("clouds", mat, {
      time: { type: "number" },
      shakePhase: { type: "number" },
      resolution: { type: "vector2" },
      cameraRotation: { type: "vector3" },
      parallaxAmount: { type: "number", min: 0, max: 2 },
      intensity: { type: "number", min: 0, max: 5 },
      color: { type: "color" },
      cloudsColorPrimary: { type: "color" },
      cloudsColorSecondary: { type: "color" },
      speed: { type: "number", min: 0 },
      iterPrimary: { type: "number", min: 1 },
      iterSecondary: { type: "number", min: 1 },
      domainScale: { type: "number", min: 0 },
      shakeWarpIntensity: { type: "number", min: 0, max: 1 },
      shakeWarpRampTime: { type: "number", min: 0.1, max: 10 },
      cloudsShakeProgress: { type: "number", min: 0, max: 1 },
      noiseUse: { type: "number", min: 0, max: 1 },
      noiseReduction: { type: "number", min: 0, max: 0.5 },
      shadowCenter: { type: "vector2" },
      shadowRadius: { type: "number", min: 0 },
      shadowSoftness: { type: "number", min: 0 },
      shadowStrength: { type: "number", min: 0, max: 1 },
    });
  }

  public destroy(): void {
    console.debug("[CLOUDS] Destroying");
    if (!this._clouds) return;

    this._scene.remove(this._clouds);

    this._uniformManager.unregisterMaterial("clouds");
    this._clouds.geometry.dispose();
    (this._clouds.material as THREE.Material).dispose();
    this._clouds = null;
    this._cloudsMaterial = null;
    //this._config = null;
  }

  public toggle(enabled: boolean): void {
    console.log("[CLOUDS] Toggling", enabled);
    if (enabled === !!this._clouds) return;

    if (enabled && this._config) {
      this.create(this._config);
    } else {
      this.destroy();
    }
  }

  public restore(): void {
    console.debug("[CLOUDS] Restoring");
    if (!this._clouds) return;
    if (this._cloudsMaterial) {
      if (this._noiseTexture) {
        this._noiseTexture.dispose();
        this._noiseTexture = null;
      }
      const noiseTexture = this.ensureNoiseTexture();
      this._cloudsMaterial.uniforms.noiseTexture.value = noiseTexture;
    }
  }

  public reset(): void {
    console.debug("[CLOUDS] Resetting");
    if (!this._clouds) return;
    this._uniformManager.updateUniforms("clouds", {
      cloudsShakeProgress: 0,
    });
  }

  public resize(width: number, height: number): void {
    console.debug("[CLOUDS] Resizing");
    if (!this._clouds) return;
    this._uniformManager.updateUniforms("clouds", {
      resolution: { x: width, y: height },
    });
  }

  /**
   * Get the clouds material for external access (e.g., LayerManager)
   */
  public getCloudsMaterial(): THREE.ShaderMaterial | null {
    return this._cloudsMaterial;
  }

  private ensureNoiseTexture(): THREE.DataTexture {
    if (!this._noiseTexture) {
      this._noiseTexture = createNoiseTexture(512);
    }
    return this._noiseTexture;
  }
}

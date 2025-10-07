import * as THREE from "three";

import type { GalaxyStarfieldConfig } from "../constants";
import type { UniformManager } from "../managers/UniformManager";
import {
  backgroundFragmentShader,
  backgroundVertexShader,
} from "../shaders/background";
import { FX } from "./FX";

export class Background extends FX {
  private _background: THREE.Mesh | null;
  private _backgroundMaterial: THREE.ShaderMaterial | null;
  private _config: GalaxyStarfieldConfig | null;
  private _planetGroup: THREE.Group | null;
  private _planetRandomOffset: { x: number; y: number } | null;
  constructor(uniformManager: UniformManager, scene: THREE.Scene) {
    super(uniformManager, scene);
    this._background = null;
    this._backgroundMaterial = null;
    this._config = null;
    this._planetGroup = null;
    this._planetRandomOffset = null;
  }

  public create(config: GalaxyStarfieldConfig): Promise<void> {
    console.debug("[BACKGROUND] Creating");

    if (this._background) {
      this.destroy();
    }

    this._config = config;

    // Create background image
    const loader = new THREE.TextureLoader();

    return new Promise((resolve, reject) => {
      loader.load(
        config.planetImageUrl,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

          const bgMat = new THREE.ShaderMaterial({
            uniforms: {
              tDiffuse: { value: tex },
              opacity: {
                value: config.planetOpacity || 1.0,
              },
              time: { value: 0 },
              shakeIntensity: { value: 0 },
              shakePhase: { value: 0 },
              shakeAmplitude: { value: 0 },
              warpProgress: { value: 0 },
              tunnelEffect: { value: 0 },
            },
            vertexShader: backgroundVertexShader,
            fragmentShader: backgroundFragmentShader,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            blending: config.planetBlendMode,
          });

          this._uniformManager.registerMaterial("background", bgMat, {
            opacity: { type: "number", min: 0, max: 1 },
            time: { type: "number" },
            shakeIntensity: { type: "number", min: 0 },
            shakePhase: { type: "number" },
            shakeAmplitude: { type: "number", min: 0 },
            warpProgress: { type: "number", min: 0, max: 1 },
            tunnelEffect: { type: "number", min: 0, max: 1 },
          });

          const imageAspect = tex.image
            ? tex.image.width / tex.image.height
            : 1.0;
          const planeSize = 80;
          const quad = new THREE.Mesh(
            new THREE.PlaneGeometry(planeSize * imageAspect, planeSize),
            bgMat
          );
          quad.frustumCulled = false;
          quad.renderOrder = -1000;

          const initX = config.planetPositionX || 0;
          const initY = config.planetPositionY || 0;
          const initZ = config.planetZ || -300;
          quad.position.set(initX, initY, initZ);

          this._planetRandomOffset = { x: initX, y: initY };

          quad.scale.set(1, 1, 1);
          quad.layers.set(1);

          this._backgroundMaterial = bgMat;
          this._background = quad;

          // Create a group so the planet and shadow move/scale together
          const planetGroup = new THREE.Group();
          planetGroup.position.copy(quad.position);
          planetGroup.scale.set(1, 1, 1);
          planetGroup.layers.set(1);
          this._scene.add(planetGroup);

          // Parent planet to group
          planetGroup.add(quad);
          quad.position.set(0, 0, 0);

          // Apply initial scale from config
          planetGroup.scale.set(config.planetScale, config.planetScale, 1);
          this._planetGroup = planetGroup;

          // Resolve promise when texture is loaded and scene is updated
          console.debug("[BACKGROUND] Texture loaded successfully");
          resolve();
        },
        undefined,
        (err) => {
          console.warn("Background image load failed:", err);
          reject(err);
        }
      );
    });
  }

  public destroy(): void {
    console.debug("[BACKGROUND] Destroying");
    if (!this._background) return;

    if (this._planetGroup) {
      this._scene.remove(this._planetGroup);
      this._planetGroup = null;
    }

    this._uniformManager.unregisterMaterial("background");

    if (this._background) {
      this._background.geometry.dispose();
      this._background = null;
    }

    if (this._backgroundMaterial) {
      this._backgroundMaterial.dispose();
      this._backgroundMaterial = null;
    }

    this._config = null;
    this._planetRandomOffset = null;
  }

  public toggle(enabled: boolean): Promise<void> {
    if (enabled === !!this._background) return Promise.resolve();

    if (enabled && this._config) {
      return this.create(this._config);
    } else {
      this.destroy();
      return Promise.resolve();
    }
  }

  public resize(): void {}

  public updatePlanetPosition(cameraPosition: THREE.Vector3): void {
    if (this._planetGroup && this._planetRandomOffset) {
      // Update planet position every frame to follow camera smoothly
      const planetDistance = -300;
      this._planetGroup.position.set(
        cameraPosition.x + this._planetRandomOffset.x,
        cameraPosition.y + this._planetRandomOffset.y,
        cameraPosition.z + planetDistance
      );

      // Make planet always face the camera
      this._planetGroup.lookAt(cameraPosition);
    }
  }

  public getPlanetGroup(): THREE.Group | null {
    return this._planetGroup;
  }

  public getPlanetRandomOffset(): { x: number; y: number } | null {
    return this._planetRandomOffset;
  }

  public getBackgroundMaterial(): THREE.ShaderMaterial | null {
    return this._backgroundMaterial;
  }

  public getBackgroundMesh(): THREE.Mesh | null {
    return this._background;
  }
}

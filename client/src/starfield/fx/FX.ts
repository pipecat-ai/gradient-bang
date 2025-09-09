import * as THREE from "three";
import type { GalaxyStarfieldConfig } from "../constants";
import type { UniformManager } from "../managers/UniformManager";

export abstract class FX {
  readonly _uniformManager: UniformManager;
  readonly _scene: THREE.Scene;

  constructor(uniformManager: UniformManager, scene: THREE.Scene) {
    this._uniformManager = uniformManager;
    this._scene = scene;
  }
  create(_config: GalaxyStarfieldConfig) {}
  destroy() {}
  update() {}
  toggle(_enabled: boolean) {}
  restore() {}
  reset() {}
  resize(_width: number, _height: number) {}
}

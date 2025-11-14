import * as THREE from "three"

import type { GalaxyStarfieldConfig } from "../constants"
import type { UniformManager } from "../managers/UniformManager"

export abstract class FX {
  readonly _uniformManager: UniformManager
  readonly _scene: THREE.Scene

  constructor(uniformManager: UniformManager, scene: THREE.Scene) {
    this._uniformManager = uniformManager
    this._scene = scene
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  create(_config: GalaxyStarfieldConfig) {}
  destroy() {}

  update() {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toggle(_enabled: boolean) {}

  restore() {}

  reset() {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resize(_width: number, _height: number) {}
}

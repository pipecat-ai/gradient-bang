import * as THREE from "three"
import { create } from "zustand"

interface TextureCacheState {
  textures: Map<string, THREE.Texture>
  setTexture: (url: string, texture: THREE.Texture) => void
  getTexture: (url: string) => THREE.Texture | undefined
}

/**
 * Reactive texture cache using Zustand
 * Components can subscribe to texture availability
 */
export const useTextureCache = create<TextureCacheState>((set, get) => ({
  textures: new Map(),
  setTexture: (url, texture) => {
    set((state) => {
      const newMap = new Map(state.textures)
      newMap.set(url, texture)
      return { textures: newMap }
    })
  },
  getTexture: (url) => get().textures.get(url),
}))

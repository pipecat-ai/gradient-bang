import { useLayoutEffect, useMemo, useRef } from "react"
import { useLoader, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { useGameStore } from "@/useGameStore"
import { useTextureCache } from "@/utils/textureCache"

/**
 * AssetPreloader - Preloads all image assets from config
 *
 * Place inside Suspense to ensure all textures are loaded before
 * the scene is considered "ready". This prevents frame hitches
 * when game objects are added later.
 *
 * Downloads textures, uploads to GPU, and stores in reactive cache.
 */
export function AssetPreloader() {
  const gl = useThree((state) => state.gl)
  const imageAssets = useGameStore((state) => state.starfieldConfig.imageAssets)
  const setTexture = useTextureCache((state) => state.setTexture)
  const initializedRef = useRef(false)

  // Get all unique URLs from image assets (memoized for stable reference)
  const urls = useMemo(
    () => imageAssets?.map((asset) => asset.url) ?? [],
    [imageAssets]
  )

  // useLoader suspends until all textures are loaded
  const textures = useLoader(THREE.TextureLoader, urls)

  // Store textures in cache and force GPU upload
  // Using useLayoutEffect to run synchronously after render (avoids setState during render)
  useLayoutEffect(() => {
    if (!textures || !gl || initializedRef.current) return

    const textureArray = Array.isArray(textures) ? textures : [textures]
    
    // Store each texture in the cache by URL
    urls.forEach((url, index) => {
      const texture = textureArray[index]
      if (texture && url) {
        // Set color space to sRGB (matches drei's useTexture behavior)
        // Without this, textures appear too bright (linear color space)
        texture.colorSpace = THREE.SRGBColorSpace
        // initTexture uploads the texture to GPU memory
        gl.initTexture(texture)
        setTexture(url, texture)
      }
    })
    
    initializedRef.current = true
  }, [textures, urls, gl, setTexture])

  // This component renders nothing - it just forces texture loading
  return null
}

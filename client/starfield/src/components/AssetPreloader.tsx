import { useLoader } from "@react-three/fiber"
import * as THREE from "three"

import { useGameStore } from "@/useGameStore"

/**
 * AssetPreloader - Preloads all image assets from config
 *
 * Place inside Suspense to ensure all textures are loaded before
 * the scene is considered "ready". This prevents frame hitches
 * when game objects are added later.
 */
export function AssetPreloader() {
  const imageAssets = useGameStore((state) => state.starfieldConfig.imageAssets)

  // Get all unique URLs from image assets
  const urls = imageAssets?.map((asset) => asset.url) ?? []

  // useLoader suspends until all textures are loaded
  // If no URLs, we pass an empty array which returns immediately
  useLoader(THREE.TextureLoader, urls)

  // This component renders nothing - it just forces texture loading
  return null
}

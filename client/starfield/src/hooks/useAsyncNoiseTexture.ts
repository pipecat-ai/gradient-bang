import { useEffect, useState } from "react";
import * as THREE from "three";
import { createNoiseTexture } from "../utils/noiseTexture";

/**
 * Cache for noise textures to avoid regenerating the same resolution
 */
const textureCache = new Map<number, THREE.DataTexture>();

/**
 * In-flight promises for noise texture generation
 * Used to prevent duplicate generation requests
 */
const pendingTextures = new Map<number, Promise<THREE.DataTexture>>();

/**
 * Generates a noise texture asynchronously
 * This allows the operation to be non-blocking and work with React Suspense
 */
async function generateNoiseTextureAsync(
  resolution: number
): Promise<THREE.DataTexture> {
  return new Promise((resolve) => {
    // Use setTimeout to make this async and non-blocking
    setTimeout(() => {
      console.log(
        `[STARFIELD] Generating noise texture: ${resolution}x${resolution}`
      );
      const texture = createNoiseTexture(resolution);
      resolve(texture);
    }, 0);
  });
}

/**
 * Hook to load noise textures asynchronously with Suspense support
 *
 * This hook integrates with React Suspense to provide non-blocking texture generation.
 * The component using this hook will suspend until the texture is ready.
 *
 * @param resolution - The resolution of the noise texture (128, 256, or 512)
 * @returns The loaded noise texture
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const noiseTexture = useAsyncNoiseTexture(512);
 *   // Use the texture in your material
 * }
 * ```
 */
export function useAsyncNoiseTexture(resolution: number): THREE.DataTexture {
  // Check cache first
  const cached = textureCache.get(resolution);
  if (cached) {
    return cached;
  }

  // Check if there's a pending request
  let pending = pendingTextures.get(resolution);
  if (pending) {
    throw pending; // Suspend until ready
  }

  // Create and store the pending promise
  pending = generateNoiseTextureAsync(resolution).then((texture) => {
    textureCache.set(resolution, texture);
    pendingTextures.delete(resolution);
    return texture;
  });

  pendingTextures.set(resolution, pending);

  // Throw the promise to trigger Suspense
  throw pending;
}

/**
 * Hook for non-Suspense async noise texture loading
 * Useful if you want to handle loading state manually without Suspense
 *
 * @param resolution - The resolution of the noise texture
 * @returns Object with texture, loading state, and error
 */
export function useNoiseTexture(resolution: number) {
  const [texture, setTexture] = useState<THREE.DataTexture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Check cache first
    const cached = textureCache.get(resolution);
    if (cached) {
      setTexture(cached);
      setLoading(false);
      return;
    }

    // Generate texture
    setLoading(true);
    generateNoiseTextureAsync(resolution)
      .then((tex) => {
        textureCache.set(resolution, tex);
        setTexture(tex);
        setLoading(false);
      })
      .catch((err) => {
        setError(err);
        setLoading(false);
      });

    // Cleanup
    return () => {
      // Don't dispose here as texture might be cached
    };
  }, [resolution]);

  return { texture, loading, error };
}

/**
 * Clear the texture cache (useful for cleanup or memory management)
 */
export function clearNoiseTextureCache(): void {
  textureCache.forEach((texture) => texture.dispose());
  textureCache.clear();
  pendingTextures.clear();
  console.log("[Async] Noise texture cache cleared");
}

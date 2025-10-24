import type { AssetManifest } from "@assets/index";
import { useEffect, useState } from "react";

/**
 * Asset loading state and methods
 */
export interface UseAssetPreloaderResult {
  loaded: boolean;
  progress: number;
  error: Error | null;
  loadedCount: number;
  totalCount: number;
}

/**
 * Options for the asset preloader
 */
export interface AssetPreloaderOptions {
  onProgress?: (
    progress: number,
    loadedCount: number,
    totalCount: number
  ) => void;
  onComplete?: () => void;
  onError?: (error: Error, assetUrl: string) => void;
  timeout?: number; // Timeout per asset in milliseconds
}

/**
 * Hook to preload game assets before starting the game
 *
 * @param manifest - Asset manifest containing preload and lazy assets
 * @param options - Optional callbacks and configuration
 * @returns Loading state and progress information
 *
 * @example
 * ```tsx
 * const { loaded, progress, error } = useAssetPreloader(GAME_ASSETS, {
 *   onProgress: (progress) => console.log(`Loading: ${progress}%`),
 *   onComplete: () => console.log('All assets loaded!'),
 * });
 * ```
 */
export function useAssetPreloader(
  manifest: AssetManifest,
  options: AssetPreloaderOptions = {}
): UseAssetPreloaderResult {
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const { onProgress, onComplete, onError, timeout = 30000 } = options;

  useEffect(() => {
    let cancelled = false;

    const loadAssets = async () => {
      // Collect all preload assets
      const preloadAssets = [
        ...manifest.preload.images,
        ...manifest.preload.audio,
      ];

      const total = preloadAssets.length;
      setTotalCount(total);

      if (total === 0) {
        setLoaded(true);
        setProgress(100);
        onComplete?.();
        return;
      }

      let loaded = 0;

      // Load all assets in parallel
      const promises = preloadAssets.map(async (src) => {
        if (cancelled) return;

        try {
          await loadAsset(src, timeout);

          if (!cancelled) {
            loaded++;
            const currentProgress = Math.round((loaded / total) * 100);
            setLoadedCount(loaded);
            setProgress(currentProgress);
            onProgress?.(currentProgress, loaded, total);
          }
        } catch (err) {
          if (!cancelled) {
            const error =
              err instanceof Error ? err : new Error(`Failed to load: ${src}`);
            console.error(`Failed to load asset: ${src}`, error);
            onError?.(error, src);
            throw error;
          }
        }
      });

      try {
        await Promise.all(promises);

        if (!cancelled) {
          setLoaded(true);
          onComplete?.();
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err : new Error("Failed to load assets")
          );
        }
      }
    };

    loadAssets();

    // Cleanup function
    return () => {
      cancelled = true;
    };
  }, [manifest, onProgress, onComplete, onError, timeout]);

  return {
    loaded,
    progress,
    error,
    loadedCount,
    totalCount,
  };
}

/**
 * Load a specific asset group on-demand (for lazy loading)
 *
 * @param manifest - Asset manifest
 * @param groupName - Name of the lazy-load group (e.g., 'level1')
 * @param onProgress - Optional progress callback
 * @returns Promise that resolves when all assets in the group are loaded
 *
 * @example
 * ```tsx
 * await loadAssetGroup(GAME_ASSETS, 'level1', (progress) => {
 *   console.log(`Level 1 loading: ${progress}%`);
 * });
 * ```
 */
export async function loadAssetGroup(
  manifest: AssetManifest,
  groupName: string,
  onProgress?: (progress: number) => void,
  timeout: number = 30000
): Promise<void> {
  const group = manifest.lazy[groupName];

  if (!group) {
    throw new Error(`Asset group '${groupName}' not found in manifest`);
  }

  const assets = [...group.images, ...group.audio];
  const total = assets.length;

  if (total === 0) {
    onProgress?.(100);
    return;
  }

  let loaded = 0;

  const promises = assets.map(async (src) => {
    await loadAsset(src, timeout);
    loaded++;
    const progress = Math.round((loaded / total) * 100);
    onProgress?.(progress);
  });

  await Promise.all(promises);
}

/**
 * Load a single asset with timeout
 */
function loadAsset(src: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Asset loading timeout: ${src}`));
    }, timeout);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    if (isImageAsset(src)) {
      loadImage(src)
        .then(() => {
          cleanup();
          resolve();
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    } else if (isAudioAsset(src)) {
      loadAudio(src)
        .then(() => {
          cleanup();
          resolve();
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    } else {
      cleanup();
      // Unknown asset type, just resolve
      resolve();
    }
  });
}

/**
 * Load an image asset
 */
function loadImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));

    // Start loading
    img.src = src;
  });
}

/**
 * Load an audio asset
 */
function loadAudio(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();

    const handleCanPlay = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error(`Failed to load audio: ${src}`));
    };

    const cleanup = () => {
      audio.removeEventListener("canplaythrough", handleCanPlay);
      audio.removeEventListener("error", handleError);
    };

    audio.addEventListener("canplaythrough", handleCanPlay, { once: true });
    audio.addEventListener("error", handleError, { once: true });

    // Start loading
    audio.src = src;
    audio.load();
  });
}

/**
 * Check if a URL is an image asset
 */
function isImageAsset(src: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(src);
}

/**
 * Check if a URL is an audio asset
 */
function isAudioAsset(src: string): boolean {
  return /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(src);
}

/**
 * React hook for lazy-loading asset groups
 *
 * @example
 * ```tsx
 * function Level1() {
 *   const { loaded, progress } = useLazyAssets('level1');
 *
 *   if (!loaded) {
 *     return <div>Loading level: {progress}%</div>;
 *   }
 *
 *   return <div>Level 1 content</div>;
 * }
 * ```
 */
export function useLazyAssets(manifest: AssetManifest, groupName: string) {
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadAssetGroup(manifest, groupName, (prog) => {
      if (!cancelled) {
        setProgress(prog);
      }
    })
      .then(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [manifest, groupName]);

  return { loaded, progress, error };
}

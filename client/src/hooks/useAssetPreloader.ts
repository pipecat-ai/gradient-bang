import { chunks, images, sounds, videos } from "@/assets";
import { useCallback, useState } from "react";

export type AssetType = "chunk" | "image" | "video" | "sound";

export type PreloadProgress = {
  phase: "idle" | "loading" | "complete" | "error";
  message: string;
  loaded: number;
  total: number;
  currentAsset?: string;
  currentType?: AssetType;
  percentage: number;
};

// Preload an image
const preloadImage = (url: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });
};

// Preload audio
const preloadAudio = (url: string): Promise<void> => {
  return new Promise((resolve) => {
    const audio = new Audio();

    const onReady = () => {
      resolve();
    };

    const onError = (e: unknown) => {
      console.warn(`[PRELOAD] Audio load failed: ${url}`, e);
      resolve(); // Don't block on audio failure
    };

    audio.addEventListener("canplaythrough", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.src = url;
    audio.load();
  });
};

// Preload a video (just fetch to populate cache)
const preloadVideo = (url: string): Promise<void> => {
  return fetch(url)
    .then(() => undefined)
    .catch((err) => {
      console.warn(`[PRELOAD] Video load failed: ${url}`, err);
      // Don't reject - allow other assets to load
    });
};

// Preload JS chunks
const preloadChunks = async (): Promise<void> => {
  console.debug("[PRELOAD] Loading JS chunks...");

  // Load all chunks defined in assets/index.ts
  await Promise.all(Object.values(chunks).map((chunkLoader) => chunkLoader()));

  console.debug("[PRELOAD] JS chunks loaded");
};

// Global flags to prevent re-loading and handle race conditions
const _g = globalThis as typeof globalThis & {
  __gb_assetsPreloaded?: boolean;
  __gb_assetsLoading?: boolean;
};
_g.__gb_assetsPreloaded = _g.__gb_assetsPreloaded || false;
_g.__gb_assetsLoading = _g.__gb_assetsLoading || false;

export const useAssetPreloader = () => {
  const [progress, setProgress] = useState<PreloadProgress>({
    phase: "idle",
    message: "Ready to load",
    loaded: 0,
    total: 0,
    percentage: 0,
  });

  const preloadAll = useCallback(async (): Promise<void> => {
    // Skip if already preloaded or currently loading
    if (_g.__gb_assetsPreloaded) {
      console.debug("[PRELOAD] Already complete, skipping");
      const chunkList = Object.entries(chunks);
      const imageList = Object.entries(images);
      const videoList = Object.entries(videos);
      const soundList = Object.entries(sounds);
      const total =
        chunkList.length +
        imageList.length +
        videoList.length +
        soundList.length;

      setProgress({
        phase: "complete",
        message: "All assets loaded",
        loaded: total,
        total,
        percentage: 100,
      });
      return;
    }

    // Check if another instance is already loading
    if (_g.__gb_assetsLoading) {
      console.debug(
        "[PRELOAD] Already loading in another instance, waiting..."
      );

      // Poll until loading is complete
      const pollInterval = 100; // Check every 100ms
      const maxWait = 30000; // Max 30 seconds
      let waited = 0;

      while (_g.__gb_assetsLoading && waited < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }

      // After waiting, show complete state
      if (_g.__gb_assetsPreloaded) {
        console.debug(
          "[PRELOAD] Other instance finished, showing complete state"
        );
        const chunkList = Object.entries(chunks);
        const imageList = Object.entries(images);
        const videoList = Object.entries(videos);
        const soundList = Object.entries(sounds);
        const total =
          chunkList.length +
          imageList.length +
          videoList.length +
          soundList.length;

        setProgress({
          phase: "complete",
          message: "All assets loaded",
          loaded: total,
          total,
          percentage: 100,
        });
      }
      return;
    }

    // Set loading flag immediately to prevent concurrent runs
    _g.__gb_assetsLoading = true;
    console.debug("[PRELOAD] Starting asset preload");

    const chunkList = Object.entries(chunks);
    const imageList = Object.entries(images);
    const videoList = Object.entries(videos);
    const soundList = Object.entries(sounds);

    // Total: chunks + images + videos + sounds
    const total =
      chunkList.length + imageList.length + videoList.length + soundList.length;
    let loaded = 0;

    const updateProgress = (type: AssetType, name: string, message: string) => {
      loaded++;
      const percentage = Math.round((loaded / total) * 100);
      console.debug(`[PRELOAD] ${loaded}/${total} - ${name}`);

      setProgress({
        phase: "loading",
        message,
        loaded,
        total,
        currentAsset: name,
        currentType: type,
        percentage,
      });
    };

    try {
      setProgress({
        phase: "loading",
        message: "Initializing...",
        loaded: 0,
        total,
        percentage: 0,
      });

      // 1. Preload JS chunks first (starts download ASAP)
      await preloadChunks();
      chunkList.forEach(([name]) => {
        updateProgress("chunk", name, `Chunk: ${name}`);
      });

      // 2. Preload images, videos, and sounds in parallel
      await Promise.all([
        // Images
        ...imageList.map(([name, url]) =>
          preloadImage(url)
            .then(() => updateProgress("image", name, `Image: ${name}`))
            .catch((err) => {
              console.error(`[PRELOAD] Image failed: ${name}`, err);
              updateProgress("image", name, `Image: ${name} (failed)`);
            })
        ),
        // Videos
        ...videoList.map(([name, url]) =>
          preloadVideo(url)
            .then(() => updateProgress("video", name, `Video: ${name}`))
            .catch((err) => {
              console.error(`[PRELOAD] Video failed: ${name}`, err);
              updateProgress("video", name, `Video: ${name} (failed)`);
            })
        ),
        // Sounds
        ...soundList.map(([name, url]) =>
          preloadAudio(url)
            .then(() => updateProgress("sound", name, `Sound: ${name}`))
            .catch((err) => {
              console.error(`[PRELOAD] Sound failed: ${name}`, err);
              updateProgress("sound", name, `Sound: ${name} (failed)`);
            })
        ),
      ]);

      // Complete!
      setProgress({
        phase: "complete",
        message: "All assets loaded",
        loaded: total,
        total,
        percentage: 100,
      });

      // Mark as complete
      _g.__gb_assetsPreloaded = true;
      console.debug("[PRELOAD] All assets preloaded successfully");
    } catch (error) {
      console.error("[PRELOAD] Fatal error during preload:", error);

      // Reset flags on error so user can retry
      _g.__gb_assetsPreloaded = false;

      setProgress((prev) => ({
        ...prev,
        phase: "error",
        message: `Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      }));
    } finally {
      // Always clear loading flag when done (success or error)
      _g.__gb_assetsLoading = false;
      console.debug("[PRELOAD] Loading flag cleared");
    }
  }, []);

  return {
    preloadAll,
    progress,
    isLoading: progress.phase === "loading",
    isComplete: progress.phase === "complete",
    hasError: progress.phase === "error",
  };
};

import { forwardRef, useImperativeHandle } from "react";
import { NebulaRef } from "../objects/Nebula";
import { StarsRef } from "../objects/Stars";
import { SceneConfig } from "../types";

/**
 * Ref type for SceneController component
 */
export interface SceneControllerRef {
  /**
   * Load a new scene configuration asynchronously
   * Pauses rendering, updates object configs, and resumes when ready
   */
  loadScene: (config: Partial<SceneConfig>) => Promise<void>;
}

interface SceneControllerProps {
  nebulaRef: React.RefObject<NebulaRef | null>;
  starsRef: React.RefObject<StarsRef | null>;
}

/**
 * SceneController manages scene transitions and configuration loading
 * Exposes loadScene method via imperative handle
 * Does not render any visual elements
 */
export const SceneController = forwardRef<
  SceneControllerRef,
  SceneControllerProps
>(({ nebulaRef, starsRef }, ref) => {
  useImperativeHandle(ref, () => ({
    loadScene: async (config: Partial<SceneConfig>) => {
      console.log("[STARFIELD] Starting scene transition...", config);

      // Pause rendering during transition
      //onPauseChange(true);

      const loadPromises: Promise<void>[] = [];

      // Load nebula config if provided
      if (config.nebula && nebulaRef.current) {
        loadPromises.push(nebulaRef.current.loadConfig(config.nebula));
      }

      // Load stars config if provided
      if (config.stars && starsRef.current) {
        loadPromises.push(starsRef.current.loadConfig(config.stars));
      }

      // Wait for all objects to be ready
      await Promise.all(loadPromises);

      // Resume rendering
      //onPauseChange(false);

      console.log("[STARFIELD] Scene transition complete");
    },
  }));

  // Controller component - no visual output
  return null;
});

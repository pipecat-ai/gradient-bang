import useGameStore from "@stores/game";
import { memo, useCallback, useEffect } from "react";

import type { GameObjectInstance } from "@/fx/starfield/types";
import { usePlaySound } from "@/hooks/usePlaySound";

export const StarField = memo(() => {
  const playSound = usePlaySound();
  const starfieldInstance = useGameStore.use.starfieldInstance?.();
  const settings = useGameStore.use.settings();

  const onWarpStart = useCallback(() => {
    console.log("[STARFIELD] 🚀 Warp started");
    playSound("warp");
  }, [playSound]);

  const onGameObjectSelected = useCallback((gameObject: GameObjectInstance) => {
    console.log("[STARFIELD] Game object selected:", gameObject.name);
  }, []);

  const onGameObjectInView = useCallback((gameObject: GameObjectInstance) => {
    console.log("[STARFIELD] Game object in view:", gameObject.name);
  }, []);

  const onGameObjectCleared = useCallback(() => {
    console.log("[STARFIELD] Game object cleared");
  }, []);

  /*
   * Initialize or re-initialize starfield
   */
  useEffect(() => {
    if (!settings.renderStarfield || !starfieldInstance) {
      return;
    }

    console.debug("[STARFIELD] Attaching callbacks to starfield");

    starfieldInstance.callbacks = {
      onWarpStart: onWarpStart,
      onGameObjectSelected: onGameObjectSelected,
      onGameObjectInView: onGameObjectInView,
      onGameObjectCleared: onGameObjectCleared,
    };
  }, [
    settings.renderStarfield,
    onWarpStart,
    onGameObjectSelected,
    onGameObjectInView,
    onGameObjectCleared,
    starfieldInstance,
  ]);

  /*
   * Create starfield instance on initial render
   */
  /*useEffect(() => {
    if (!ready) return;

    if (!settings.renderStarfield || !starfieldInstance) {
      return;
    }

    console.debug("[STARFIELD] Assigning callbacks");

    starfieldInstance.callbacks = {
      onSceneIsLoading: () => {
        console.log("[STARFIELD] 🔄 Scene is loading...");
      },
      onSceneReady: (isInitialRender: boolean, sceneId: string | null) => {
        console.log(
          "[STARFIELD] ✅ Scene ready!",
          isInitialRender ? "(initial)" : "(warp)",
          `scene: ${sceneId || "unknown"}`
        );
      },
      onWarpStart: () => {
        console.log("[STARFIELD] 🚀 Warp started");
        playSound("warp");
      },
      onWarpComplete(queueLength) {
        console.log(`[STARFIELD] 🎉 Warp complete - ${queueLength} remaining`);
        if (queueLength === 0) {
          // state.setAutopilot(false);
        }
      },
      onWarpQueue: () => {
        // state.setAutopilot(true);
      },
      onGameObjectInView: (gameObject) => {
        console.log("[STARFIELD] Game object in view:", gameObject.name);
      },
      onGameObjectSelected: (gameObject) => {
        console.log("[STARFIELD] Game object selected:", gameObject.name);
      },
      onGameObjectCleared: () => {
        console.log("[STARFIELD] Game object cleared");
      },
    };

    return () => {
      // Note: we don't unmount the Starfield instance as it's always
      // rendered in the DOM and is not destroyed. We may want to revisit
      // this later if the views change during gameplay.
      //if (state.starfieldInstance) {
      //  console.log("[STARFIELD RENDER] Unmounting Starfield instance");
      //  state.starfieldInstance.destroy();
      //  state.setStarfieldInstance(undefined);
      //}
    };
  }, [playSound, ready, settings.renderStarfield, starfieldInstance]);*/

  return (
    <div id="starfield-container" className="relative">
      <div id="whiteFlash"></div>
      <div id="vignette"></div>
      <div id="starfield"></div>
    </div>
  );
});

StarField.displayName = "StarField";

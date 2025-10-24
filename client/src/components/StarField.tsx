import useGameStore from "@stores/game";
import { memo, useEffect } from "react";

import type { StarfieldSceneConfig } from "@/fx/starfield/constants";
import { usePlaySound } from "@/hooks/usePlaySound";

export const StarField = memo(() => {
  const playSound = usePlaySound();
  const ready = useGameStore.use.gameState() === "ready";
  const settings = useGameStore.use.settings();
  const starfieldInstance = useGameStore.use.starfieldInstance?.();

  /*
   * Play start sound FX on ready
   */
  useEffect(() => {
    if (ready) {
      playSound("start");
    }
  }, [playSound, ready]);

  /*
   * Re-initialize starfield on settings change
   */
  useEffect(() => {
    // Only run when settings change
    if (!ready || !settings.renderStarfield || !starfieldInstance) {
      return;
    }

    console.debug("[STARFIELD] Re-initializing starfield");

    const state = useGameStore.getState();
    starfieldInstance.initializeScene({
      id: state.sector?.id.toString() ?? undefined,
      sceneConfig: state.sector?.scene_config as StarfieldSceneConfig,
    });
  }, [ready, settings.renderStarfield, starfieldInstance]);

  /*
   * Create starfield instance on initial render
   */
  useEffect(() => {
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
  }, [playSound, ready, settings.renderStarfield, starfieldInstance]);

  return (
    <div id="starfield-container" className="relative">
      <div id="whiteFlash"></div>
      <canvas id="warpOverlay"></canvas>
      <div id="vignette"></div>
      <div id="transition" className={ready ? "open" : ""}></div>
      <div id="starfield"></div>
    </div>
  );
});

StarField.displayName = "StarField";

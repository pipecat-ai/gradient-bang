import useGameStore from "@stores/game";
import { memo, useEffect, useRef } from "react";

import type { StarfieldSceneConfig } from "@/fx/starfield/constants";
import { GalaxyStarfield } from "@/fx/starfield/main";
//import { usePlaySound } from "@/hooks/usePlaySound";

export const StarField = memo(() => {
  //const playSound = usePlaySound();
  const gameState = useGameStore.use.gameState();
  const settings = useGameStore.use.settings();

  const shouldRenderRef = useRef(settings.renderStarfield);

  /*
   * Initialization
   */
  useEffect(() => {
    if (!settings.renderStarfield) {
      return;
    }

    console.debug("[STARFIELD] Initializing starfield");
    const state = useGameStore.getState();
    // Create new starfield instance
    const instance = new GalaxyStarfield();
    state.setStarfieldInstance(instance);
  }, [settings.renderStarfield]);

  /*
   * Re-initialize starfield on settings change
   */
  useEffect(() => {
    // Only run when settings change
    if (
      gameState !== "ready" ||
      shouldRenderRef.current === settings.renderStarfield
    ) {
      return;
    }

    const handleStarfieldToggle = async () => {
      shouldRenderRef.current = settings.renderStarfield;
      const state = useGameStore.getState();
      let instance = state.starfieldInstance;

      if (settings.renderStarfield) {
        console.debug("[STARFIELD] Re-initializing starfield");

        state.setGameState("initializing");
        if (!instance) {
          console.debug(
            "[STARFIELD] Starfield instance not found, creating new instance"
          );
          instance = new GalaxyStarfield();
          state.setStarfieldInstance(instance);
        }
        await instance.initializeScene({
          id: state.sector?.id.toString() ?? undefined,
          sceneConfig: state.sector?.scene_config as StarfieldSceneConfig,
        });
        state.setGameState("ready");
      } else {
        console.debug("[STARFIELD] Destroying starfield instance");
        instance?.destroy();
        state.setStarfieldInstance(undefined);
      }
    };

    handleStarfieldToggle();
  }, [gameState, settings.renderStarfield]);

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
      <canvas id="warpOverlay"></canvas>
      <div id="vignette"></div>
      <div id="starfield"></div>
    </div>
  );
});

StarField.displayName = "StarField";

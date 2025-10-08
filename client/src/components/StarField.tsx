import { GalaxyStarfield } from "@fx/starfield";
import { memo, useEffect } from "react";
import useGameStore from "../stores/game";

import { usePlaySound } from "../hooks/usePlaySound";

export const StarField = memo(() => {
  const playSound = usePlaySound();

  useEffect(() => {
    const state = useGameStore.getState();
    if (!state.starfieldInstance) {
      console.log("[STARFIELD RENDER] Initializing Starfield instance");
      const targetElement = document.getElementById("starfield") ?? undefined;
      const s = new GalaxyStarfield(
        {},
        {
          onSceneIsLoading: () => {
            console.log("[STARFIELD] 🔄 Scene is loading...");
          },
          onSceneReady: (isInitialRender, sceneId) => {
            console.log(
              "[STARFIELD] ✅ Scene ready!",
              isInitialRender ? "(initial)" : "(warp)",
              `scene: ${sceneId || "unknown"}`
            );
            if (isInitialRender) {
              playSound("start", { volume: 0.5 });
              targetElement?.parentElement?.classList.add("starfield-active");
            }
          },
          onWarpStart: () => {
            console.log("[STARFIELD] 🚀 Warp started");
            playSound("warp", { volume: 0.1 });
          },
          onWarpComplete(queueLength) {
            console.log(
              `[STARFIELD] 🎉 Warp complete - ${queueLength} remaining`
            );
          },
          onGameObjectInView: (gameObject) => {
            console.log("[STARFIELD] Game object in view:", gameObject.name);
          },
        },
        targetElement
      );

      state.setStarfieldInstance(s);
    }

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
  }, [playSound]);

  return (
    <div id="starfield-container" className="relative">
      <div id="whiteFlash"></div>
      <canvas id="warpOverlay"></canvas>
      <div id="vignette"></div>
      <div id="transition"></div>
      <div id="starfield"></div>
    </div>
  );
});

StarField.displayName = "StarField";

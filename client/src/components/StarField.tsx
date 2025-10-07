import { GalaxyStarfield } from "@fx/starfield";
import { memo, useEffect } from "react";
import useGameStore from "../stores/game";

import { usePlaySound } from "../hooks/usePlaySound";

export const StarField = memo(() => {
  const playSound = usePlaySound();

  useEffect(() => {
    const state = useGameStore.getState();
    if (!state.starfieldInstance) {
      console.log("[STARFIELD] Initializing Starfield instance");
      const targetElement = document.getElementById("starfield") ?? undefined;
      const s = new GalaxyStarfield(
        {},
        {
          onSceneIsLoading: () => {
            console.log("[STARFIELD] 🔄 Scene is loading...");
          },
          onSceneReady: () => {
            console.log("[STARFIELD] ✅ Scene ready!");
            targetElement?.parentElement?.classList.add("starfield-active");
            playSound("start", { volume: 0.5 });
          },
          onWarpStart: () => {
            console.log("[STARFIELD] 🚀 Warp started");
            playSound("warp", { volume: 0.1 });
          },
        },
        targetElement
      );

      state.setStarfieldInstance(s);
    }

    return () => {
      if (state.starfieldInstance) {
        console.log("[STARFIELD] Unmounting Starfield instance");
        state.starfieldInstance.destroy();
        state.setStarfieldInstance(undefined);
      }
    };
  }, [playSound]);

  return null;
});

StarField.displayName = "StarField";

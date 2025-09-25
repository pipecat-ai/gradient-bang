import { memo, useEffect } from "react";
import { GalaxyStarfield } from "../starfield/";
import useGameStore from "../stores/game";

import { usePlaySound } from "../hooks/usePlaySound";
import Settings from "../settings.json";

export const Starfield = memo(() => {
  const playSound = usePlaySound();

  useEffect(() => {
    const state = useGameStore.getState();
    if (!state.starfieldInstance) {
      console.log("[STARFIELD] Initializing Starfield instance");
      const targetElement = document.getElementById("starfield") ?? undefined;
      const s = new GalaxyStarfield(
        {
          renderingEnabled: Settings.renderStarfield,
        },
        {
          onSceneReady: () => {
            targetElement?.parentElement?.classList.add("starfield-active");
            playSound("start", { volume: 0.5 });
          },
          onWarpStart: () => {
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

Starfield.displayName = "Starfield";

import useGameStore from "@stores/game";
import { memo, useCallback, useEffect } from "react";

import { SectorTitleBanner } from "@/components/SectorTitleBanner";
import type {
  GalaxyStarfieldEvents,
  GameObjectInstance,
} from "@/fx/starfield/types";
import { usePlaySound } from "@/hooks/usePlaySound";
import Splash from "@assets/images/splash-1.png";

export const StarField = memo(() => {
  const { playSound } = usePlaySound();
  const starfieldInstance = useGameStore.use.starfieldInstance?.();
  const settings = useGameStore.use.settings();

  const onWarpStart = useCallback(
    ({ willPlayAnimation }: GalaxyStarfieldEvents["warpStart"]) => {
      console.log("[STARFIELD] 🚀 Warp started", willPlayAnimation);
      if (willPlayAnimation) {
        playSound("warp");
      }
    },
    [playSound]
  );

  const onGameObjectSelected = useCallback((gameObject: GameObjectInstance) => {
    console.log("[STARFIELD] Game object selected:", gameObject.name);
  }, []);

  const onGameObjectInView = useCallback((gameObject: GameObjectInstance) => {
    console.log("[STARFIELD] Game object in view:", gameObject.name);
  }, []);

  const onGameObjectCleared = useCallback(() => {
    console.log("[STARFIELD] Game object cleared");
  }, []);

  const onPerformanceModeChanged = useCallback(
    ({ active }: { active: boolean }) => {
      console.log("[STARFIELD] Performance mode changed:", active);
    },
    []
  );

  /*
   * Initialize or re-initialize starfield
   */
  useEffect(() => {
    if (!settings.renderStarfield || !starfieldInstance) {
      return;
    }

    console.debug("[STARFIELD] Subscribing to starfield events");

    starfieldInstance.on("warpStart", onWarpStart);
    starfieldInstance.on("gameObjectSelected", onGameObjectSelected);
    starfieldInstance.on("gameObjectInView", onGameObjectInView);
    starfieldInstance.on("gameObjectCleared", onGameObjectCleared);
    starfieldInstance.on("performanceModeChanged", onPerformanceModeChanged);
    return () => {
      console.debug("[STARFIELD] Unsubscribing from starfield events");
      starfieldInstance.off("warpStart", onWarpStart);
      starfieldInstance.off("gameObjectSelected", onGameObjectSelected);
      starfieldInstance.off("gameObjectInView", onGameObjectInView);
      starfieldInstance.off("gameObjectCleared", onGameObjectCleared);
      starfieldInstance.off("performanceModeChanged", onPerformanceModeChanged);
    };
  }, [
    onWarpStart,
    onGameObjectSelected,
    onGameObjectInView,
    onGameObjectCleared,
    onPerformanceModeChanged,
    starfieldInstance,
    settings.renderStarfield,
  ]);

  return (
    <div
      id="starfield-container"
      className={"relative user-select-none pointer-events-none"}
      tabIndex={-1}
    >
      {!settings.renderStarfield && (
        <img
          src={Splash}
          alt="Splash"
          className="absolute inset-0 w-full h-full object-contain z-1 pointer-events-none object-bottom"
        />
      )}
      <SectorTitleBanner />
      <div id="whiteFlash"></div>
      <div id="vignette"></div>
      <div id="starfield"></div>
    </div>
  );
});

StarField.displayName = "StarField";

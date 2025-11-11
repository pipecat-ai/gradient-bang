import useGameStore from "@stores/game";
import { memo, useEffect } from "react";

import type { StarfieldSceneConfig } from "@/fx/starfield/constants";
import type {
  GalaxyStarfieldEvents,
  GameObjectInstance,
} from "@/fx/starfield/types";
import { usePlaySound } from "@/hooks/usePlaySound";

export const StarField = memo(() => {
  const { playSound } = usePlaySound();
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

    console.debug("[STARFIELD] Subscribing to starfield events");

    const handleSceneLoading = () => {
      console.log("[STARFIELD] 🔄 Scene is loading...");
    };

    const handleSceneReady = ({
      isInitialRender,
      sceneId,
    }: GalaxyStarfieldEvents["sceneReady"]) => {
      console.log(
        "[STARFIELD] ✅ Scene ready!",
        isInitialRender ? "(initial)" : "(warp)",
        `scene: ${sceneId || "unknown"}`
      );
    };

    const handleWarpStart = () => {
      console.log("[STARFIELD] 🚀 Warp started");
      playSound("warp");
    };

    const handleWarpComplete = (queueLength: number) => {
      console.log(`[STARFIELD] 🎉 Warp complete - ${queueLength} remaining`);
      if (queueLength === 0) {
        // state.setAutopilot(false);
      }
    };

    const handleWarpQueue = (queueLength: number) => {
      console.log(`[STARFIELD] Queue updated: ${queueLength}`);
      // state.setAutopilot(true);
    };

    const handleGameObjectInView = (gameObject: GameObjectInstance) => {
      console.log("[STARFIELD] Game object in view:", gameObject.name);
    };

    const handleGameObjectSelected = (gameObject: GameObjectInstance) => {
      console.log("[STARFIELD] Game object selected:", gameObject.name);
    };

    const handleGameObjectCleared = () => {
      console.log("[STARFIELD] Game object cleared");
    };

    starfieldInstance.on("sceneIsLoading", handleSceneLoading);
    starfieldInstance.on("sceneReady", handleSceneReady);
    starfieldInstance.on("warpStart", handleWarpStart);
    starfieldInstance.on("warpComplete", handleWarpComplete);
    starfieldInstance.on("warpQueue", handleWarpQueue);
    starfieldInstance.on("gameObjectInView", handleGameObjectInView);
    starfieldInstance.on("gameObjectSelected", handleGameObjectSelected);
    starfieldInstance.on("gameObjectCleared", handleGameObjectCleared);

    return () => {
      console.debug("[STARFIELD] Unsubscribing from starfield events");
      starfieldInstance.off("sceneIsLoading", handleSceneLoading);
      starfieldInstance.off("sceneReady", handleSceneReady);
      starfieldInstance.off("warpStart", handleWarpStart);
      starfieldInstance.off("warpComplete", handleWarpComplete);
      starfieldInstance.off("warpQueue", handleWarpQueue);
      starfieldInstance.off("gameObjectInView", handleGameObjectInView);
      starfieldInstance.off("gameObjectSelected", handleGameObjectSelected);
      starfieldInstance.off("gameObjectCleared", handleGameObjectCleared);
    };
  }, [playSound, ready, settings.renderStarfield, starfieldInstance]);

  return (
    <div id="starfield-container" className="relative">
      <div id="whiteFlash"></div>
      <div id="vignette"></div>
      <div id="transition" className={ready ? "open" : ""}></div>
      <div id="starfield"></div>
    </div>
  );
});

StarField.displayName = "StarField";

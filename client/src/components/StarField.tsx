import { useEffect } from "react";
import { GalaxyStarfield } from "../starfield/";
import useGameStore from "../stores/game";

import Settings from "../settings.json";

export const Starfield = () => {
  const { setStarfieldInstance } = useGameStore();
  const starfieldInstance = useGameStore.use.starfieldInstance();

  useEffect(() => {
    if (starfieldInstance) {
      return;
    }

    console.log("[STARFIELD] Initializing GalaxyStarfield instance");

    const s = new GalaxyStarfield({
      renderingEnabled: Settings.renderStarfield,
    });

    setStarfieldInstance(s);
  }, [setStarfieldInstance, starfieldInstance]);
  return null;
};

export default Starfield;

import { useEffect } from "react";
import { GalaxyStarfield } from "../starfield/";
import useGameStore from "../stores/game";

import Settings from "../settings.json";

export const Starfield = () => {
  const { setStarfieldInstance } = useGameStore();

  useEffect(() => {
    console.log("[STARFIELD] Initializing GalaxyStarfield instance");

    const starfieldInstance = new GalaxyStarfield({
      renderingEnabled: Settings.renderStarfield,
    });

    setStarfieldInstance(starfieldInstance);
  }, [setStarfieldInstance]);
  return null;
};

export default Starfield;

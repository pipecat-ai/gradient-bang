import { memo, useEffect, useRef } from "react";
import { GalaxyStarfield } from "../starfield/Starfield";
import type { GameObjectInstance } from "../starfield/types/GameObject";
import useSectorStore from "../stores/sector";
import useStarfieldStore from "../stores/starfield";

export const StarField = memo(() => {
  const starfieldRef = useRef<GalaxyStarfield | null>(null);
  const { setInstance, getInstance } = useStarfieldStore();
  const { sector, sector_contents } = useSectorStore();

  useEffect(() => {
    if (sector !== undefined) {
      console.log("Warp to sector:", sector, sector_contents);
      getInstance()?.warpToSector({
        id: sector.toString(),
        gameObjects: sector_contents.port
          ? [
              {
                id: sector.toString(),
                type: "port",
                name: sector_contents.port.code,
              },
            ]
          : [],
      });
    }
  }, [sector, getInstance, sector_contents]);

  useEffect(() => {
    if (!getInstance()) {
      console.log("GalaxyStarfield instantiated");

      const galaxyStarfieldInstance = new GalaxyStarfield(
        {},
        {
          onGameObjectInView: (gameObject: GameObjectInstance) => {
            console.log("Game object in view:", gameObject);
          },
          onGameObjectSelected: (gameObject: GameObjectInstance) => {
            console.log("Game object selected:", gameObject);
          },
          onGameObjectCleared: () => {
            console.log("Game object selection cleared");
          },
          onSceneReady: () => {},
        }
      );

      starfieldRef.current = galaxyStarfieldInstance;
      setInstance(galaxyStarfieldInstance);
    }

    return () => {
      starfieldRef.current = null;
    };
  }, [setInstance, getInstance]);

  return (
    <div className="z-0 absolute inset-0">
      <div id="whiteFlash"></div>
      <canvas id="warpOverlay"></canvas>
      <div id="vignette"></div>
    </div>
  );
});

StarField.displayName = "StarField";

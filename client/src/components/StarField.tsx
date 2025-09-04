import { memo, useEffect, useRef } from "react";
import { usePlaySound } from "../hooks/usePlaySound";
import { GalaxyStarfield } from "../starfield/Starfield";
import type { GameObjectInstance } from "../starfield/types/GameObject";
import useSectorStore from "../stores/sector";
import useStarfieldStore from "../stores/starfield";

import scenes from "../scenes.json";
import type { GalaxyStarfieldConfig } from "../starfield/constants";
import useTaskStore from "../stores/tasks";

const DEFAULT_SCENE = scenes.scenes[0];

export const StarField = memo(() => {
  const starfieldRef = useRef<GalaxyStarfield | null>(null);
  const { setInstance, getInstance } = useStarfieldStore();
  const { sector, getSectorContents } = useSectorStore();
  const { active } = useTaskStore();

  const playSound = usePlaySound();

  useEffect(() => {
    console.log("Sector:", sector);
    if (sector !== undefined) {
      const sector_contents = getSectorContents();

      const config =
        sector === 0
          ? ({ ...DEFAULT_SCENE } as Partial<GalaxyStarfieldConfig>)
          : {};

      getInstance()?.warpToSector(
        {
          id: sector.toString(),
          config,
          gameObjects: sector_contents.port
            ? [
                {
                  id: sector.toString(),
                  type: "port",
                  name: sector_contents.port.code,
                },
              ]
            : [],
        },
        active
      );
    }
  }, [sector, getInstance, getSectorContents, active]);

  useEffect(() => {
    getInstance()?.clearGameObjectSelection();
    if (active) {
      getInstance()?.startShake();
    } else {
      getInstance()?.setIdle();
    }
  }, [active, getInstance]);

  useEffect(() => {
    if (!getInstance()) {
      console.log("GalaxyStarfield instantiated", DEFAULT_SCENE);

      const targetElement = document.getElementById("starfield") ?? undefined;

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

      starfieldRef.current = galaxyStarfieldInstance;
      setInstance(galaxyStarfieldInstance);
      window.starfield = galaxyStarfieldInstance;
    }

    return () => {
      starfieldRef.current = null;
    };
  }, [setInstance, getInstance, playSound]);

  return null;
});

StarField.displayName = "StarField";

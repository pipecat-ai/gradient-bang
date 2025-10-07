import { StarField } from "@/components/StarField";
import useGameStore from "@/stores/game";
import type { Story } from "@ladle/react";
import { useEffect, useState } from "react";

import "@/css/starfield-ui.css";
import "@/css/starfield.css";

export const Starfield: Story = () => {
  const [start, setStart] = useState(false);
  const starfieldInstance = useGameStore((state) => state.starfieldInstance);

  useEffect(() => {
    if (!starfieldInstance) {
      return;
    }

    console.log("[STARFIELD] Starfield instance", starfieldInstance);

    // initializeScene is now async - waits for scene to be ready before starting render loop
    starfieldInstance.initializeScene();
  }, [starfieldInstance]);

  return (
    <>
      <div className="fixed z-99 w-full flex flex-row gap-2">
        <button onClick={() => setStart(true)}>Start</button>

        <button
          onClick={async () => {
            await starfieldInstance?.warpToSector({
              id: Math.floor(Math.random() * 10000).toString(),
              sceneConfig: {},
            });
            console.log("[WARP COMPLETE]");
          }}
        >
          Change Scene
        </button>

        <button onClick={() => starfieldInstance?.startShake()}>Shake</button>
        <button
          onClick={async () => {
            const gameObjects = starfieldInstance?.getAllGameObjects();
            console.log("All game objects:", gameObjects);

            if (gameObjects && gameObjects.length > 0) {
              // Select the first game object (this triggers dimming and starts look-at animation)
              const firstObject = gameObjects[0];
              console.log(
                "Selecting game object:",
                firstObject.name,
                firstObject.id
              );
              const success = starfieldInstance?.selectGameObject(
                firstObject.id,
                {
                  zoom: true,
                  zoomFactor: 0.5,
                }
              );
              console.log("Selection and look-at animation started:", success);
            } else {
              console.log("No game objects found");
            }
          }}
        >
          Select First GO
        </button>

        <button
          onClick={() => {
            const cleared = starfieldInstance?.clearGameObjectSelection();
            console.log("Clear selection result:", cleared);
          }}
        >
          Clear Selection
        </button>
      </div>
      {start && <StarField />}
    </>
  );
};

Starfield.meta = {
  connectOnMount: false,
  enableMic: false,
  disableAudioOutput: true,
  disconnectedStory: true,
};

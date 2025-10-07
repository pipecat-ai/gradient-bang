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

        <button onClick={() => starfieldInstance?.setAnimationState("shake")}>
          Shake
        </button>
      </div>
      <div id="starfield-container" className="relative">
        <div id="whiteFlash"></div>
        <canvas id="warpOverlay"></canvas>
        <div id="vignette"></div>
        <div id="transition"></div>
        <div id="starfield"></div>
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

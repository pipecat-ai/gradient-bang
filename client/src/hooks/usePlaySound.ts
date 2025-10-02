import useGameStore from "@stores/game";
import { useCallback } from "react";

export type Sound = "warp" | "start" | "ambience";

const SoundMap = {
  warp: "/sounds/warp.wav",
  start: "/sounds/start.wav",
  ambience: "/sounds/ambience.wav",
};

export const usePlaySound = () => {
  const { disabledSounds } = useGameStore.use.settings();

  return useCallback(
    (sound: Sound, options?: { volume?: number; loop?: boolean }) => {
      // If sounds are disabled, don't play anything
      if (disabledSounds) return;

      const audio = new Audio(SoundMap[sound]);
      audio.currentTime = 0;

      // Set volume if provided, otherwise use default
      audio.volume = options?.volume ?? 1.0;

      // Set loop if provided
      if (options?.loop) {
        audio.loop = true;
      }

      // Handle play promise to avoid console warnings
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((error) => {
          console.warn(`Failed to play sound ${sound}:`, error);
        });
      }
    },
    [disabledSounds]
  );
};

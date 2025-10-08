import useGameStore from "@stores/game";
import { useCallback, useEffect } from "react";

export type Sound = {
  src: string;
  type: SoundType;
};

type SoundType = "fx" | "ambience" | "music";

const SoundMap: Record<string, Sound> = {
  warp: { src: "/sounds/warp.wav", type: "fx" },
  start: { src: "/sounds/start.wav", type: "fx" },
  ambience: { src: "/sounds/ambience.wav", type: "ambience" },
};

type OnceSoundEntry = {
  audio: HTMLAudioElement;
  baseVolume: number;
  soundType: SoundType;
  suspended: boolean;
};

// Persist across hot module reloads using a global singleton
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _g = globalThis as any;
_g.__gb_activeOnceSounds =
  _g.__gb_activeOnceSounds || new Map<string, OnceSoundEntry>();
const activeOnceSounds = _g.__gb_activeOnceSounds as Map<
  string,
  OnceSoundEntry
>;

export const usePlaySound = () => {
  const settings = useGameStore.use.settings();
  const {
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  } = settings;

  useEffect(() => {
    activeOnceSounds.forEach((entry) => {
      const { audio, baseVolume, soundType } = entry;

      let finalVolume = baseVolume;
      if (soundType === "ambience") {
        finalVolume = baseVolume * ambienceVolume;
      } else if (soundType === "fx") {
        finalVolume = baseVolume * soundFXVolume;
      } else if (soundType === "music") {
        finalVolume = baseVolume * musicVolume;
      }
      audio.volume = finalVolume;

      const disabled =
        (soundType === "ambience" && disabledAmbience) ||
        (soundType === "fx" && disabledSoundFX) ||
        (soundType === "music" && disableMusic);

      if (disabled) {
        if (!audio.paused) {
          audio.pause();
        }
        entry.suspended = true;
      } else {
        if (audio.paused && entry.suspended) {
          const p = audio.play();
          if (p) {
            p.catch(() => {
              // ignore play errors, e.g. autoplay restrictions
              // @TODO: handle this
            });
          }
          entry.suspended = false;
        }
      }
    });
  }, [
    ambienceVolume,
    soundFXVolume,
    musicVolume,
    disabledAmbience,
    disabledSoundFX,
    disableMusic,
  ]);

  return useCallback(
    (
      soundName: string,
      options?: { volume?: number; loop?: boolean; once?: boolean }
    ) => {
      if (options?.once && activeOnceSounds.has(soundName)) {
        return;
      }

      const sound = SoundMap[soundName as keyof typeof SoundMap];
      if (!sound) return;

      const isDisabled =
        (sound.type === "ambience" && disabledAmbience) ||
        (sound.type === "fx" && disabledSoundFX) ||
        (sound.type === "music" && disableMusic);

      if (!options?.once && isDisabled) {
        return;
      }

      const audio = new Audio(sound.src);
      audio.currentTime = 0;

      const baseVolume = options?.volume ?? 1;
      let finalVolume = baseVolume;
      if (sound.type === "ambience") {
        finalVolume = baseVolume * ambienceVolume;
      } else if (sound.type === "fx") {
        finalVolume = baseVolume * soundFXVolume;
      } else if (sound.type === "music") {
        finalVolume = baseVolume * musicVolume;
      }
      audio.volume = finalVolume;

      if (options?.once || options?.loop) {
        audio.loop = true;
      }

      if (options?.once) {
        activeOnceSounds.set(soundName, {
          audio,
          baseVolume,
          soundType: sound.type,
          suspended: isDisabled,
        });
      }

      if (!isDisabled) {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.warn(`Failed to play sound ${soundName}:`, error);
          });
        }
      }
    },
    [
      ambienceVolume,
      soundFXVolume,
      musicVolume,
      disabledAmbience,
      disabledSoundFX,
      disableMusic,
    ]
  );
};
